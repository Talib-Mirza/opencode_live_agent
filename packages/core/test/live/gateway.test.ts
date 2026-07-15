import { describe, expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LiveGateway } from "@opencode-ai/core/live"
import { LiveSignature } from "@opencode-ai/core/live/signature"
import { Live } from "@opencode-ai/schema/live"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LiveGateway.node))

const consoleError = (message: string, overrides?: Partial<Live.Console>): Live.Telemetry => ({
  kind: "console",
  ts: Date.now(),
  url: "http://localhost:5173/dashboard",
  level: "error",
  message,
  ...overrides,
})

const network = (overrides: Partial<Live.Network> & Pick<Live.Network, "requestUrl" | "status">): Live.Telemetry => ({
  kind: "network",
  ts: Date.now(),
  url: "http://localhost:3000/dashboard",
  method: "GET",
  ...overrides,
})

const batch = (...events: Live.Telemetry[]): Live.IngestBatch => ({ source: "injected", events })

const collectDigests = Effect.gen(function* () {
  const gateway = yield* LiveGateway.Service
  const collected: string[] = []
  const fiber = yield* gateway.digests().pipe(
    Stream.runForEach((digest) => Effect.sync(() => collected.push(digest.trigger))),
    Effect.forkScoped,
  )
  yield* Effect.sleep(10)
  return { collected, fiber }
})

