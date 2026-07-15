import { Session } from "@/session/session"
import { Live } from "@opencode-ai/schema/live"
import { LIVE_CONNECT_TICKET_QUERY } from "@/server/shared/live"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ApiNotFoundError } from "../errors"
import { Authorization, LiveConnectAuthorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/live"

export const LivePaths = {
  start: `${root}/session`,
  stop: `${root}/stop`,
  status: `${root}/status`,
  journal: `${root}/journal`,
  inject: `${root}/inject.js`,
  connect: `${root}/connect`,
} as const

export const StartQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  sessionID: Schema.optional(Schema.String),
})

export const JournalQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  since: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["navigation", "click", "console", "network", "error"])),
  limit: Schema.optional(Schema.String),
})

export const JournalPage = Schema.Struct({
  entries: Schema.Array(Live.JournalEntry),
  cursor: Schema.Int,
}).annotate({ identifier: "LiveJournalPage" })

export const LiveApi = HttpApi.make("live").add(
  HttpApiGroup.make("live")
    .add(
      HttpApiEndpoint.post("start", LivePaths.start, {
        query: StartQuery,
        success: described(Session.Info, "Live session"),
        error: ApiNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "live.start",
          summary: "Start a live session",
          description:
            "Bind a session to this instance's directory so browser telemetry can flow to it. Pass sessionID to turn an existing session live (it keeps its agent and history); omit it to create a fresh live-agent session. Any other session that was live in this directory is turned off first.",
        }),
      ),
      HttpApiEndpoint.post("stop", LivePaths.stop, {
        query: WorkspaceRoutingQuery,
        success: described(Live.Status, "Live capture status after stopping"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "live.stop",
          summary: "Stop the live session",
          description:
            "Unbind the live session for this instance's directory, revoke outstanding capture tickets, stop any dev-server watchers, and clear the session's live flag so it becomes a normal session again.",
        }),
      ),
      HttpApiEndpoint.get("status", LivePaths.status, {
        query: WorkspaceRoutingQuery,
        success: described(Live.Status, "Live capture status"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "live.status",
          summary: "Get live capture status",
          description: "Report the live-capture state for this instance's directory.",
        }),
      ),
      HttpApiEndpoint.get("journal", LivePaths.journal, {
        query: JournalQuery,
        success: described(JournalPage, "Journal entries"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "live.journal",
          summary: "Read the live telemetry journal",
          description:
            "Return recent browser telemetry captured for this instance's directory, oldest-first, with a cursor for incremental reads.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "live", description: "Live agent session routes." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)

export const LiveConnectApi = HttpApi.make("live-connect").add(
  HttpApiGroup.make("live-connect")
    .add(
      HttpApiEndpoint.get("inject", LivePaths.inject, {
        success: described(Schema.String, "Capture script"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "live.inject",
          summary: "Serve the live capture script",
          description:
            "Serve the browser telemetry capture snippet for a directory with an active live session. Responds 404 until a live session is started.",
          transform: (operation) => ({
            ...operation,
            parameters: [
              ...(operation.parameters ?? []),
              { in: "query", name: "directory", schema: { type: "string" } },
            ],
          }),
        }),
      ),
      HttpApiEndpoint.get("connect", LivePaths.connect, {
        success: described(Schema.Boolean, "Connected"),
        error: HttpApiError.Forbidden,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "live.connect",
          summary: "Stream browser telemetry",
          description: "WebSocket ingest for live browser telemetry, authorized by a possession ticket.",
          transform: (operation) => ({
            ...operation,
            parameters: [
              ...(operation.parameters ?? []),
              { in: "query", name: LIVE_CONNECT_TICKET_QUERY, schema: { type: "string" } },
            ],
          }),
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "live", description: "Live capture ingest routes." }))
    .middleware(LiveConnectAuthorization),
)
