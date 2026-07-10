import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { LiveGateway } from "@opencode-ai/core/live"
import * as Tool from "./tool"

const NO_DATA =
  "No live session data available. These tools only return data while a live session is active for this project (started via Go Live) and the browser capture script is connected."

function normalizeDirectory(directory: string) {
  return directory.length > 1 ? directory.replace(/\/+$/, "") : directory
}

export const JournalParameters = Schema.Struct({
  since: Schema.optional(Schema.Number).annotate({
    description: "Only return events after this cursor (from a previous call). Omit for the most recent events.",
  }),
  kind: Schema.optional(Schema.Literals(["navigation", "click", "input", "console", "network", "error"])).annotate({
    description: "Only return events of this kind",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum events to return (default 50)" }),
})

export const BrowserJournalTool = Tool.define(
  "browser_journal",
  Effect.gen(function* () {
    const gateway = yield* LiveGateway.Service
    return {
      description:
        "Read recent browser telemetry (navigation, clicks, console messages, failed requests, errors) captured from the user's live testing session. Only useful in live sessions; use it to pull more context around a live_agent_digest. Returns events oldest-first with a cursor for incremental reads.",
      parameters: JournalParameters,
      execute: (params: { since?: number; kind?: "navigation" | "click" | "input" | "console" | "network" | "error"; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "browser_journal",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const ins = yield* InstanceState.context
          const result = yield* gateway.read(normalizeDirectory(ins.directory), {
            since: params.since,
            kind: params.kind,
            limit: params.limit ?? 50,
          })
          if (result.entries.length === 0)
            return { title: "browser journal", metadata: { count: 0, cursor: result.cursor }, output: NO_DATA }
          const lines = result.entries.map((entry) => `#${entry.seq} ${JSON.stringify(entry.event)}`)
          return {
            title: `${result.entries.length} events`,
            metadata: { count: result.entries.length, cursor: result.cursor },
            output: [`cursor: ${result.cursor}`, ...lines].join("\n"),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof JournalParameters, { count: number; cursor: number }>
  }),
)

export const LogsParameters = Schema.Struct({
  since: Schema.optional(Schema.Number).annotate({
    description: "Only return lines after this cursor (from a previous call). Omit for the most recent lines.",
  }),
  grep: Schema.optional(Schema.String).annotate({
    description: "Case-insensitive substring filter applied to each line",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Maximum lines to return (default 50)" }),
})

export const BackendLogsTool = Tool.define(
  "backend_logs",
  Effect.gen(function* () {
    const gateway = yield* LiveGateway.Service
    return {
      description:
        "Read recent dev-server output captured for the live session (configured via the live.watch config). Only useful in live sessions; use it to correlate a browser-side failure with backend stack traces or request logs.",
      parameters: LogsParameters,
      execute: (params: { since?: number; grep?: string; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "backend_logs",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })
          const ins = yield* InstanceState.context
          const result = yield* gateway.readLogs(normalizeDirectory(ins.directory), {
            since: params.since,
            grep: params.grep,
            limit: params.limit ?? 50,
          })
          if (result.lines.length === 0)
            return {
              title: "backend logs",
              metadata: { count: 0, cursor: result.cursor },
              output: `${NO_DATA} Backend log capture additionally requires a live.watch entry (command or logFile) in the opencode config.`,
            }
          const lines = result.lines.map(
            (log) => `[${log.stream}] ${new Date(log.ts).toTimeString().slice(0, 8)} ${log.line}`,
          )
          return {
            title: `${result.lines.length} log lines`,
            metadata: { count: result.lines.length, cursor: result.cursor },
            output: [`cursor: ${result.cursor}`, ...lines].join("\n"),
          }
        }),
    } satisfies Tool.DefWithoutID<typeof LogsParameters, { count: number; cursor: number }>
  }),
)
