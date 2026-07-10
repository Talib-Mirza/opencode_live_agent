export * as LiveContextSource from "./context-source"

import { makeLocationNode } from "../effect/app-node"
import { Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { LiveGateway } from "../live"
import { SystemContext } from "../system-context/index"
import { SystemContextRegistry } from "../system-context/registry"

// The V2-native live integration: instead of injecting synthetic prompts (the V1 adapter's
// approach), the live-session summary participates as a System Context source, sampled lazily at
// Safe Provider-Turn Boundaries. The source is only present while a live session is bound, so
// sessions in projects that never go live carry no extra prompt text; binding mid-conversation
// surfaces the baseline as a Mid-Conversation System Message, and unbinding renders the removal
// text. Buffered counts are deliberately excluded from the compared value so routine telemetry
// does not churn updates; only connection state and newly seen errors do.
const Summary = Schema.Struct({
  connected: Schema.Boolean,
  recentErrors: Schema.Array(Schema.String),
})
type Summary = typeof Summary.Type

function describe(summary: Summary) {
  return [
    `A live browser-testing session is active for this project (capture ${summary.connected ? "connected" : "disconnected"}).`,
    "The user is exercising the app in a browser right now; the browser_journal and backend_logs tools return the captured telemetry.",
    ...(summary.recentErrors.length ? ["Recent browser errors:", ...summary.recentErrors.map((error) => `- ${error}`)] : []),
  ].join("\n")
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const gateway = yield* LiveGateway.Service
    const directory = location.directory as string

    const summarize: Effect.Effect<Summary> = Effect.gen(function* () {
      const status = yield* gateway.status(directory)
      const errors = yield* gateway.read(directory, { kind: "error", limit: 5 })
      const consoles = yield* gateway.read(directory, { kind: "console", limit: 10 })
      const recentErrors = [...errors.entries, ...consoles.entries]
        .map((entry) => entry.event)
        .filter((event) => event.kind === "error" || (event.kind === "console" && event.level === "error"))
        .sort((a, b) => a.ts - b.ts)
        .slice(-3)
        .map((event) => (event.kind === "error" || event.kind === "console" ? event.message.slice(0, 160) : ""))
      return { connected: status.connected, recentErrors }
    })

    const source = SystemContext.make({
      key: SystemContext.Key.make("live/telemetry"),
      codec: Schema.toCodecJson(Summary),
      load: summarize,
      baseline: describe,
      update: (_previous, current) => describe(current),
      removed: () => "The live browser-testing session for this project has ended.",
    })

    const loadContext = Effect.gen(function* () {
      const status = yield* gateway.status(directory)
      return SystemContext.combine(status.sessionID ? [source] : [])
    })

    yield* registry.register({ key: SystemContext.Key.make("live/summary"), load: loadContext })
  }),
)

export const node = makeLocationNode({
  name: "live-context-source",
  layer,
  deps: [Location.node, SystemContextRegistry.node, LiveGateway.node],
})
