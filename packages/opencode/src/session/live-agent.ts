// Bridges live-gateway digests into the V1 session runtime: each digest becomes a synthetic
// prompt on the bound live session, the same injection path background subagent results use
// (see TaskTool.injectBackgroundResult). This is the only live-agent piece coupled to the V1
// session core; the gateway, triggers, and telemetry schema are generation-agnostic.
//
// It also rehydrates live sessions on boot: the gateway's directory→session binding and its
// watchers live only in process memory, so a server restart orphans every persisted metadata.live
// session (status reports connected:false/buffered:0 and inject.js 404s until the user re-runs "Go
// Live"). Rebinding the most recent live session per directory restores the binding, re-arms any
// configured watch/CDP capture, and lets inject.js serve again so a reloading page reconnects.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LiveGateway } from "@opencode-ai/core/live"
import { Config } from "@/config/config"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceStore } from "@/project/instance-store"
import { LiveCdp } from "@/session/live-cdp"
import { LiveWatch } from "@/session/live-watch"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { Context, Effect, Layer, Stream } from "effect"

export class Service extends Context.Service<Service, {}>()("@opencode/LiveAgent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const gateway = yield* LiveGateway.Service
    const store = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const prompts = yield* SessionPrompt.Service
    const config = yield* Config.Service
    const liveWatch = yield* LiveWatch.Service
    const liveCdp = yield* LiveCdp.Service

    // Mirrors LiveHttpApi.ensureWatch, but resolved through InstanceRef (provided by store.provide)
    // rather than request-scoped instance state. The gateway normalizes the directory key itself.
    const ensureWatch = Effect.fn("LiveAgent.ensureWatch")(function* (directory: string) {
      const cfg = yield* config.get()
      yield* gateway.setFieldsMode(directory, cfg.live?.fields)
      if (cfg.live?.triggers) yield* gateway.configure(directory, cfg.live.triggers)
      if (cfg.live?.watch) yield* liveWatch.ensure(directory, cfg.live.watch)
      if (cfg.live?.cdp) yield* liveCdp.ensure(directory, cfg.live.cdp)
    })

    const rebind = (session: Session.GlobalInfo) =>
      store.provide(
        { directory: session.directory },
        Effect.gen(function* () {
          yield* gateway.bind(session.directory, session.id)
          yield* ensureWatch(session.directory)
        }),
      )

    // Note: armed live_wait conditions are intentionally not persisted or rehydrated — a restart
    // drops them, and the agent re-arms on its next wake or user message if still relevant.
    const rehydrate = Effect.fn("LiveAgent.rehydrate")(function* () {
      const all = yield* sessions.listGlobal({ roots: true, limit: 1_000 })
      // listGlobal is ordered newest-first, so the first live session seen for a directory is the
      // one to rebind; older live sessions in the same directory are stale.
      const byDirectory = new Map<string, Session.GlobalInfo>()
      all.forEach((session) => {
        if (session.metadata?.live && !byDirectory.has(session.directory)) byDirectory.set(session.directory, session)
      })
      yield* Effect.forEach(
        byDirectory.values(),
        (session) =>
          rebind(session).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("live rehydrate failed", { directory: session.directory, cause }),
            ),
          ),
        { discard: true, concurrency: 4 },
      )
    })

    // Shared by the digest and wake streams: both carry {directory, sessionID, text} and inject
    // the text as a synthetic prompt on the bound session.
    const inject = Effect.fn("LiveAgent.inject")(function* (input: {
      directory: string
      sessionID: string
      text: string
    }) {
      const ctx = yield* store.load({ directory: input.directory })
      const sessionID = SessionID.make(input.sessionID)
      const session = yield* sessions.get(sessionID).pipe(Effect.provideService(InstanceRef, ctx))
      yield* prompts
        .prompt({
          sessionID,
          agent: session.agent ?? "live",
          parts: [{ type: "text", synthetic: true, text: input.text }],
        })
        .pipe(Effect.provideService(InstanceRef, ctx))
    })

    yield* gateway
      .digests()
      .pipe(
        Stream.runForEach((digest) =>
          inject(digest).pipe(
            Effect.catchCause((cause) => Effect.logError("live digest injection failed", { cause })),
            Effect.forkScoped,
          ),
        ),
        Effect.forkScoped,
      )

    yield* gateway
      .wakes()
      .pipe(
        Stream.runForEach((wake) =>
          inject(wake).pipe(
            Effect.catchCause((cause) => Effect.logError("live wake injection failed", { cause })),
            Effect.forkScoped,
          ),
        ),
        Effect.forkScoped,
      )

    // Booting instances for each live directory is I/O-heavy, so run it off the layer-build path.
    yield* rehydrate().pipe(
      Effect.catchCause((cause) => Effect.logError("live rehydrate failed", { cause })),
      Effect.forkScoped,
    )

    return Service.of({})
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    LiveGateway.node,
    InstanceStore.node,
    Session.node,
    SessionPrompt.node,
    Config.node,
    LiveWatch.node,
    LiveCdp.node,
  ],
})

export * as LiveAgent from "./live-agent"
