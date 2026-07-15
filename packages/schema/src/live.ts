export * as Live from "./live"

import { Schema } from "effect"
import { optional, NonNegativeInt } from "./schema"
import { define, inventory } from "./event"

export const Source = Schema.Literals(["injected", "cdp", "extension"])
export type Source = typeof Source.Type

const envelope = {
  ts: NonNegativeInt,
  url: Schema.String,
  // Short capture-scoped id distinguishing browser tabs when several stream at once.
  tab: optional(Schema.String),
}

export const Navigation = Schema.Struct({
  kind: Schema.Literal("navigation"),
  ...envelope,
  from: optional(Schema.String),
}).annotate({ identifier: "LiveNavigation" })
export interface Navigation extends Schema.Schema.Type<typeof Navigation> {}

export const Click = Schema.Struct({
  kind: Schema.Literal("click"),
  ...envelope,
  selector: Schema.String,
  text: optional(Schema.String),
}).annotate({ identifier: "LiveClick" })
export interface Click extends Schema.Schema.Type<typeof Click> {}

// A single form field's identity and state at capture time. `value` is only present for
// non-sensitive fields; when `redacted` is true the value was withheld (password, sensitive
// autocomplete/name, or a project running in fill-state-only mode) and only `filled`/`length`
// describe it. This lets the agent tell a filled form from an empty one without ever receiving
// the secret itself.
export const FieldState = Schema.Struct({
  selector: Schema.String,
  name: optional(Schema.String),
  id: optional(Schema.String),
  fieldType: Schema.String,
  label: optional(Schema.String),
  filled: Schema.Boolean,
  length: NonNegativeInt,
  value: optional(Schema.String),
  redacted: Schema.Boolean,
}).annotate({ identifier: "LiveFieldState" })
export interface FieldState extends Schema.Schema.Type<typeof FieldState> {}

export const Input = Schema.Struct({
  kind: Schema.Literal("input"),
  ...envelope,
  // "change": a single field committed (blur/commit). "submit": snapshot of every field in the
  // submitted form, captured at submit time.
  trigger: Schema.Literals(["change", "submit"]),
  fields: Schema.Array(FieldState),
}).annotate({ identifier: "LiveInput" })
export interface Input extends Schema.Schema.Type<typeof Input> {}

export const Console = Schema.Struct({
  kind: Schema.Literal("console"),
  ...envelope,
  level: Schema.Literals(["log", "warn", "error"]),
  message: Schema.String,
  stack: optional(Schema.String),
}).annotate({ identifier: "LiveConsole" })
export interface Console extends Schema.Schema.Type<typeof Console> {}

export const Network = Schema.Struct({
  kind: Schema.Literal("network"),
  ...envelope,
  method: Schema.String,
  requestUrl: Schema.String,
  status: NonNegativeInt,
  durationMs: optional(NonNegativeInt),
}).annotate({ identifier: "LiveNetwork" })
export interface Network extends Schema.Schema.Type<typeof Network> {}

export const ErrorEvent = Schema.Struct({
  kind: Schema.Literal("error"),
  ...envelope,
  message: Schema.String,
  stack: optional(Schema.String),
  origin: Schema.Literals(["uncaught", "unhandledrejection"]),
}).annotate({ identifier: "LiveError" })
export interface ErrorEvent extends Schema.Schema.Type<typeof ErrorEvent> {}

export const Telemetry = Schema.Union([Navigation, Click, Input, Console, Network, ErrorEvent]).annotate({
  identifier: "LiveTelemetry",
})
export type Telemetry = typeof Telemetry.Type

export const IngestBatch = Schema.Struct({
  source: Source,
  events: Schema.Array(Telemetry),
}).annotate({ identifier: "LiveIngestBatch" })
export interface IngestBatch extends Schema.Schema.Type<typeof IngestBatch> {}

// On-demand page-read request the live agent issues via the browser_read tool. Runs identically in
// the injected snippet (in-page) and the CDP backend (Runtime.evaluate) — see live-capture/snapshot.js.
export const SnapshotMode = Schema.Literals(["text", "html", "a11y"])
export type SnapshotMode = typeof SnapshotMode.Type

export const SnapshotRequest = Schema.Struct({
  // CSS selector to read; omitted reads document.body.
  selector: optional(Schema.String),
  mode: optional(SnapshotMode),
  // Which connected tab to read; omitted targets the most-recently-connected one.
  tab: optional(Schema.String),
  maxChars: optional(NonNegativeInt),
  maxNodes: optional(NonNegativeInt),
}).annotate({ identifier: "LiveSnapshotRequest" })
export interface SnapshotRequest extends Schema.Schema.Type<typeof SnapshotRequest> {}

export const SnapshotNode = Schema.Struct({
  role: Schema.String,
  name: optional(Schema.String),
  state: optional(Schema.String),
}).annotate({ identifier: "LiveSnapshotNode" })
export interface SnapshotNode extends Schema.Schema.Type<typeof SnapshotNode> {}

