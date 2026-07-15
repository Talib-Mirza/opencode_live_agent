import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { LiveGateway } from "@opencode-ai/core/live"
import { Live } from "@opencode-ai/schema/live"
import DESCRIPTION from "./live-wait.txt"
import * as Tool from "./tool"

const NOT_BOUND =
  "live_wait only works in the session bound to an active live capture (started via Go Live). No conditions were armed."

const MAX_WAITS = 10
const TIMEOUT_MIN = 1
const TIMEOUT_MAX = 3600

function normalizeDirectory(directory: string) {
  return directory.length > 1 ? directory.replace(/\/+$/, "") : directory
}

export const WaitParameters = Schema.Struct({
  waits: Schema.Array(
    Schema.Struct({
      description: Schema.String.annotate({
        description:
          "What you are waiting for, in your own words. Shown to the user while armed and echoed back to you when it fires.",
      }),
      sources: Schema.optional(
        Schema.Array(Schema.Literals(["navigation", "click", "input", "console", "network", "error", "backend_log"])),
      ).annotate({ description: "Only consider these event kinds. Omit to consider every kind." }),
      pattern: Schema.optional(Schema.String).annotate({
        description:
          "Case-insensitive JavaScript regex tested against the canonical one-line rendering of each candidate event (format in the tool description). Omit to match any event from the selected sources.",
      }),
      timeoutSeconds: Schema.optional(Schema.Number).annotate({
        description:
          "Wake anyway after this many seconds if the condition has not matched (1-3600). With no pattern and no sources this is a pure timer.",
      }),
    }),
  ).annotate({
    description:
      "The complete set of wake conditions. Replaces any conditions from earlier live_wait calls. Pass [] to cancel all waiting.",
  }),
  note: Schema.optional(Schema.String).annotate({
    description: "Note to your future self; echoed verbatim in the wake message.",
  }),
})

type WaitInput = typeof WaitParameters.Type

export const LiveWaitTool = Tool.define(
  "live_wait",
  Effect.gen(function* () {
    const gateway = yield* LiveGateway.Service
    return {
      description: DESCRIPTION,
      parameters: WaitParameters,
      execute: (params: WaitInput, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "live_wait",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const ins = yield* InstanceState.context
          const directory = normalizeDirectory(ins.directory)
          const status = yield* gateway.status(directory)
          if (status.sessionID !== ctx.sessionID)
            return { title: "live_wait unavailable", metadata: { count: 0, waits: [] }, output: NOT_BOUND }
          if (params.waits.length > MAX_WAITS)
            return {
              title: "too many conditions",
              metadata: { count: 0, waits: [] },
              output: `live_wait accepts at most ${MAX_WAITS} conditions per call; got ${params.waits.length}. Nothing was armed.`,
            }
          const invalid = params.waits.find(
            (wait) => wait.pattern === undefined && wait.sources === undefined && wait.timeoutSeconds === undefined,
          )
          if (invalid)
            return {
              title: "invalid condition",
              metadata: { count: 0, waits: [] },
              output: `The condition "${invalid.description}" has no pattern, no sources, and no timeoutSeconds — it could never fire. Give it at least one of those. Nothing was armed.`,
            }
          const compiled = yield* Effect.forEach(
            params.waits.flatMap((wait) =>
              wait.pattern === undefined ? [] : [{ description: wait.description, pattern: wait.pattern }],
            ),
            (entry) =>
              Effect.try({ try: () => new RegExp(entry.pattern, "i"), catch: (error) => String(error) }).pipe(
                Effect.as(undefined),
                Effect.catch((message: string) => Effect.succeed({ ...entry, message })),
              ),
          )
          const badPattern = compiled.find((entry) => entry !== undefined)
          if (badPattern)
            return {
              title: "invalid pattern",
              metadata: { count: 0, waits: [] },
              output: `The pattern ${JSON.stringify(badPattern.pattern)} for "${badPattern.description}" is not a valid JavaScript regex: ${badPattern.message}. Fix it and call live_wait again. Nothing was armed.`,
            }
          const armed = yield* gateway.arm(directory, {
            sessionID: ctx.sessionID,
            note: params.note,
            waits: params.waits.map((wait) => ({
              description: wait.description,
              sources: wait.sources,
              pattern: wait.pattern,
              timeoutSeconds:
                wait.timeoutSeconds === undefined
                  ? undefined
                  : Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, wait.timeoutSeconds)),
            })),
          })
          if (armed.length === 0)
            return {
              title: "wait cancelled",
              metadata: { count: 0, waits: [] },
              output: "All wake conditions cancelled.",
            }
          const lines = armed.map(
            (wait) =>
              `- ${wait.description}${wait.timeoutAt ? ` (times out ${new Date(wait.timeoutAt).toTimeString().slice(0, 8)})` : ""}`,
          )
          return {
            title: `waiting: ${armed[0].description}`,
            metadata: { count: armed.length, waits: armed },
            output: [
              `Armed ${armed.length} wake condition(s):`,
              ...lines,
              "",
              "You will be woken automatically when one fires or times out. Tell the user what you are waiting for if you have not already, then END YOUR TURN — do not poll, sleep, or keep working while waiting.",
            ].join("\n"),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof WaitParameters, { count: number; waits?: ReadonlyArray<Live.WaitInfo> }>
  }),
)
