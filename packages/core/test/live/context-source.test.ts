import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LiveContextSource } from "@opencode-ai/core/live/context-source"
import { LiveGateway } from "@opencode-ai/core/live"
import { Live } from "@opencode-ai/schema/live"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/app"))
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([LiveContextSource.node, SystemContextRegistry.node, LiveGateway.node]), [
    [Location.node, locationLayer],
  ]),
)

const consoleError = (message: string): Live.Telemetry => ({
  kind: "console",
  ts: Date.now(),
  url: "http://localhost:5173/",
  level: "error",
  message,
})

describe("live system context source", () => {
  it.effect("contributes nothing while no live session is bound", () =>
    Effect.gen(function* () {
      const registry = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* registry.load())
      expect(initialized.baseline).toBe("")
      expect(Object.keys(initialized.snapshot)).toEqual([])
    }),
  )

  it.effect("appears on bind, updates on new errors, and renders removal on unbind", () =>
    Effect.gen(function* () {
      const gateway = yield* LiveGateway.Service
      const registry = yield* SystemContextRegistry.Service
      const before = yield* SystemContext.initialize(yield* registry.load())

      yield* gateway.bind(directory, "ses_live_ctx")
      const appeared = yield* SystemContext.reconcile(yield* registry.load(), before.snapshot)
      expect(appeared._tag).toBe("Updated")
      if (appeared._tag !== "Updated") return
      expect(appeared.text).toContain("live browser-testing session is active")
      expect(appeared.text).toContain("browser_journal")

      yield* gateway.ingest(directory, { source: "injected", events: [consoleError("boom in checkout")] })
      const refreshed = yield* SystemContext.reconcile(yield* registry.load(), appeared.snapshot)
      expect(refreshed._tag).toBe("Updated")
      if (refreshed._tag !== "Updated") return
      expect(refreshed.text).toContain("boom in checkout")

      yield* gateway.unbind(directory)
      const ended = yield* SystemContext.reconcile(yield* registry.load(), refreshed.snapshot)
      expect(ended._tag).toBe("Updated")
      if (ended._tag !== "Updated") return
      expect(ended.text).toContain("has ended")
    }),
  )
})