export const SnapshotResult = Schema.Struct({
  found: Schema.Boolean,
  url: Schema.String,
  title: optional(Schema.String),
  selector: optional(Schema.String),
  mode: Schema.String,
  text: optional(Schema.String),
  html: optional(Schema.String),
  nodes: optional(Schema.Array(SnapshotNode)),
  truncated: Schema.Boolean,
  // Character count (text/html) or node count (a11y) before truncation.
  length: NonNegativeInt,
}).annotate({ identifier: "LiveSnapshotResult" })
export interface SnapshotResult extends Schema.Schema.Type<typeof SnapshotResult> {}

// Control frames on the injected-capture WebSocket. Telemetry batches still flow browser->server as
// IngestBatch; these add a request/response channel and a connect-time tab announcement. The server
// sends SnapshotRequestFrame down the socket; the snippet answers with SnapshotResultFrame. HelloFrame
// lets the server map a socket to the tab id its telemetry carries so per-tab reads can be routed.
export const HelloFrame = Schema.Struct({
  type: Schema.Literal("hello"),
  tab: Schema.String,
}).annotate({ identifier: "LiveHelloFrame" })
export interface HelloFrame extends Schema.Schema.Type<typeof HelloFrame> {}

export const SnapshotRequestFrame = Schema.Struct({
  type: Schema.Literal("snapshot"),
  id: Schema.String,
  request: SnapshotRequest,
}).annotate({ identifier: "LiveSnapshotRequestFrame" })
export interface SnapshotRequestFrame extends Schema.Schema.Type<typeof SnapshotRequestFrame> {}

export const SnapshotResultFrame = Schema.Struct({
  type: Schema.Literal("snapshot_result"),
  id: Schema.String,
  result: SnapshotResult,
}).annotate({ identifier: "LiveSnapshotResultFrame" })
export interface SnapshotResultFrame extends Schema.Schema.Type<typeof SnapshotResultFrame> {}

// Everything a connected browser may send server-ward: telemetry batches plus the two control frames.
export const ClientFrame = Schema.Union([IngestBatch, HelloFrame, SnapshotResultFrame]).annotate({
  identifier: "LiveClientFrame",
})
export type ClientFrame = typeof ClientFrame.Type

export const DevLogLine = Schema.Struct({
  ts: NonNegativeInt,
  stream: Schema.Literals(["stdout", "stderr"]),
  line: Schema.String,
}).annotate({ identifier: "LiveDevLogLine" })
export interface DevLogLine extends Schema.Schema.Type<typeof DevLogLine> {}

export const JournalEntry = Schema.Struct({
  seq: NonNegativeInt,
  event: Telemetry,
}).annotate({ identifier: "LiveJournalEntry" })
export interface JournalEntry extends Schema.Schema.Type<typeof JournalEntry> {}

// Event kinds a live_wait condition may select on: the six telemetry kinds plus dev-server log
// lines. Kept in sync with the canonical line rendering in core/src/live/wake.ts.
export const WaitSource = Schema.Literals([
  "navigation",
  "click",
  "input",
  "console",
  "network",
  "error",
  "backend_log",
]).annotate({ identifier: "LiveWaitSource" })
export type WaitSource = typeof WaitSource.Type

export const WaitInfo = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  armedAt: NonNegativeInt,
  timeoutAt: optional(NonNegativeInt),
}).annotate({ identifier: "LiveWaitInfo" })
export interface WaitInfo extends Schema.Schema.Type<typeof WaitInfo> {}

export const Status = Schema.Struct({
  directory: Schema.String,
  connected: Schema.Boolean,
  buffered: NonNegativeInt,
  sessionID: optional(Schema.String),
  lastDigest: optional(NonNegativeInt),
  waits: Schema.Array(WaitInfo),
}).annotate({ identifier: "LiveStatus" })
export interface Status extends Schema.Schema.Type<typeof Status> {}

const StatusUpdated = define({ type: "live.status.updated", schema: { status: Status } })
const DigestFired = define({
  type: "live.digest.fired",
  schema: {
    directory: Schema.String,
    sessionID: Schema.String,
    trigger: Schema.String,
    summary: Schema.String,
    ts: NonNegativeInt,
  },
})
const WaitArmed = define({
  type: "live.wait.armed",
  schema: {
    directory: Schema.String,
    sessionID: Schema.String,
    waits: Schema.Array(WaitInfo),
  },
})
const WaitFired = define({
  type: "live.wait.fired",
  schema: {
    directory: Schema.String,
    sessionID: Schema.String,
    waitID: Schema.String,
    description: Schema.String,
    timedOut: Schema.Boolean,
    ts: NonNegativeInt,
  },
})
export const Event = {
  StatusUpdated,
  DigestFired,
  WaitArmed,
  WaitFired,
  Definitions: inventory(StatusUpdated, DigestFired, WaitArmed, WaitFired),
}
