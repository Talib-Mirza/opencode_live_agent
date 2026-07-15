export * as LiveDigest from "./digest"

import { Live } from "@opencode-ai/schema/live"

export type Severity = "error" | "warning"

export type Digest = {
  readonly directory: string
  readonly sessionID: string
  readonly trigger: string
  readonly severity: Severity
  readonly summary: string
  readonly text: string
  readonly ts: number
}

// One problem observed after a user interaction. A batch can coalesce several distinct issues
// (different signatures) into a single digest, so `render` takes an array of these.
export type Issue = {
  readonly trigger: string
  readonly severity: Severity
  readonly summary: string
  // Browser telemetry that triggered the issue, when there is one. Backend-error issues come
  // from a dev-server log line instead and carry `backendLine` with no `event`.
  readonly event?: Live.Telemetry
  readonly backendLine?: Live.DevLogLine
  readonly ts: number
  readonly occurrences: number
  readonly correlatedLogs: ReadonlyArray<Live.DevLogLine>
}

export type RenderInput = {
  readonly issues: ReadonlyArray<Issue>
  readonly ts: number
  readonly suppressed: number
  readonly recentActions: ReadonlyArray<Live.Telemetry>
}

function clock(ts: number) {
  return new Date(ts).toTimeString().slice(0, 8)
}

// Shared with wake.ts so redaction rules stay single-sourced: redacted values are never rendered.
export function field(state: Live.FieldState) {
  const name = state.name ?? state.id ?? state.selector
  if (state.redacted) return `${name}=[${state.filled ? `filled len=${state.length}` : "empty"}]`
  return `${name}=${JSON.stringify(state.value ?? "")}`
}

// Exported so the live_wait wake renderer can describe the same recent-action context a digest
// carries, keeping the two renderings single-sourced.
export function action(event: Live.Telemetry) {
  const tab = event.tab ? ` [tab:${event.tab}]` : ""
  switch (event.kind) {
    case "navigation":
      return `navigation -> ${event.url}${tab} (${clock(event.ts)})`
    case "click":
      return `click ${event.selector}${event.text ? ` "${event.text}"` : ""}${tab} (${clock(event.ts)})`
    case "input":
      return `${event.trigger === "submit" ? "submit" : "field"} ${event.fields.map(field).join(", ")}${tab} (${clock(event.ts)})`
    case "console":
      return `console.${event.level} ${event.message.slice(0, 120)} (${clock(event.ts)})`
    case "network":
      return `${event.method} ${event.requestUrl} ${event.status} (${clock(event.ts)})`
    case "error":
      return `${event.origin} ${event.message.slice(0, 120)} (${clock(event.ts)})`
  }
}

// The <occurrences>/<location>/<stack>/<backend_log>/correlated-logs body for one issue, shared
// by the single-issue layout (emitted at the top level), the multi-issue layout (wrapped in
// per-issue <issue> blocks), and the live_wait wake's <outcome> block.
export function renderIssue(issue: Issue) {
  const event = issue.event
  const stack = event && (event.kind === "error" || event.kind === "console") ? event.stack : undefined
  return [
    `<occurrences count="${issue.occurrences}" first_seen="${clock(issue.ts)}"/>`,
    ...(event ? [`<location url="${event.url}"/>`] : []),
    ...(stack ? ["<stack>", stack, "</stack>"] : []),
    ...(issue.backendLine
      ? [
          `<backend_log stream="${issue.backendLine.stream}">${issue.backendLine.line} (${clock(issue.backendLine.ts)})</backend_log>`,
        ]
      : []),
    ...(issue.correlatedLogs.length
      ? [
          "<correlated_dev_server_logs>",
          ...issue.correlatedLogs.map((log) => `[${log.stream}] ${log.line} (${clock(log.ts)})`),
          "</correlated_dev_server_logs>",
        ]
      : []),
  ]
}

const INSTRUCTIONS = [
  "<instructions>",
  "You are observing a live manual-testing session in the user's browser. A digest may report one",
  "or more problems; investigate each; the browser_journal and backend_logs tools return more",
  "surrounding context on demand. For each real problem, briefly explain the cause and fix it. If",
  "one looks expected or benign (dev-only warning, test data, intentional behavior), say so in one",
  "short sentence. Do not repeat the raw events back to the user.",
  "</instructions>",
]

export function render(input: RenderInput) {
  const suppressedNote = input.suppressed > 0 ? ` (+${input.suppressed} similar events suppressed)` : ""
  const severity = input.issues.some((issue) => issue.severity === "error") ? "error" : "warning"
  const actions = ["<recent_user_actions>", ...input.recentActions.map(action), "</recent_user_actions>"]
  if (input.issues.length === 1) {
    const issue = input.issues[0]
    return [
      `<live_agent_digest trigger="${issue.trigger}" severity="${issue.severity}">`,
      `<summary>${issue.summary}${suppressedNote}</summary>`,
      ...renderIssue(issue),
      ...actions,
      ...INSTRUCTIONS,
      "</live_agent_digest>",
    ].join("\n")
  }
  return [
    `<live_agent_digest trigger="multiple" severity="${severity}">`,
    `<summary>${input.issues.length} issues observed${suppressedNote}</summary>`,
    ...input.issues.flatMap((issue) => [
      `<issue trigger="${issue.trigger}" severity="${issue.severity}">`,
      `<summary>${issue.summary}</summary>`,
      ...renderIssue(issue),
      "</issue>",
    ]),
    ...actions,
    ...INSTRUCTIONS,
    "</live_agent_digest>",
  ].join("\n")
}