describe("live gateway triggers", () => {
  it.live("fires one digest per first-seen signature", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.bind("/tmp/app-a", "ses_live_a")
      yield* gateway.ingest("/tmp/app-a", batch(consoleError("boom 1"), consoleError("boom 2")))
      yield* Effect.sleep(20)

      expect(collected).toEqual(["console_error_first_seen"])
      const status = yield* gateway.status("/tmp/app-a")
      expect(status.buffered).toBe(2)
      expect(status.lastDigest).toBeDefined()
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("stays silent for unbound directories and non-error events", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.ingest("/tmp/app-b", batch(consoleError("unbound boom")))
      yield* gateway.bind("/tmp/app-c", "ses_live_c")
      yield* gateway.ingest(
        "/tmp/app-c",
        batch(
          { kind: "navigation", ts: Date.now(), url: "http://localhost:5173/" },
          { kind: "click", ts: Date.now(), url: "http://localhost:5173/", selector: "button.save" },
          { kind: "console", ts: Date.now(), url: "http://localhost:5173/", level: "warn", message: "meh" },
        ),
      )
      yield* Effect.sleep(20)

      expect(collected).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("fires distinct-signature digests across adjacent batches", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.bind("/tmp/app-d", "ses_live_d")
      yield* gateway.ingest("/tmp/app-d", batch(consoleError("first failure")))
      yield* gateway.ingest("/tmp/app-d", batch(consoleError("distinct second failure")))
      yield* Effect.sleep(20)

      expect(collected).toEqual(["console_error_first_seen", "console_error_first_seen"])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("coalesces distinct issues in one batch into a single multi-issue digest", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const texts: string[] = []
      const triggers: string[] = []
      const fiber = yield* gateway.digests().pipe(
        Stream.runForEach((digest) =>
          Effect.sync(() => {
            texts.push(digest.text)
            triggers.push(digest.trigger)
          }),
        ),
        Effect.forkScoped,
      )
      yield* Effect.sleep(10)
      yield* gateway.bind("/tmp/app-multi", "ses_live_multi")
      yield* gateway.ingest(
        "/tmp/app-multi",
        batch(consoleError("render blew up"), network({ requestUrl: "http://localhost:8000/api/save", status: 500 })),
      )
      yield* Effect.sleep(20)

      expect(triggers).toEqual(["multiple"])
      const text = texts[0]
      expect(text.match(/<issue /g)?.length).toBe(2)
      expect(text.match(/<recent_user_actions>/g)?.length).toBe(1)
      expect(text).toContain("2 issues observed")
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("caps coalesced issues and rolls the overflow into the suppressed note", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const texts: string[] = []
      const fiber = yield* gateway.digests().pipe(
        Stream.runForEach((digest) => Effect.sync(() => texts.push(digest.text))),
        Effect.forkScoped,
      )
      yield* Effect.sleep(10)
      yield* gateway.bind("/tmp/app-cap", "ses_live_cap")
      yield* gateway.ingest(
        "/tmp/app-cap",
        batch(
          ...Array.from({ length: 7 }, (_, i) =>
            network({ requestUrl: `http://localhost:8000/api/r${i}`, status: 500 }),
          ),
        ),
      )
      yield* Effect.sleep(20)

      expect(texts.length).toBe(1)
      expect(texts[0].match(/<issue /g)?.length).toBe(5)
      expect(texts[0]).toContain("(+2 similar events suppressed)")
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("holds digests during the user-quiet window and flushes them after it expires", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const collected: string[] = []
      const fiber = yield* gateway.digests().pipe(
        Stream.runForEach((digest) => Effect.sync(() => collected.push(digest.trigger))),
        Effect.forkScoped,
      )
      yield* TestClock.adjust(1)
      yield* gateway.bind("/tmp/app-quiet", "ses_live_quiet")
      // Simulate a launch-time bug: the user just spoke, then the page errors immediately.
      yield* gateway.noteUserActivity("ses_live_quiet")
      yield* gateway.ingest("/tmp/app-quiet", batch(consoleError("boom on launch")))
      yield* TestClock.adjust(1000)

      expect(collected).toEqual([])

      yield* TestClock.adjust(20_000)
      expect(collected).toEqual(["console_error_first_seen"])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("coalesces issues arriving across the quiet window into the held flush", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const collected: string[] = []
      const fiber = yield* gateway.digests().pipe(
        Stream.runForEach((digest) => Effect.sync(() => collected.push(digest.trigger))),
        Effect.forkScoped,
      )
      yield* TestClock.adjust(1)
      yield* gateway.bind("/tmp/app-quiet-b", "ses_live_quiet_b")
      yield* gateway.noteUserActivity("ses_live_quiet_b")
      yield* gateway.ingest("/tmp/app-quiet-b", batch(consoleError("first launch bug")))
      yield* TestClock.adjust(1000)
      yield* gateway.ingest(
        "/tmp/app-quiet-b",
        batch(network({ requestUrl: "http://localhost:8000/api/boot", status: 500 })),
      )
      yield* TestClock.adjust(20_000)

      expect(collected).toEqual(["multiple"])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("reads the journal with kind and cursor filters", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      yield* gateway.ingest(
        "/tmp/app-e",
        batch({ kind: "navigation", ts: Date.now(), url: "http://localhost:5173/" }, consoleError("journaled"), {
          kind: "click",
          ts: Date.now(),
          url: "http://localhost:5173/",
          selector: "a.nav",
        }),
      )
      const everything = yield* gateway.read("/tmp/app-e", {})
      expect(everything.entries.length).toBe(3)
      expect(everything.cursor).toBe(3)

      const clicks = yield* gateway.read("/tmp/app-e", { kind: "click" })
      expect(clicks.entries.map((entry) => entry.event.kind)).toEqual(["click"])

      const tail = yield* gateway.read("/tmp/app-e", { since: everything.entries[1].seq })
      expect(tail.entries.length).toBe(1)
    }),
  )
})

describe("live gateway phase 2", () => {
  it.live("fires one rage-click digest per burst", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.bind("/tmp/app-f", "ses_live_f")
      const base = Date.now()
      const click = (offset: number): Live.Telemetry => ({
        kind: "click",
        ts: base + offset,
        url: "http://localhost:5173/",
        selector: "button.save",
      })
      yield* gateway.ingest("/tmp/app-f", batch(click(0), click(200), click(400), click(600), click(800)))
      yield* Effect.sleep(20)

      expect(collected).toEqual(["rage_clicks"])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("correlates dev-server log lines into the digest text", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const digests: string[] = []
      const fiber = yield* gateway.digests().pipe(
        Stream.runForEach((digest) => Effect.sync(() => digests.push(digest.text))),
        Effect.forkScoped,
      )
      yield* Effect.sleep(10)
      yield* gateway.bind("/tmp/app-g", "ses_live_g")
      const now = Date.now()
      yield* gateway.appendLog("/tmp/app-g", [
        { ts: now - 1000, stream: "stderr", line: "GET /api/metrics 500 in 12ms" },
        { ts: now - 60_000, stream: "stdout", line: "server started" },
      ])
      yield* gateway.ingest("/tmp/app-g", batch(consoleError("metrics render blew up")))
      yield* Effect.sleep(20)

      expect(digests.length).toBe(1)
      expect(digests[0]).toContain("GET /api/metrics 500")
      expect(digests[0]).not.toContain("server started")
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("reads logs with grep and cursor", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const now = Date.now()
      yield* gateway.appendLog("/tmp/app-h", [
        { ts: now, stream: "stdout", line: "listening on 3000" },
        { ts: now, stream: "stderr", line: "TypeError: boom" },
        { ts: now, stream: "stdout", line: "GET / 200" },
      ])
      const all = yield* gateway.readLogs("/tmp/app-h", {})
      expect(all.lines.length).toBe(3)
      expect(all.cursor).toBe(3)

      const errors = yield* gateway.readLogs("/tmp/app-h", { grep: "typeerror" })
      expect(errors.lines.map((line) => line.line)).toEqual(["TypeError: boom"])

      const tail = yield* gateway.readLogs("/tmp/app-h", { since: 2 })
      expect(tail.lines.map((line) => line.line)).toEqual(["GET / 200"])
    }),
  )
})

describe("live gateway phase 3 — network + backend triggers", () => {
  it.live("fires network_failure for a cross-origin blocked request (status 0)", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.bind("/tmp/app-net-fail", "ses_live_nf")
      yield* gateway.ingest(
        "/tmp/app-net-fail",
        batch(network({ requestUrl: "http://localhost:8000/sessions", status: 0 })),
      )
      yield* Effect.sleep(20)

      expect(collected).toEqual(["network_failure"])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("fires same_origin_http_error for a cross-origin dev 500 (loopback)", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.bind("/tmp/app-net-500", "ses_live_n5")
      yield* gateway.ingest(
        "/tmp/app-net-500",
        batch(network({ requestUrl: "http://localhost:8000/api/data", status: 500 })),
      )
      yield* Effect.sleep(20)

      expect(collected).toEqual(["same_origin_http_error"])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("stays silent for a genuine third-party failure", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.bind("/tmp/app-net-3p", "ses_live_3p")
      yield* gateway.ingest(
        "/tmp/app-net-3p",
        batch(network({ requestUrl: "https://api.stripe.com/v1/charges", status: 500 })),
      )
      yield* Effect.sleep(20)

      expect(collected).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("respects the networkFailures toggle", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.bind("/tmp/app-net-off", "ses_live_no")
      yield* gateway.configure("/tmp/app-net-off", { networkFailures: false })
      yield* gateway.ingest(
        "/tmp/app-net-off",
        batch(network({ requestUrl: "http://localhost:8000/sessions", status: 0 })),
      )
      yield* Effect.sleep(20)

      expect(collected).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("fires backend_error for a matching stderr line but not stdout", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.bind("/tmp/app-backend", "ses_live_be")
      const now = Date.now()
      yield* gateway.appendLog("/tmp/app-backend", [
        { ts: now, stream: "stdout", line: "listening on 3000" },
        { ts: now, stream: "stderr", line: "Error: connect ECONNREFUSED 127.0.0.1:8000" },
      ])
      yield* Effect.sleep(20)

      expect(collected).toEqual(["backend_error"])
      yield* Fiber.interrupt(fiber)
    }),
  )
})

describe("live gateway — form field capture", () => {
  const submit = (fields: Live.FieldState[]): Live.Telemetry => ({
    kind: "input",
    ts: Date.now(),
    url: "http://localhost:5173/login",
    trigger: "submit",
    fields,
  })

  it.live("journals input events and filters them by kind", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      yield* gateway.ingest(
        "/tmp/app-fields",
        batch(
          submit([
            {
              selector: "input#email",
              name: "email",
              fieldType: "email",
              filled: true,
              length: 15,
              value: "a@b.com",
              redacted: false,
            },
            {
              selector: "input#password",
              name: "password",
              fieldType: "password",
              filled: true,
              length: 12,
              redacted: true,
            },
          ]),
        ),
      )
      const inputs = yield* gateway.read("/tmp/app-fields", { kind: "input" })
      expect(inputs.entries.length).toBe(1)
      const event = inputs.entries[0].event
      expect(event.kind).toBe("input")
    }),
  )

  it.live("surfaces submitted field state in the digest without leaking a redacted value", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const digests: string[] = []
      const fiber = yield* gateway.digests().pipe(
        Stream.runForEach((digest) => Effect.sync(() => digests.push(digest.text))),
        Effect.forkScoped,
      )
      yield* Effect.sleep(10)
      yield* gateway.bind("/tmp/app-login", "ses_live_login")
      // User fills and submits the form, then the login request 500s.
      yield* gateway.ingest(
        "/tmp/app-login",
        batch(
          submit([
            {
              selector: "input#email",
              name: "email",
              fieldType: "email",
              filled: true,
              length: 15,
              value: "user@example.com",
              redacted: false,
            },
            {
              selector: "input#password",
              name: "password",
              fieldType: "password",
              filled: true,
              length: 9,
              value: "hunter2!!",
              redacted: true,
            },
          ]),
          network({ url: "http://localhost:5173/login", requestUrl: "http://localhost:5173/api/login", status: 500 }),
        ),
      )
      yield* Effect.sleep(20)

      expect(digests.length).toBe(1)
      // The agent can see the fields were filled...
      expect(digests[0]).toContain('email="user@example.com"')
      expect(digests[0]).toContain("password=[filled len=9]")
      // ...but the redacted secret never appears anywhere in the digest.
      expect(digests[0]).not.toContain("hunter2")
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("does not fire a digest from typing alone", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectDigests
      yield* gateway.bind("/tmp/app-typing", "ses_live_typing")
      yield* gateway.ingest(
        "/tmp/app-typing",
        batch(
          submit([
            {
              selector: "input#q",
              name: "q",
              fieldType: "text",
              filled: true,
              length: 3,
              value: "abc",
              redacted: false,
            },
          ]),
        ),
      )
      yield* Effect.sleep(20)

      expect(collected).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )
})

describe("live signatures", () => {
  it.live("normalizes ids so repeated errors share a signature", () =>
    Effect.gen(function* () {
      expect(LiveSignature.normalize("failed for user 42 at 12:30")).toBe(
        LiveSignature.normalize("failed for user 7 at 09:15"),
      )
      expect(
        LiveSignature.pathTemplate("/api/user/42/orders/9f8b6b32-0c9a-4f2e-9a1c-2d3e4f5a6b7c", "http://x.dev/"),
      ).toBe("/api/user/:id/orders/:id")
      expect(LiveSignature.sameOrigin("/api/data", "http://localhost:5173/page")).toBe(true)
      expect(LiveSignature.sameOrigin("https://api.stripe.com/v1", "http://localhost:5173/page")).toBe(false)
      expect(LiveSignature.appOwned("http://localhost:8000/sessions", "http://localhost:3000/page")).toBe(true)
      expect(LiveSignature.appOwned("http://127.0.0.1:8000/sessions", "http://localhost:3000/page")).toBe(true)
      expect(LiveSignature.appOwned("https://api.stripe.com/v1", "http://localhost:3000/page")).toBe(false)
    }),
  )
})
