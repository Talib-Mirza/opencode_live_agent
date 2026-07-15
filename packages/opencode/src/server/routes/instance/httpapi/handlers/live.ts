import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { BridgeError, LiveBridge } from "@/session/live-bridge"
import { LiveCdp } from "@/session/live-cdp"
import { LiveWatch } from "@/session/live-watch"
import { Session } from "@/session/session"
import { Live } from "@opencode-ai/schema/live"
import { LiveGateway } from "@opencode-ai/core/live"
import { LiveTicket } from "@opencode-ai/core/live/ticket"
import { LIVE_CONNECT_TICKET_QUERY } from "@/server/shared/live"
import snippetSource from "@opencode-ai/live-capture/snippet.js" with { type: "text" }
import snapshotSource from "@opencode-ai/live-capture/snapshot.js" with { type: "text" }
import { Deferred, Effect, Option, Queue, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { LiveConnectApi } from "../groups/live"
import { WebSocketTracker } from "../websocket-tracker"
import * as SessionError from "./session-errors"

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

    // Clears the live flag on whichever session the directory is currently bound to, so it stops
    // rendering as live and a server restart does not rehydrate it.
    const clearBoundSession = Effect.fn("LiveHttpApi.clearBoundSession")(function* (directory: string) {
      const current = yield* gateway.status(directory)
      if (!current.sessionID) return
      const bound = yield* session.get(current.sessionID as Session.Info["id"]).pipe(Effect.option)
      if (Option.isNone(bound) || !bound.value.metadata?.live) return
      yield* session.setMetadata({
        sessionID: bound.value.id,
        metadata: { ...bound.value.metadata, live: false },
      })
    })

    const start = Effect.fn("LiveHttpApi.start")(function* (ctx: { query: { sessionID?: string } }) {
      const instance = yield* InstanceState.context
      const directory = normalizeDirectory(instance.directory)
      if (ctx.query.sessionID) {
        const sessionID = ctx.query.sessionID as Session.Info["id"]
        const target = yield* SessionError.mapStorageNotFound(session.get(sessionID))
        const current = yield* gateway.status(directory)
        if (current.sessionID !== sessionID) yield* clearBoundSession(directory)
        yield* session.setMetadata({ sessionID, metadata: { ...target.metadata, live: true } })
        yield* gateway.bind(directory, sessionID)
        yield* ensureWatch(directory)
        return yield* SessionError.mapStorageNotFound(session.get(sessionID))
      }
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
      yield* clearBoundSession(directory)
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
    const bridge = yield* LiveBridge.Service

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
          // snapshotSource defines __OPENCODE_LIVE_SNAPSHOT__ (used by browser_read); snippetSource
          // is the telemetry capture that also calls it when a snapshot frame arrives.
          return HttpServerResponse.text(
            `globalThis.__OPENCODE_LIVE__ = ${injected};\n${snapshotSource}\n${snippetSource}`,
            { contentType: "text/javascript" },
          )
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

          // browser_read plumbing: the server sends a snapshot request frame down this socket and the
          // snippet answers with a snapshot_result frame, correlated by id. The responder is mutable
          // so a `hello` frame can attach this socket's tab id for per-tab routing.
          const pending = new Map<string, Deferred.Deferred<Live.SnapshotResult, BridgeError>>()
          let requestSeq = 0
          const responder: LiveBridge.Responder = {
            source: "injected",
            respond: (request) =>
              Effect.suspend(() => {
                requestSeq += 1
                const id = `s${requestSeq}`
                return Deferred.make<Live.SnapshotResult, BridgeError>().pipe(
                  Effect.flatMap((deferred) => {
                    pending.set(id, deferred)
                    const frame: Live.SnapshotRequestFrame = { type: "snapshot", id, request }
                    return write(JSON.stringify(frame)).pipe(
                      Effect.mapError((error) => new BridgeError({ reason: "failed", detail: `browser send failed: ${error}` })),
                      Effect.flatMap(() => Deferred.await(deferred)),
                      Effect.ensuring(Effect.sync(() => pending.delete(id))),
                    )
                  }),
                )
              }),
          }
          const registration = yield* bridge.register(directory, responder)

          const drain = Effect.gen(function* () {
            while (true) {
              const frame = yield* Queue.take(inbox)
              const json = yield* parseJson(frame)
              if (Option.isNone(json)) continue
              const value = json.value as { type?: string }
              if (value?.type === "hello") {
                const hello = Schema.decodeUnknownOption(Live.HelloFrame)(value)
                if (Option.isSome(hello)) responder.tab = hello.value.tab
                continue
              }
              if (value?.type === "snapshot_result") {
                const result = Schema.decodeUnknownOption(Live.SnapshotResultFrame)(value)
                if (Option.isNone(result)) continue
                const deferred = pending.get(result.value.id)
                if (deferred) yield* Deferred.succeed(deferred, result.value.result)
                continue
              }
              const batch = Schema.decodeUnknownOption(Live.IngestBatch)(value)
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
            Effect.ensuring(registration.release),
            Effect.ensuring(connection.disconnect),
            Effect.orDie,
          )
          return HttpServerResponse.empty()
        }),
      )
  }),
)
