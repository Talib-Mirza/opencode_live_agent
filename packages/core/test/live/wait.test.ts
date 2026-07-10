import { describe, expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LiveGateway } from "@opencode-ai/core/live"
import { LiveWake } from "@opencode-ai/core/live/wake"
import { Live } from "@opencode-ai/schema/live"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LiveGateway.node))

const navigation = (url: string, from?: string): Live.Telemetry => ({
  kind: "navigation",
  ts: Date.now(),
  url,
  from,
})

const click = (selector: string, text?: string): Live.Telemetry => ({
  kind: "click",
  ts: Date.now(),
  url: "http://localhost:5173/projects",
  selector,
  text,
})

const consoleError = (message: string): Live.Telemetry => ({
  kind: "console",
  ts: Date.now(),
  url: "http://localhost:5173/",
  level: "error",
  message,
})

const batch = (...events: Live.Telemetry[]): Live.IngestBatch => ({ source: "injected", events })

const collectWakes = Effect.gen(function* () {
  const gateway = yield* LiveGateway.Service
  const collected: LiveWake.Wake[] = []
  const fiber = yield* gateway
    .wakes()
    .pipe(Stream.runForEach((wake) => Effect.sync(() => collected.push(wake))), Effect.forkScoped)
  yield* Effect.sleep(10)
  return { collected, fiber }
})

const collectDigests = Effect.gen(function* () {
  const gateway = yield* LiveGateway.Service
  const collected: string[] = []
  const fiber = yield* gateway
    .digests()
    .pipe(Stream.runForEach((digest) => Effect.sync(() => collected.push(digest.trigger))), Effect.forkScoped)
  yield* Effect.sleep(10)
  return { collected, fiber }
})

