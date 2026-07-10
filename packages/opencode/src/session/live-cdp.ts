// Chrome DevTools Protocol capture backend for live sessions. Attaches to a browser started
// with --remote-debugging-port, watches every page target whose URL matches the configured
// filter, and normalizes console/exception/network/navigation events into the same telemetry
// the injected script produces (source: "cdp"). No page-code injection required, but only
// works against Chromium browsers.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LiveGateway } from "@opencode-ai/core/live"
import { Live } from "@opencode-ai/schema/live"
import { Context, Duration, Effect, Layer, Schedule } from "effect"

export type CdpConfig = {
  readonly endpoint?: string
  readonly filter?: string
}

const DEFAULT_ENDPOINT = "http://localhost:9222"
const DEFAULT_FILTER = "localhost"
const RESCAN_MS = 5_000
const MAX_TEXT = 2_000

export interface Interface {
  readonly ensure: (directory: string, cdp: CdpConfig) => Effect.Effect<void>
  readonly stop: (directory: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LiveCdp") {}

type Target = {
  readonly id: string
  readonly url: string
  readonly webSocketDebuggerUrl?: string
  readonly type: string
}

type CdpMessage = {
  method?: string
  params?: Record<string, unknown>
}

type StackFrame = { url?: string; lineNumber?: number; columnNumber?: number; functionName?: string }

function renderRemoteObject(arg: { value?: unknown; description?: string; type?: string }) {
  if (typeof arg.value === "string") return arg.value
  if (arg.value !== undefined) return JSON.stringify(arg.value)
  return arg.description ?? arg.type ?? ""
}

function renderStack(frames: StackFrame[] | undefined) {
  if (!frames || frames.length === 0) return undefined
  return frames
    .map((frame) => `    at ${frame.functionName || "<anonymous>"} (${frame.url}:${frame.lineNumber}:${frame.columnNumber})`)
    .join("\n")
    .slice(0, MAX_TEXT * 2)
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

    const attach = (directory: string, target: Target, sockets: Map<string, WebSocket>) => {
      if (!target.webSocketDebuggerUrl) return
      const tab = target.id.slice(0, 6).toLowerCase()
      const state = {
        url: target.url,
        commandID: 0,
        requests: new Map<string, { method: string; url: string; start: number }>(),
        // Filled once gateway.connect resolves; run on socket close to drop the connection count.
        disconnect: undefined as Effect.Effect<void> | undefined,
      }
      const socket = new WebSocket(target.webSocketDebuggerUrl)
      sockets.set(target.id, socket)

      const push = (event: Live.Telemetry) =>
        runFork(gateway.ingest(directory, { source: "cdp", events: [event] }))
      const send = (method: string) => {
        state.commandID += 1
        socket.send(JSON.stringify({ id: state.commandID, method }))
      }

      socket.onopen = () => {
        // Register as a live connection so status reports connected:true — the CDP backend has no
        // WebSocketTracker handshake like the injected snippet's /live/connect, so without this the
        // connection count stays 0 and the UI shows "No browser connected" while telemetry flows.
        runFork(gateway.connect(directory).pipe(Effect.map((connection) => (state.disconnect = connection.disconnect))))
        send("Runtime.enable")
        send("Network.enable")
        send("Page.enable")
        push({ kind: "navigation", ts: Date.now(), url: state.url, tab })
      }
      socket.onclose = () => {
        sockets.delete(target.id)
        if (state.disconnect) runFork(state.disconnect)
      }
      socket.onmessage = (message) => {
        const decoded: CdpMessage = JSON.parse(String(message.data))
        const params = decoded.params ?? {}
        if (decoded.method === "Page.frameNavigated") {
          const frame = params.frame as { url?: string; parentId?: string } | undefined
          if (!frame?.url || frame.parentId) return
          const from = state.url
          state.url = frame.url
          push({ kind: "navigation", ts: Date.now(), url: frame.url, from, tab })
          return
        }
        if (decoded.method === "Runtime.consoleAPICalled") {
          const level = params.type === "error" ? "error" : params.type === "warning" ? "warn" : undefined
          if (!level) return
          const args = (params.args as { value?: unknown; description?: string; type?: string }[] | undefined) ?? []
          const frames = (params.stackTrace as { callFrames?: StackFrame[] } | undefined)?.callFrames
          push({
            kind: "console",
            ts: Date.now(),
            url: state.url,
            level,
            message: args.map(renderRemoteObject).join(" ").slice(0, MAX_TEXT),
            stack: renderStack(frames),
            tab,
          })
          return
        }
        if (decoded.method === "Runtime.exceptionThrown") {
          const details = params.exceptionDetails as
            | { text?: string; exception?: { description?: string }; stackTrace?: { callFrames?: StackFrame[] } }
            | undefined
          const description = details?.exception?.description ?? details?.text ?? "Uncaught error"
          push({
            kind: "error",
            ts: Date.now(),
            url: state.url,
            message: description.split("\n")[0].slice(0, MAX_TEXT),
            stack: renderStack(details?.stackTrace?.callFrames) ?? description.slice(0, MAX_TEXT * 2),
            origin: "uncaught",
            tab,
          })
          return
        }
        if (decoded.method === "Network.requestWillBeSent") {
          const request = params.request as { method?: string; url?: string } | undefined
          const requestId = params.requestId as string | undefined
          if (!requestId || !request?.url) return
          if (state.requests.size > 500) state.requests.clear()
          state.requests.set(requestId, { method: request.method ?? "GET", url: request.url, start: Date.now() })
          return
        }
        if (decoded.method === "Network.responseReceived") {
          const requestId = params.requestId as string | undefined
          const response = params.response as { url?: string; status?: number } | undefined
          if (!requestId || !response?.status) return
          const request = state.requests.get(requestId)
          state.requests.delete(requestId)
          if (response.status < 400) return
          push({
            kind: "network",
            ts: Date.now(),
            url: state.url,
            method: request?.method ?? "GET",
            requestUrl: response.url ?? request?.url ?? "",
            status: response.status,
            durationMs: request ? Date.now() - request.start : undefined,
            tab,
          })
        }
      }
    }

    const ensure = Effect.fn("LiveCdp.ensure")(function* (directory: string, cdp: CdpConfig) {
      if (active.has(directory)) return
      const endpoint = (cdp.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "")
      const filter = cdp.filter ?? DEFAULT_FILTER
      const sockets = new Map<string, WebSocket>()

      const scan = Effect.gen(function* () {
        const targets = yield* Effect.promise(() =>
          fetch(`${endpoint}/json/list`)
            .then((response) => response.json() as Promise<Target[]>)
            .catch(() => [] as Target[]),
        )
        targets
          .filter((target) => target.type === "page" && target.url.includes(filter) && !sockets.has(target.id))
          .forEach((target) => attach(directory, target, sockets))
      })

      const fiber = runFork(scan.pipe(Effect.repeat(Schedule.spaced(Duration.millis(RESCAN_MS)))))
      active.set(directory, {
        stop: () => {
          fiber.interruptUnsafe()
          for (const socket of sockets.values()) socket.close()
          sockets.clear()
        },
      })
      yield* scan
    })

    return Service.of({
      ensure,
      stop: Effect.fn("LiveCdp.stop")(function* (directory) {
        const watcher = active.get(directory)
        if (!watcher) return
        active.delete(directory)
        watcher.stop()
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [LiveGateway.node] })

export * as LiveCdp from "./live-cdp"
