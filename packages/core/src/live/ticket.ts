export * as LiveTicket from "./ticket"

import { Cache, Context, Duration, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"

// Live capture tickets authorize a browser page (an arbitrary origin, the user's own app under
// development) to stream telemetry for one directory. Unlike PtyTicket there is no Origin
// allowlist to check against, so possession of the ticket is the whole credential; the TTL is
// long enough to cover a dev session without re-injecting the script.
const DEFAULT_TTL = Duration.hours(12)
const CAPACITY = 10_000

export interface Interface {
  issue(directory: string): Effect.Effect<string>
  consume(ticket: string): Effect.Effect<string | undefined>
  revoke(directory: string): Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LiveTicket") {}

const noLookup = () => Effect.die("LiveTicket cache must be used via set/get, never lookup")

export const make = (ttl: Duration.Input = DEFAULT_TTL) =>
  Effect.gen(function* () {
    const cache = yield* Cache.make<string, string>({ capacity: CAPACITY, lookup: noLookup, timeToLive: ttl })
    // Tracks live tickets per directory so stopping a live session can revoke them all. Entries
    // that expire from the cache first are simply no-ops at revocation time.
    const issued = new Map<string, Set<string>>()
    return Service.of({
      issue: Effect.fn("LiveTicket.issue")(function* (directory) {
        const ticket = crypto.randomUUID()
        yield* Cache.set(cache, ticket, directory)
        const tickets = issued.get(directory) ?? new Set()
        tickets.add(ticket)
        issued.set(directory, tickets)
        return ticket
      }),
      // Tickets stay valid for their TTL so the page can reconnect after transient drops.
      consume: Effect.fn("LiveTicket.consume")(function* (ticket) {
        const directory = yield* Cache.getOption(cache, ticket)
        return directory._tag === "Some" ? directory.value : undefined
      }),
      revoke: Effect.fn("LiveTicket.revoke")(function* (directory) {
        const tickets = issued.get(directory)
        if (!tickets) return
        issued.delete(directory)
        yield* Effect.forEach(tickets, (ticket) => Cache.invalidate(cache, ticket), { discard: true })
      }),
    })
  })

const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