describe("live wait — matching", () => {
  it.live("fires immediately and bypasses the user-quiet digest throttle", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const wakes = yield* collectWakes
      const digests = yield* collectDigests
      yield* gateway.bind("/tmp/wait-a", "ses_wait_a")
      // Inside the user-quiet window digests are suppressed; armed waits are not.
      yield* gateway.noteUserActivity("ses_wait_a")
      yield* gateway.arm("/tmp/wait-a", {
        sessionID: "ses_wait_a",
        note: "step 2 of 4",
        waits: [{ description: "user reaches the dashboard", sources: ["navigation"], pattern: "url=.*/dashboard" }],
      })
      yield* gateway.ingest(
        "/tmp/wait-a",
        batch(consoleError("boom"), navigation("http://localhost:5173/dashboard", "http://localhost:5173/login")),
      )
      yield* Effect.sleep(20)

      expect(digests.collected).toEqual([])
      expect(wakes.collected.length).toBe(1)
      const wake = wakes.collected[0]
      expect(wake.sessionID).toBe("ses_wait_a")
      expect(wake.timedOut).toBe(false)
      expect(wake.description).toBe("user reaches the dashboard")
      expect(wake.text).toContain("<live_wait_fired")
      expect(wake.text).toContain("navigation url=http://localhost:5173/dashboard from=http://localhost:5173/login")
      expect(wake.text).toContain("step 2 of 4")
      yield* Fiber.interrupt(wakes.fiber)
      yield* Fiber.interrupt(digests.fiber)
    }),
  )

  it.live("is one-shot per wait while other waits stay armed", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectWakes
      yield* gateway.bind("/tmp/wait-b", "ses_wait_b")
      yield* gateway.arm("/tmp/wait-b", {
        sessionID: "ses_wait_b",
        waits: [
          { description: "dashboard", sources: ["navigation"], pattern: "dashboard" },
          { description: "settings", sources: ["navigation"], pattern: "settings" },
        ],
      })
      yield* gateway.ingest("/tmp/wait-b", batch(navigation("http://localhost:5173/dashboard")))
      yield* gateway.ingest("/tmp/wait-b", batch(navigation("http://localhost:5173/dashboard")))
      yield* Effect.sleep(20)
      expect(collected.map((wake) => wake.description)).toEqual(["dashboard"])
      const status = yield* gateway.status("/tmp/wait-b")
      expect(status.waits.map((wait) => wait.description)).toEqual(["settings"])

      yield* gateway.ingest("/tmp/wait-b", batch(navigation("http://localhost:5173/settings")))
      yield* Effect.sleep(20)
      expect(collected.map((wake) => wake.description)).toEqual(["dashboard", "settings"])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("respects the sources prefilter and matches case-insensitively", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectWakes
      yield* gateway.bind("/tmp/wait-c", "ses_wait_c")
      yield* gateway.arm("/tmp/wait-c", {
        sessionID: "ses_wait_c",
        waits: [{ description: "new project clicked", sources: ["click"], pattern: "new.?project" }],
      })
      // A navigation mentioning new-project must not fire a click-only wait.
      yield* gateway.ingest("/tmp/wait-c", batch(navigation("http://localhost:5173/new-project")))
      yield* Effect.sleep(20)
      expect(collected).toEqual([])

      yield* gateway.ingest("/tmp/wait-c", batch(click("button.create", "New Project")))
      yield* Effect.sleep(20)
      expect(collected.length).toBe(1)
      expect(collected[0].text).toContain('click selector=button.create text="New Project"')
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("matches backend_log lines on stdout as well as stderr", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectWakes
      yield* gateway.bind("/tmp/wait-d", "ses_wait_d")
      yield* gateway.arm("/tmp/wait-d", {
        sessionID: "ses_wait_d",
        waits: [{ description: "migration done", sources: ["backend_log"], pattern: "migration complete" }],
      })
      yield* gateway.appendLog("/tmp/wait-d", [{ ts: Date.now(), stream: "stdout", line: "Migration complete (12 tables)" }])
      yield* Effect.sleep(20)

      expect(collected.length).toBe(1)
      expect(collected[0].text).toContain("backend_log stream=stdout line=Migration complete (12 tables)")
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("does not fire for unbound directories or pure timers", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectWakes
      yield* gateway.bind("/tmp/wait-e", "ses_wait_e")
      // A pure timer (no sources, no pattern) never matches events.
      yield* gateway.arm("/tmp/wait-e", {
        sessionID: "ses_wait_e",
        waits: [{ description: "just a timer", timeoutSeconds: 3600 }],
      })
      yield* gateway.ingest("/tmp/wait-e", batch(navigation("http://localhost:5173/anywhere")))
      yield* Effect.sleep(20)

      expect(collected).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )
})

describe("live wait — lifecycle", () => {
  it.live("fires a timeout wake, and a match cancels the timeout", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectWakes
      yield* gateway.bind("/tmp/wait-f", "ses_wait_f")
      yield* gateway.arm("/tmp/wait-f", {
        sessionID: "ses_wait_f",
        waits: [{ description: "never happens", sources: ["click"], pattern: "no-such-thing", timeoutSeconds: 0.05 }],
      })
      yield* Effect.sleep(120)
      expect(collected.length).toBe(1)
      expect(collected[0].timedOut).toBe(true)
      expect(collected[0].text).toContain("<live_wait_timeout")

      yield* gateway.arm("/tmp/wait-f", {
        sessionID: "ses_wait_f",
        waits: [{ description: "save clicked", sources: ["click"], pattern: "button.save", timeoutSeconds: 0.05 }],
      })
      yield* gateway.ingest("/tmp/wait-f", batch(click("button.save")))
      yield* Effect.sleep(120)
      // The match consumed the wait, so the timeout fiber must not produce a second wake.
      expect(collected.length).toBe(2)
      expect(collected[1].timedOut).toBe(false)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("replaces the armed set on re-arm and cancels with an empty set", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectWakes
      yield* gateway.bind("/tmp/wait-g", "ses_wait_g")
      yield* gateway.arm("/tmp/wait-g", {
        sessionID: "ses_wait_g",
        waits: [{ description: "old", sources: ["navigation"], pattern: "old-page" }],
      })
      yield* gateway.arm("/tmp/wait-g", {
        sessionID: "ses_wait_g",
        waits: [{ description: "new", sources: ["navigation"], pattern: "new-page" }],
      })
      const armed = yield* gateway.status("/tmp/wait-g")
      expect(armed.waits.map((wait) => wait.description)).toEqual(["new"])
      yield* gateway.ingest("/tmp/wait-g", batch(navigation("http://localhost:5173/old-page")))
      yield* Effect.sleep(20)
      expect(collected).toEqual([])

      yield* gateway.arm("/tmp/wait-g", { sessionID: "ses_wait_g", waits: [] })
      const cleared = yield* gateway.status("/tmp/wait-g")
      expect(cleared.waits).toEqual([])
      yield* gateway.ingest("/tmp/wait-g", batch(navigation("http://localhost:5173/new-page")))
      yield* Effect.sleep(20)
      expect(collected).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.live("clears waits when the binding changes or ends", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectWakes
      yield* gateway.bind("/tmp/wait-h", "ses_wait_h1")
      yield* gateway.arm("/tmp/wait-h", {
        sessionID: "ses_wait_h1",
        waits: [{ description: "for h1", sources: ["navigation"], pattern: "dashboard" }],
      })
      yield* gateway.bind("/tmp/wait-h", "ses_wait_h2")
      expect((yield* gateway.status("/tmp/wait-h")).waits).toEqual([])
      yield* gateway.ingest("/tmp/wait-h", batch(navigation("http://localhost:5173/dashboard")))
      yield* Effect.sleep(20)
      expect(collected).toEqual([])

      yield* gateway.arm("/tmp/wait-h", {
        sessionID: "ses_wait_h2",
        waits: [{ description: "for h2", sources: ["navigation"], pattern: "dashboard" }],
      })
      yield* gateway.unbind("/tmp/wait-h")
      expect((yield* gateway.status("/tmp/wait-h")).waits).toEqual([])
      yield* Fiber.interrupt(fiber)
    }),
  )
})

describe("live wait — canonical lines and rendering", () => {
  it.live("renders every telemetry kind and omits absent optional fields", () =>
    Effect.gen(function* () {
      expect(LiveWake.eventLine(navigation("http://x.dev/a"))).toBe("navigation url=http://x.dev/a")
      expect(LiveWake.eventLine(navigation("http://x.dev/a", "http://x.dev/b"))).toBe(
        "navigation url=http://x.dev/a from=http://x.dev/b",
      )
      expect(LiveWake.eventLine(click("button.save"))).toBe(
        "click selector=button.save url=http://localhost:5173/projects",
      )
      expect(LiveWake.eventLine(click("button.save", "Save"))).toBe(
        'click selector=button.save text="Save" url=http://localhost:5173/projects',
      )
      expect(LiveWake.eventLine(consoleError("boom"))).toBe(
        "console level=error message=boom url=http://localhost:5173/",
      )
      expect(
        LiveWake.eventLine({
          kind: "network",
          ts: 0,
          url: "http://x.dev/",
          method: "POST",
          requestUrl: "http://x.dev/api",
          status: 500,
        }),
      ).toBe("network method=POST requestUrl=http://x.dev/api status=500 url=http://x.dev/")
      expect(
        LiveWake.eventLine({ kind: "error", ts: 0, url: "http://x.dev/", message: "bad", origin: "uncaught" }),
      ).toBe("error origin=uncaught message=bad url=http://x.dev/")
      expect(LiveWake.logLine({ ts: 0, stream: "stderr", line: "boom" })).toBe(
        "backend_log stream=stderr line=boom",
      )
    }),
  )

  it.live("never renders a redacted field value in a wake", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const { collected, fiber } = yield* collectWakes
      yield* gateway.bind("/tmp/wait-i", "ses_wait_i")
      yield* gateway.arm("/tmp/wait-i", {
        sessionID: "ses_wait_i",
        waits: [{ description: "signup submitted", sources: ["input"], pattern: "trigger=submit" }],
      })
      yield* gateway.ingest(
        "/tmp/wait-i",
        batch({
          kind: "input",
          ts: Date.now(),
          url: "http://localhost:5173/signup",
          trigger: "submit",
          fields: [
            { selector: "input#email", name: "email", fieldType: "email", filled: true, length: 7, value: "a@b.com", redacted: false },
            { selector: "input#password", name: "password", fieldType: "password", filled: true, length: 9, value: "hunter2!!", redacted: true },
          ],
        }),
      )
      yield* Effect.sleep(20)

      expect(collected.length).toBe(1)
      expect(collected[0].text).toContain('email="a@b.com"')
      expect(collected[0].text).toContain("password=[filled len=9]")
      expect(collected[0].text).not.toContain("hunter2")
      yield* Fiber.interrupt(fiber)
    }),
  )
})
