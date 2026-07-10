import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { LiveCdp } from "@/session/live-cdp"
import { LiveWatch } from "@/session/live-watch"
import { Session } from "@/session/session"
import { Live } from "@opencode-ai/schema/live"
import { LiveGateway } from "@opencode-ai/core/live"
import { LiveTicket } from "@opencode-ai/core/live/ticket"
import { LIVE_CONNECT_TICKET_QUERY } from "@/server/shared/live"
import snippetSource from "@opencode-ai/live-capture/snippet.js" with { type: "text" }
import { Effect, Option, Queue, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { LiveConnectApi } from "../groups/live"
import { WebSocketTracker } from "../websocket-tracker"

const MAX_FRAME_CHARS = 262_144
const MAX_BATCH_EVENTS = 100
const decoder = new TextDecoder()

function normalizeDirectory(directory: string) {
  return directory.length > 1 ? directory.replace(/\/+$/, "") : directory
}

const parseJson = (frame: string) =>
  Effect.try({
    try: () => JSON.parse(frame) as unknown,
    catch: () => undefined,
  }).pipe(Effect.option)

export const liveHandlers = HttpApiBuilder.group(InstanceHttpApi, "live", (handlers) =>
  Effect.gen(function* () {
    const gateway = yield* LiveGateway.Service
    const session = yield* Session.Service
    const config = yield* Config.Service
    const liveWatch = yield* LiveWatch.Service
    const liveCdp = yield* LiveCdp.Service
    const tickets = yield* LiveTicket.Service

    const ensureWatch = Effect.fn("LiveHttpApi.ensureWatch")(function* (directory: string) {
      const cfg = yield* config.get()
      yield* gateway.setFieldsMode(directory, cfg.live?.fields)
      if (cfg.live?.triggers) yield* gateway.configure(directory, cfg.live.triggers)
      if (cfg.live?.watch) yield* liveWatch.ensure(directory, cfg.live.watch)
      if (cfg.live?.cdp) yield* liveCdp.ensure(directory, cfg.live.cdp)
    })

    const start = Effect.fn("LiveHttpApi.start")(function* () {
      const ctx = yield* InstanceState.context
      const directory = normalizeDirectory(ctx.directory)
      const current = yield* gateway.status(directory)
      if (current.sessionID) {
        const existing = yield* session.get(current.sessionID as Session.Info["id"]).pipe(Effect.option)
        if (Option.isSome(existing)) {
          yield* ensureWatch(directory)
          return existing.value
        }
      }
      const info = yield* session.create({ agent: "live", title: "Live session", metadata: { live: true } })
      yield* gateway.bind(directory, info.id)
      yield* ensureWatch(directory)
      return info
    })

    const stop = Effect.fn("LiveHttpApi.stop")(function* () {
      const ctx = yield* InstanceState.context
      const directory = normalizeDirectory(ctx.directory)
      yield* gateway.unbind(directory)
      yield* tickets.revoke(directory)
      yield* liveWatch.stop(directory)
      yield* liveCdp.stop(directory)
      return yield* gateway.status(directory)
    })

    const status = Effect.fn("LiveHttpApi.status")(function* () {
      const ctx = yield* InstanceState.context
      return yield* gateway.status(normalizeDirectory(ctx.directory))
    })

    const journal = Effect.fn("LiveHttpApi.journal")(function* (ctx: {
      query: { since?: string; kind?: Live.Telemetry["kind"]; limit?: string }
    }) {
      const instance = yield* InstanceState.context
      const since = ctx.query.since === undefined ? undefined : Number(ctx.query.since)
      const limit = ctx.query.limit === undefined ? undefined : Number(ctx.query.limit)
      return yield* gateway.read(normalizeDirectory(instance.directory), {
        since: Number.isSafeInteger(since) ? since : undefined,
        kind: ctx.query.kind,
        limit: Number.isSafeInteger(limit) ? limit : undefined,
      })
    })

    return handlers.handle("start", start).handle("stop", stop).handle("status", status).handle("journal", journal)
  }),
)

export const liveConnectHandlers = HttpApiBuilder.group(LiveConnectApi, "live-connect", (handlers) =>
  Effect.gen(function* () {
    const gateway = yield* LiveGateway.Service
    const tickets = yield* LiveTicket.Service

    return handlers
      .handleRaw(
        "inject",
        Effect.fn("LiveHttpApi.inject")(function* (ctx) {
          const url = new URL(ctx.request.url, "http://localhost")
          const directory = url.searchParams.get("directory")
          if (!directory) return HttpServerResponse.empty({ status: 404 })
          const normalized = normalizeDirectory(directory)
          // Only directories with an explicitly started live session get a script (and with it a
          // ticket): an arbitrary website loading this URL cross-site should learn nothing unless
          // the user has gone live and the site guesses the absolute project path.
          const status = yield* gateway.status(normalized)
          if (!status.sessionID) return HttpServerResponse.empty({ status: 404 })
          const ticket = yield* tickets.issue(normalized)
          const server = `http://${ctx.request.headers.host ?? "localhost:4096"}`
          // The fields-capture mode is resolved from the live channel (set at session start, where
          // directory context exists) rather than config.get() here — this inject route is
          // ticket-based and has no instance/directory context, so config.get() would die.
          const fields = yield* gateway.fieldsMode(normalized)
          const injected = JSON.stringify({ server, ticket, directory: normalized, fields })
          return HttpServerResponse.text(`globalThis.__OPENCODE_LIVE__ = ${injected};\n${snippetSource}`, {
            contentType: "text/javascript",
          })
        }),
      )
      .handleRaw(
        "connect",
        Effect.fn("LiveHttpApi.connect")(function* (ctx) {
          const url = new URL(ctx.request.url, "http://localhost")
          const ticket = url.searchParams.get(LIVE_CONNECT_TICKET_QUERY)
          if (!ticket) return HttpServerResponse.empty({ status: 403 })
          const directory = yield* tickets.consume(ticket)
          if (!directory) return HttpServerResponse.empty({ status: 403 })

          const socket = yield* Effect.orDie(ctx.request.upgrade)
          const write = yield* socket.writer
          const registered = yield* WebSocketTracker.register(write(WebSocketTracker.SERVER_CLOSING_EVENT()))
          if (!registered) return HttpServerResponse.empty()

          const connection = yield* gateway.connect(directory)
          const inbox = yield* Queue.unbounded<string>()
          const drain = Effect.gen(function* () {
            while (true) {
              const frame = yield* Queue.take(inbox)
              const json = yield* parseJson(frame)
              if (Option.isNone(json)) continue
              const batch = Schema.decodeUnknownOption(Live.IngestBatch)(json.value)
              if (Option.isNone(batch)) continue
              yield* gateway.ingest(directory, {
                source: batch.value.source,
                events: batch.value.events.slice(0, MAX_BATCH_EVENTS),
              })
            }
          })

          yield* Effect.race(
            drain,
            socket.runRaw((message) => {
              const frame = typeof message === "string" ? message : decoder.decode(message)
              if (frame.length <= MAX_FRAME_CHARS) Queue.offerUnsafe(inbox, frame)
            }),
          ).pipe(
            Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
            Effect.ensuring(connection.disconnect),
            Effect.orDie,
          )
          return HttpServerResponse.empty()
        }),
      )
  }),
)
