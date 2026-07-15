// Captures the user's dev-server output for the live agent. Two modes, both feeding the live
// gateway's per-directory log buffer: spawn a configured command and stream its stdio, or tail
// an existing log file. Started lazily the first time a live session begins for a directory.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LiveGateway } from "@opencode-ai/core/live"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import fs from "fs/promises"
import path from "path"

export type WatchConfig = {
  readonly command?: string
  readonly logFile?: string
  readonly cwd?: string
}

export interface Interface {
  readonly ensure: (directory: string, watch: WatchConfig) => Effect.Effect<void>
  readonly stop: (directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LiveWatch") {}

function splitter(onLine: (line: string) => void) {
  let remainder = ""
  return (chunk: string) => {
    const parts = (remainder + chunk).split("\n")
    remainder = parts.pop() ?? ""
    parts.filter((line) => line.length > 0).forEach(onLine)
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const gateway = yield* LiveGateway.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const active = new Map<string, { stop: () => void }>()

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const watcher of active.values()) watcher.stop()
        active.clear()
      }),
    )

    const append = (directory: string, stream: "stdout" | "stderr") =>
      splitter((line) => {
        runFork(gateway.appendLog(directory, [{ ts: Date.now(), stream, line }]))
      })

    const spawnCommand = (directory: string, watch: WatchConfig) => {
      // Resolve cwd against the project directory: a relative `cwd` in config (e.g. "./frontend")
      // must not be resolved against the server process cwd, which is unrelated to the project.
      const cwd = watch.cwd
        ? path.isAbsolute(watch.cwd)
          ? watch.cwd
          : path.join(directory, watch.cwd)
        : directory
      // A dev-server that fails to launch (bad cwd, missing shell/command on PATH) must not fail
      // the go-live request that started this watcher — the watcher is best-effort log capture, so
      // a spawn failure is logged and swallowed rather than dying up through `LiveHttpApi.start`.
      return Effect.try({
        try: () => {
          const child = Bun.spawn(["sh", "-c", watch.command ?? ""], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
            onExit: () => {
              active.delete(directory)
            },
          })
          const decoder = new TextDecoder()
          const pump = (readable: ReadableStream<Uint8Array>, stream: "stdout" | "stderr") => {
            const push = append(directory, stream)
            const reader = readable.getReader()
            const loop = (): Promise<void> =>
              reader.read().then((result) => {
                if (result.done) return
                push(decoder.decode(result.value))
                return loop()
              })
            void loop().catch(() => {})
          }
          pump(child.stdout, "stdout")
          pump(child.stderr, "stderr")
          active.set(directory, { stop: () => child.kill() })
        },
        catch: (error) => error,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("live watch command failed to start", { directory, command: watch.command, cwd, cause }),
        ),
      )
    }

    const tailFile = Effect.fn("LiveWatch.tailFile")(function* (directory: string, watch: WatchConfig) {
      const file = path.isAbsolute(watch.logFile ?? "") ? watch.logFile! : path.join(directory, watch.logFile ?? "")
      const initial = yield* Effect.promise(() =>
        fs
          .stat(file)
          .then((info) => info.size)
          .catch(() => 0),
      )
      const state = { offset: initial }
      const push = append(directory, "stdout")
      const poll = Effect.promise(async () => {
        const size = await fs
          .stat(file)
          .then((info) => info.size)
          .catch(() => undefined)
        if (size === undefined) return
        if (size < state.offset) state.offset = 0
        if (size === state.offset) return
        const handle = await fs.open(file, "r")
        const buffer = Buffer.alloc(size - state.offset)
        await handle.read(buffer, 0, buffer.length, state.offset)
        await handle.close()
        state.offset = size
        push(buffer.toString("utf8"))
      })
      const fiber = runFork(poll.pipe(Effect.repeat(Schedule.spaced(Duration.millis(500)))))
      active.set(directory, { stop: () => fiber.interruptUnsafe() })
    })

    return Service.of({
      ensure: Effect.fn("LiveWatch.ensure")(function* (directory, watch) {
        if (active.has(directory)) return
        if (watch.command) return yield* spawnCommand(directory, watch)
        if (watch.logFile) return yield* tailFile(directory, watch)
      }),
      stop: Effect.fn("LiveWatch.stop")(function* (directory) {
        const watcher = active.get(directory)
        if (!watcher) return
        active.delete(directory)
        watcher.stop()
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [LiveGateway.node] })

export * as LiveWatch from "./live-watch"
