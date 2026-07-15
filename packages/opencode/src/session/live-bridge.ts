// Request/response layer over the (otherwise one-way) live capture backends. Both the injected
// snippet connection and the CDP attachment register a "responder" per connected browser tab; the
// browser_read tool calls snapshot() and this routes to the right responder, applies a timeout, and
// returns the extracted page content. Kept in packages/opencode (not core) because the responders
// close over server-side socket handles the generation-agnostic gateway deliberately does not hold.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Live } from "@opencode-ai/schema/live"
import { Context, Effect, Layer, Schema } from "effect"

const SNAPSHOT_TIMEOUT = "5 seconds"

function normalizeDirectory(directory: string) {
  return directory.length > 1 ? directory.replace(/\/+$/, "") : directory
}

export class BridgeError extends Schema.TaggedErrorClass<BridgeError>()("LiveBridgeError", {
  reason: Schema.Literals(["no_connection", "timeout", "failed"]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export type Responder = {
  // Capture-scoped tab id (matches the `tab` on this connection's telemetry). Undefined until a tab
  // announces itself; such a responder is still reachable as the most-recent connection.
  tab?: string
  readonly source: Live.Source
  readonly respond: (request: Live.SnapshotRequest) => Effect.Effect<Live.SnapshotResult, BridgeError>
}

export interface Interface {
  // Registers a responder for a directory; returns a release that deregisters it. Callers scope the
  // release to the connection's lifetime (socket close / CDP detach).
  readonly register: (directory: string, responder: Responder) => Effect.Effect<{ readonly release: Effect.Effect<void> }>
  readonly snapshot: (
    directory: string,
    request: Live.SnapshotRequest,
  ) => Effect.Effect<Live.SnapshotResult, BridgeError>
  readonly connected: (directory: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LiveBridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Insertion-ordered, so the last entry for a directory is the most-recently-connected tab.
    const responders = new Map<string, Responder[]>()

    const listFor = (directory: string) => responders.get(normalizeDirectory(directory)) ?? []

    const select = (directory: string, request: Live.SnapshotRequest) => {
      const list = listFor(directory)
      if (list.length === 0) return undefined
      if (request.tab) return list.find((responder) => responder.tab === request.tab)
      return list[list.length - 1]
    }

    return Service.of({
      register: Effect.fn("LiveBridge.register")(function* (directory, responder) {
        const key = normalizeDirectory(directory)
        const list = responders.get(key) ?? []
        list.push(responder)
        responders.set(key, list)
        return {
          release: Effect.sync(() => {
            const current = responders.get(key)
            if (!current) return
            const next = current.filter((entry) => entry !== responder)
            if (next.length === 0) responders.delete(key)
            else responders.set(key, next)
          }),
        }
      }),
      snapshot: (directory, request) =>
        Effect.gen(function* () {
          const responder = select(directory, request)
          if (!responder)
            return yield* new BridgeError({
              reason: "no_connection",
              detail: request.tab
                ? `No connected browser tab "${request.tab}" for this live session.`
                : "No connected browser for this live session.",
            })
          return yield* responder.respond(request).pipe(
            Effect.timeout(SNAPSHOT_TIMEOUT),
            Effect.catchTag("TimeoutError", () =>
              new BridgeError({ reason: "timeout", detail: "The browser did not respond to the page read in time." }),
            ),
          )
        }),
      connected: Effect.fn("LiveBridge.connected")(function* (directory) {
        return listFor(directory).length > 0
      }),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as LiveBridge from "./live-bridge"
