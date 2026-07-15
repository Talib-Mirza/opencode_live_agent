import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Live } from "@opencode-ai/schema/live"
import { Effect, Fiber } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { LiveBridge } from "@/session/live-bridge"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LiveBridge.node))

function result(url: string): Live.SnapshotResult {
  return { found: true, url, mode: "text", text: url, truncated: false, length: url.length }
}

describe("live.bridge", () => {
  it.effect("fails with no_connection when nothing is registered", () =>
    Effect.gen(function* () {
      const bridge = yield* LiveBridge.Service
      const error = yield* bridge.snapshot("/proj", {}).pipe(Effect.flip)
      expect(error.reason).toBe("no_connection")
    }),
  )

  it.effect("routes to the most-recently-registered responder, and by tab when asked", () =>
    Effect.gen(function* () {
      const bridge = yield* LiveBridge.Service
      yield* bridge.register("/proj", { source: "injected", tab: "aaa", respond: () => Effect.succeed(result("aaa")) })
      yield* bridge.register("/proj", { source: "cdp", tab: "bbb", respond: () => Effect.succeed(result("bbb")) })

      const recent = yield* bridge.snapshot("/proj", {})
      expect(recent.url).toBe("bbb")

      const byTab = yield* bridge.snapshot("/proj", { tab: "aaa" })
      expect(byTab.url).toBe("aaa")

      const missing = yield* bridge.snapshot("/proj", { tab: "zzz" }).pipe(Effect.flip)
      expect(missing.reason).toBe("no_connection")
    }),
  )

  it.effect("normalizes the directory key and deregisters on release", () =>
    Effect.gen(function* () {
      const bridge = yield* LiveBridge.Service
      const registration = yield* bridge.register("/proj/", {
        source: "injected",
        respond: () => Effect.succeed(result("ok")),
      })
      // Registered under "/proj/" but read as "/proj": same channel.
      expect(yield* bridge.connected("/proj")).toBe(true)
      const read = yield* bridge.snapshot("/proj", {})
      expect(read.url).toBe("ok")

      yield* registration.release
      expect(yield* bridge.connected("/proj")).toBe(false)
    }),
  )

  it.effect("fails with timeout when the responder never answers", () =>
    Effect.gen(function* () {
      const bridge = yield* LiveBridge.Service
      yield* bridge.register("/proj", { source: "injected", respond: () => Effect.never })
      const fiber = yield* bridge.snapshot("/proj", {}).pipe(Effect.flip, Effect.forkChild)
      yield* TestClock.adjust("5 seconds")
      const error = yield* Fiber.join(fiber)
      expect(error.reason).toBe("timeout")
    }),
  )
})
