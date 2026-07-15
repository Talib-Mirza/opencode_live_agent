export * as LiveGateway from "./live"

import { Context, Effect, Fiber, Layer, PubSub, Scope, Stream } from "effect"
import { Live } from "@opencode-ai/schema/live"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { LiveDigest } from "./live/digest"
import { LiveSignature } from "./live/signature"
import { LiveWake } from "./live/wake"

const JOURNAL_LIMIT = 5_000
// A signature only re-fires after it has been completely absent for this long.
const RESEEN_MS = 30 * 1000
const DIGEST_WINDOW_MS = 5 * 60 * 1000
const DIGEST_WINDOW_MAX = 10
// Distinct issues coalesced into one digest are capped here; the rest roll into the suppressed
// count. A capture flush carries up to FLUSH_MAX_BATCH (20) events.
const ISSUES_PER_DIGEST = 5
// Problems folded into a fired wake's <outcome> block are capped here (most recent kept); this
// bounds the block for a wait that stayed armed across a long, noisy session.
const OUTCOME_ISSUES_MAX = 5
// Hold digests briefly after the user speaks so the agent finishes reading their message first.
// Held admissions are not dropped: they queue in the channel's pending buffer (capped at
// PENDING_LIMIT) and flush once the quiet window expires, so bugs that fire right on launch —
// typically seconds after the user's message — still wake the agent.
const USER_QUIET_MS = 15 * 1000
const PENDING_LIMIT = 50
const RECENT_ACTIONS = 6
const LOG_LIMIT = 2_000
// Dev-server log lines this close to the triggering event ride along in the digest.
const LOG_CORRELATION_MS = 3_000
const LOG_CORRELATION_MAX = 10
const RAGE_CLICKS = 4
const RAGE_WINDOW_MS = 1_500
const RAGE_REARM_MS = 5_000
// Dev-server stderr lines matching this wake the agent as a backend_error trigger.
const BACKEND_ERROR = /error|exception|traceback|unhandled|econnrefused|fatal|panic/i

export type Triggers = {
  readonly networkFailures: boolean
  readonly crossOriginDev: boolean
  readonly backendErrors: boolean
  readonly consoleWarn: boolean
}

const DEFAULT_TRIGGERS: Triggers = {
  networkFailures: true,
  crossOriginDev: true,
  backendErrors: true,
  consoleWarn: false,
}

// Every gateway entry point keys its channel by directory, but the callers disagree on the exact
// string: the bind/status/journal path passes the workspace-routing-resolved instance directory,
// while the ingest/connect path passes the raw directory a browser page carried in its capture
// ticket. Normalizing here (the single place a directory becomes a channel key) keeps telemetry and
// its session binding in the same channel instead of silently splitting into two.
function normalizeDirectory(directory: string) {
  return directory.length > 1 ? directory.replace(/\/+$/, "") : directory
}

export type JournalEntry = {
  readonly seq: number
  readonly event: Live.Telemetry
}

export type ReadInput = {
  readonly since?: number
  readonly kind?: Live.Telemetry["kind"]
  readonly limit?: number
}

export type ReadLogsInput = {
  readonly since?: number
  readonly grep?: string
  readonly limit?: number
}

type ClickBurst = {
  selector: string
  times: number[]
  fired: boolean
}

// An agent-authored wake condition, armed via the live_wait tool. `pattern` is a case-insensitive
// regex tested against the canonical line rendering in LiveWake (the tool pre-validates it, so a
// compile failure here is a defect). A spec with neither sources nor pattern is a pure timer and
// never matches events.
export type WaitSpec = {
  readonly description: string
  readonly sources?: ReadonlyArray<Live.WaitSource>
  readonly pattern?: string
  readonly timeoutSeconds?: number
}

export type ArmInput = {
  readonly sessionID: string
  readonly note?: string
  readonly waits: ReadonlyArray<WaitSpec>
}

type ArmedWait = {
  readonly id: string
  readonly spec: WaitSpec
  readonly regex?: RegExp
  readonly armedAt: number
  // Journal sequence at arm time. The wake's <outcome> selects journal entries by `seq > armedSeq`
  // rather than by timestamp so browser-clock skew cannot include or drop the wrong events.
  readonly armedSeq: number
  readonly timeoutAt?: number
  readonly note?: string
  fiber?: Fiber.Fiber<void>
}

type Channel = {
  readonly directory: string
  entries: JournalEntry[]
  seq: number
  connections: number
  sessionID?: string
  seen: Map<string, { last: number; count: number }>
  digestTimes: number[]
  lastUserActivity: number
  suppressed: number
  logs: Live.DevLogLine[]
  logSeq: number
  burst?: ClickBurst
  triggers: Triggers
  fieldsMode?: string
  waits: ArmedWait[]
  waitSeq: number
  pending: Admission[]
  pendingFiber?: Fiber.Fiber<void>
}

type Match = {
  readonly trigger: string
  readonly severity: LiveDigest.Severity
  readonly summary: string
  readonly signature: string
}

// One event that cleared the per-event decision (matched a trigger, passed reseen dedup) and is a
// candidate issue for the batch's coalesced digest. The batch-level budget in `admitBatch` decides
// whether it actually wakes the agent.
type Admission = {
  readonly match: Match
  readonly event?: Live.Telemetry
  readonly backendLine?: Live.DevLogLine
  readonly occurrences: number
  readonly correlatedLogs: ReadonlyArray<Live.DevLogLine>
  readonly ts: number
}

export interface Interface {
  readonly ingest: (directory: string, batch: Live.IngestBatch) => Effect.Effect<void>
  readonly connect: (directory: string) => Effect.Effect<{ readonly disconnect: Effect.Effect<void> }>
  readonly read: (directory: string, input: ReadInput) => Effect.Effect<{ entries: JournalEntry[]; cursor: number }>
  readonly bind: (directory: string, sessionID: string) => Effect.Effect<void>
  readonly unbind: (directory: string) => Effect.Effect<void>
  readonly configure: (directory: string, triggers: Partial<Triggers>) => Effect.Effect<void>
  // The injected-snippet field-capture mode ("nonsensitive" | "none"), set at session start and
  // read by the context-free inject route. undefined means the snippet's default ("nonsensitive").
  readonly setFieldsMode: (directory: string, mode: string | undefined) => Effect.Effect<void>
  readonly fieldsMode: (directory: string) => Effect.Effect<string | undefined>
  readonly noteUserActivity: (sessionID: string) => Effect.Effect<void>
  readonly status: (directory: string) => Effect.Effect<Live.Status>
  readonly digests: () => Stream.Stream<LiveDigest.Digest>
  // Replaces the channel's entire armed-wait set (waits: [] cancels everything). Wakes bypass the
  // digest throttles entirely and fire on their own stream.
  readonly arm: (directory: string, input: ArmInput) => Effect.Effect<ReadonlyArray<Live.WaitInfo>>
  readonly wakes: () => Stream.Stream<LiveWake.Wake>
  readonly appendLog: (directory: string, lines: ReadonlyArray<Live.DevLogLine>) => Effect.Effect<void>
  readonly readLogs: (
    directory: string,
    input: ReadLogsInput,
  ) => Effect.Effect<{ lines: Live.DevLogLine[]; cursor: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LiveGateway") {}

function matchEvent(event: Live.Telemetry, triggers: Triggers): Match | undefined {
  const signature = LiveSignature.signatureFor(event)
  if (!signature) return undefined
  if (event.kind === "error")
    return {
      trigger: "uncaught_exception",
      severity: "error",
      summary: `${event.origin === "unhandledrejection" ? "Unhandled rejection" : "Uncaught error"}: ${event.message.slice(0, 300)}`,
      signature,
    }
  if (event.kind === "console" && event.level === "error")
    return {
      trigger: "console_error_first_seen",
      severity: "error",
      summary: `New console.error: ${event.message.slice(0, 300)}`,
      signature,
    }
  if (event.kind === "console" && event.level === "warn" && triggers.consoleWarn)
    return {
      trigger: "console_warn_first_seen",
      severity: "warning",
      summary: `New console.warn: ${event.message.slice(0, 300)}`,
      signature,
    }
  if (event.kind === "network") {
    if (event.status === 0 && triggers.networkFailures)
      return {
        trigger: "network_failure",
        severity: "error",
        summary: `${event.method} ${event.requestUrl} failed (blocked, CORS, or offline)`,
        signature,
      }
    const appOwned = triggers.crossOriginDev
      ? LiveSignature.appOwned(event.requestUrl, event.url)
      : LiveSignature.sameOrigin(event.requestUrl, event.url)
    if (event.status >= 400 && appOwned)
      return {
        trigger: "same_origin_http_error",
        severity: event.status >= 500 ? "error" : "warning",
        summary: `${event.method} ${event.requestUrl} responded ${event.status}`,
        signature,
      }
  }
  return undefined
}

function admissionIssue(admission: Admission): LiveDigest.Issue {
  return {
    trigger: admission.match.trigger,
    severity: admission.match.severity,
    summary: admission.match.summary,
    event: admission.event,
    backendLine: admission.backendLine,
    ts: admission.ts,
    occurrences: admission.occurrences,
    correlatedLogs: admission.correlatedLogs,
  }
}

// Identity for outcome dedup. Journal-derived and pending-derived issues that describe the same
// telemetry share an event/log object reference; backend/synthetic issues fall back to a value key.
function issueKey(issue: LiveDigest.Issue): unknown {
  return issue.event ?? issue.backendLine ?? `${issue.trigger}:${issue.summary}:${issue.ts}`
}

// Builds the wake's <outcome>: the problems observed since the wait was armed plus recent user
// actions. Browser events are selected by journal sequence (clock-independent); dev-server logs are
// server-timestamped like armedAt and selected by time. `matchedEvents` (the wait's own trigger
// hits) are excluded so the wake never shows one event as both cause and outcome. `extra` carries
// digest admissions drained from the pending buffer — including any held before this wait was armed,
// which the sequence window would otherwise miss. matchEvent is pure here: unlike the digest path it
// does not touch the reseen-signature bookkeeping.
function outcomeFor(
  channel: Channel,
  wait: ArmedWait,
  matchedEvents: ReadonlyArray<Live.Telemetry>,
  extra: ReadonlyArray<LiveDigest.Issue>,
): LiveWake.Outcome {
  const eventIssues = channel.entries.flatMap((entry) => {
    if (entry.seq <= wait.armedSeq) return []
    if (matchedEvents.includes(entry.event)) return []
    const match = matchEvent(entry.event, channel.triggers)
    if (!match) return []
    return [
      {
        trigger: match.trigger,
        severity: match.severity,
        summary: match.summary,
        event: entry.event,
        ts: entry.event.ts,
        occurrences: 1,
        correlatedLogs: channel.logs
          .filter((log) => Math.abs(log.ts - entry.event.ts) <= LOG_CORRELATION_MS)
          .slice(-LOG_CORRELATION_MAX),
      } satisfies LiveDigest.Issue,
    ]
  })
  const logIssues = channel.triggers.backendErrors
    ? channel.logs.flatMap((line) =>
        line.ts >= wait.armedAt && line.stream === "stderr" && BACKEND_ERROR.test(line.line)
          ? [
              {
                trigger: "backend_error",
                severity: "error",
                summary: line.line.slice(0, 300),
                backendLine: line,
                ts: line.ts,
                occurrences: 1,
                correlatedLogs: [],
              } satisfies LiveDigest.Issue,
            ]
          : [],
      )
    : []
  const seen = new Set<unknown>()
  const issues = [...eventIssues, ...logIssues, ...extra]
    .sort((a, b) => a.ts - b.ts)
    .filter((issue) => {
      const key = issueKey(issue)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(-OUTCOME_ISSUES_MAX)
  const recentActions = channel.entries
    .filter(
      (entry) => entry.event.kind === "navigation" || entry.event.kind === "click" || entry.event.kind === "input",
    )
    .slice(-RECENT_ACTIONS)
    .map((entry) => entry.event)
  return { issues, recentActions }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const pubsub = yield* PubSub.unbounded<LiveDigest.Digest>()
    const wakePubsub = yield* PubSub.unbounded<LiveWake.Wake>()
    // Timeout fibers for armed waits are forked into the layer's own scope so they die with the
    // gateway instead of leaking (same idiom as BackgroundJob).
    const scope = yield* Scope.Scope
    const channels = new Map<string, Channel>()

    function channelFor(raw: string) {
      const directory = normalizeDirectory(raw)
      const existing = channels.get(directory)
      if (existing) return existing
      const created: Channel = {
        directory,
        entries: [],
        seq: 0,
        connections: 0,
        seen: new Map(),
        digestTimes: [],
        lastUserActivity: 0,
        suppressed: 0,
        logs: [],
        logSeq: 0,
        triggers: DEFAULT_TRIGGERS,
        waits: [],
        waitSeq: 0,
        pending: [],
      }
      channels.set(directory, created)
      return created
    }

    function waitInfo(wait: ArmedWait): Live.WaitInfo {
      return {
        id: wait.id,
        description: wait.spec.description,
        armedAt: wait.armedAt,
        timeoutAt: wait.timeoutAt,
      }
    }

    function statusOf(channel: Channel): Live.Status {
      return {
        directory: channel.directory,
        connected: channel.connections > 0,
        buffered: channel.entries.length,
        sessionID: channel.sessionID,
        lastDigest: channel.digestTimes.at(-1),
        waits: channel.waits.map(waitInfo),
      }
    }

    const publishStatus = (channel: Channel) => events.publish(Live.Event.StatusUpdated, { status: statusOf(channel) })

    // A rage burst dedupes itself (one digest per burst, re-armed after a quiet gap), so it
    // bypasses the first-seen signature map that gates the other triggers.
    function matchRage(channel: Channel, event: Live.Telemetry): Match | undefined {
      if (event.kind === "navigation") {
        channel.burst = undefined
        return undefined
      }
      if (event.kind !== "click") return undefined
      const burst = channel.burst
      if (!burst || burst.selector !== event.selector || event.ts - (burst.times.at(-1) ?? 0) > RAGE_REARM_MS) {
        channel.burst = { selector: event.selector, times: [event.ts], fired: false }
        return undefined
      }
      burst.times.push(event.ts)
      burst.times = burst.times.filter((ts) => event.ts - ts <= RAGE_WINDOW_MS)
      if (burst.times.length < RAGE_CLICKS) return undefined
      if (burst.fired) return undefined
      burst.fired = true
      return {
        trigger: "rage_clicks",
        severity: "warning",
        summary: `Repeated rapid clicks on ${event.selector} — the UI may not be responding`,
        signature: `rage ${event.selector}`,
      }
    }

    // Per-event decision: signature re-seen suppression and bookkeeping. Returns a candidate
    // Admission when the event is a fresh distinct issue, or undefined when it is a same-signature
    // repeat within RESEEN_MS. Two identical signatures in one batch still dedupe here because they
    // share `now` (now - seen.last = 0 < RESEEN_MS). Budgeting happens later in admitBatch.
    function decide(
      channel: Channel,
      match: Match,
      now: number,
      item: {
        event?: Live.Telemetry
        backendLine?: Live.DevLogLine
        ts: number
        correlatedLogs: ReadonlyArray<Live.DevLogLine>
      },
    ): Admission | undefined {
      if (match.trigger !== "rage_clicks") {
        const seen = channel.seen.get(match.signature)
        channel.seen.set(match.signature, { last: now, count: (seen?.count ?? 0) + 1 })
        if (seen && now - seen.last < RESEEN_MS) return undefined
      }
      return {
        match,
        event: item.event,
        backendLine: item.backendLine,
        occurrences: channel.seen.get(match.signature)?.count ?? 1,
        correlatedLogs: item.correlatedLogs,
        ts: item.ts,
      }
    }

    // Batch-level gate: session binding plus the digest budget. Coalesces every admitted issue from
    // one ingest/appendLog call into a single digest so the agent wakes once and sees all problems
    // from the interaction together. Distinct signatures no longer suppress each other; RESEEN_MS
    // (same-signature) and DIGEST_WINDOW_MAX (wakes per window) remain the throttles. The
    // user-quiet hold lives in `deliver`, not here — by the time admitBatch runs the batch is
    // cleared to fire (or is a pending flush whose quiet window already expired).
    function admitBatch(
      channel: Channel,
      admissions: ReadonlyArray<Admission>,
      now: number,
    ): LiveDigest.Digest | undefined {
      if (admissions.length === 0) return undefined
      if (!channel.sessionID) return undefined

      const inWindow = channel.digestTimes.filter((ts) => now - ts < DIGEST_WINDOW_MS)
      channel.digestTimes = inWindow
      if (inWindow.length >= DIGEST_WINDOW_MAX) {
        channel.suppressed += admissions.length
        return undefined
      }

      const recentActions = channel.entries
        .filter(
          (entry) => entry.event.kind === "navigation" || entry.event.kind === "click" || entry.event.kind === "input",
        )
        .slice(-RECENT_ACTIONS)
        .map((entry) => entry.event)
      const shown = admissions.slice(0, ISSUES_PER_DIGEST)
      const suppressed = channel.suppressed + (admissions.length - shown.length)
      channel.suppressed = 0
      channel.digestTimes.push(now)
      const severity: LiveDigest.Severity = shown.some((admission) => admission.match.severity === "error")
        ? "error"
        : "warning"
      return {
        directory: channel.directory,
        sessionID: channel.sessionID,
        trigger: shown.length === 1 ? shown[0].match.trigger : "multiple",
        severity,
        summary: shown.length === 1 ? shown[0].match.summary : `${shown.length} issues observed`,
        ts: now,
        text: LiveDigest.render({
          issues: shown.map((admission) => ({
            trigger: admission.match.trigger,
            severity: admission.match.severity,
            summary: admission.match.summary,
            event: admission.event,
            backendLine: admission.backendLine,
            occurrences: admission.occurrences,
            correlatedLogs: admission.correlatedLogs,
            ts: admission.ts,
          })),
          ts: now,
          suppressed,
          recentActions,
        }),
      }
    }

    // Evaluates one browser telemetry event against the trigger rules. Journaling and signature
    // bookkeeping always happen; an Admission comes back only when the event is a fresh distinct issue.
    function evaluate(channel: Channel, event: Live.Telemetry, now: number): Admission | undefined {
      channel.seq += 1
      channel.entries.push({ seq: channel.seq, event })
      if (channel.entries.length > JOURNAL_LIMIT) channel.entries.splice(0, channel.entries.length - JOURNAL_LIMIT)

      const match = matchEvent(event, channel.triggers) ?? matchRage(channel, event)
      if (!match) return undefined

      return decide(channel, match, now, {
        event,
        ts: event.ts,
        correlatedLogs: channel.logs
          .filter((log) => Math.abs(log.ts - event.ts) <= LOG_CORRELATION_MS)
          .slice(-LOG_CORRELATION_MAX),
      })
    }

    // Evaluates one dev-server log line. Only pattern-matched stderr lines wake the agent; the line
    // is already buffered by appendLog before this runs.
    function evaluateLog(channel: Channel, line: Live.DevLogLine, now: number): Admission | undefined {
      if (!channel.triggers.backendErrors) return undefined
      if (line.stream !== "stderr") return undefined
      if (!BACKEND_ERROR.test(line.line)) return undefined
      const match: Match = {
        trigger: "backend_error",
        severity: "error",
        summary: line.line.slice(0, 300),
        signature: `backend ${LiveSignature.normalize(line.line)}`,
      }
      return decide(channel, match, now, {
        backendLine: line,
        ts: line.ts,
        correlatedLogs: channel.logs
          .filter((log) => log !== line && Math.abs(log.ts - line.ts) <= LOG_CORRELATION_MS)
          .slice(-LOG_CORRELATION_MAX),
      })
    }

    const publishDigest = Effect.fn("LiveGateway.publishDigest")(function* (digest: LiveDigest.Digest) {
      yield* PubSub.publish(pubsub, digest)
      yield* events.publish(Live.Event.DigestFired, {
        directory: digest.directory,
        sessionID: digest.sessionID,
        trigger: digest.trigger,
        summary: digest.summary,
        ts: digest.ts,
      })
      yield* publishStatus(channelFor(digest.directory))
    })

    // Flushes the pending buffer once the user-quiet window has expired. The sleep is armed
    // against the activity timestamp observed before sleeping: if the user speaks again while we
    // sleep, the loop re-arms for the new window instead of re-reading the wall clock, so the
    // flush cannot starve on clock skew and stays deterministic under TestClock.
    const drainPending = Effect.fn("LiveGateway.drainPending")(function* (channel: Channel) {
      while (channel.pending.length > 0) {
        const armedActivity = channel.lastUserActivity
        yield* Effect.sleep(Math.max(0, armedActivity + USER_QUIET_MS - Date.now()))
        if (channel.lastUserActivity > armedActivity) continue
        const pending = channel.pending
        channel.pending = []
        const digest = admitBatch(channel, pending, Date.now())
        if (digest) yield* publishDigest(digest)
      }
      channel.pendingFiber = undefined
    })

    // The single delivery path for admitted issues from both ingest and appendLog. Inside the
    // user-quiet window (or while a flush is already queued, to keep coalescing) admissions are
    // held in the pending buffer instead of dropped; overflow beyond PENDING_LIMIT rolls into the
    // suppressed count like before.
    const deliver = Effect.fn("LiveGateway.deliver")(function* (
      channel: Channel,
      admissions: ReadonlyArray<Admission>,
      now: number,
    ) {
      if (admissions.length === 0) return
      if (!channel.sessionID) return
      const quiet = now - channel.lastUserActivity < USER_QUIET_MS
      if (quiet || channel.pending.length > 0) {
        const merged = [...channel.pending, ...admissions]
        channel.suppressed += Math.max(0, merged.length - PENDING_LIMIT)
        channel.pending = merged.slice(-PENDING_LIMIT)
        if (channel.pendingFiber) return
        channel.pendingFiber = yield* drainPending(channel).pipe(Effect.forkIn(scope))
        return
      }
      const digest = admitBatch(channel, admissions, now)
      if (digest) yield* publishDigest(digest)
    })

    const clearPending = Effect.fn("LiveGateway.clearPending")(function* (channel: Channel) {
      const fiber = channel.pendingFiber
      channel.pending = []
      channel.pendingFiber = undefined
      if (fiber) yield* Fiber.interrupt(fiber)
    })

    const clearWaits = Effect.fn("LiveGateway.clearWaits")(function* (channel: Channel) {
      const waits = channel.waits
      channel.waits = []
      yield* Effect.forEach(waits, (wait) => (wait.fiber ? Fiber.interrupt(wait.fiber) : Effect.void), {
        discard: true,
      })
    })

    const publishWake = Effect.fn("LiveGateway.publishWake")(function* (wake: LiveWake.Wake) {
      yield* PubSub.publish(wakePubsub, wake)
      yield* events.publish(Live.Event.WaitFired, {
        directory: wake.directory,
        sessionID: wake.sessionID,
        waitID: wake.waitID,
        description: wake.description,
        timedOut: wake.timedOut,
        ts: wake.ts,
      })
      yield* publishStatus(channelFor(wake.directory))
    })

    // Runs in a forked timeout fiber. A wait already gone means the match path (or a re-arm)
    // removed it first — the single-threaded runtime makes the interrupt-vs-fire race safe.
    const fireTimeout = Effect.fn("LiveGateway.fireTimeout")(function* (channel: Channel, waitID: string) {
      const wait = channel.waits.find((candidate) => candidate.id === waitID)
      if (!wait) return
      channel.waits = channel.waits.filter((candidate) => candidate.id !== waitID)
      const sessionID = channel.sessionID
      if (!sessionID) return
      const now = Date.now()
      // The awaited event never happened, so <outcome> is the only signal of what did — surface any
      // held digest backlog and every problem seen since arming instead of an empty timeout.
      const pendingIssues = channel.pending.map(admissionIssue)
      yield* clearPending(channel)
      const outcome = outcomeFor(channel, wait, [], pendingIssues)
      yield* publishWake({
        directory: channel.directory,
        sessionID,
        waitID: wait.id,
        description: wait.spec.description,
        note: wait.note,
        timedOut: true,
        armedAt: wait.armedAt,
        ts: now,
        matched: [],
        outcome,
        text: LiveWake.render({
          description: wait.spec.description,
          note: wait.note,
          timedOut: true,
          armedAt: wait.armedAt,
          ts: now,
          matched: [],
          outcome,
        }),
      })
    })

    // Evaluates one ingest/appendLog batch against every armed wait, independent of the digest
    // throttle pipeline: agent-armed conditions always fire immediately. Each matched wait is
    // one-shot — it disarms itself and wakes once with every hit from the batch; other waits stay
    // armed and fire their own wakes.
    const fireMatches = Effect.fn("LiveGateway.fireMatches")(function* (
      channel: Channel,
      candidates: ReadonlyArray<LiveWake.Matched>,
      now: number,
    ) {
      const sessionID = channel.sessionID
      if (!sessionID) return
      if (channel.waits.length === 0) return
      const fired = channel.waits.flatMap((wait) => {
        if (!wait.spec.sources && !wait.regex) return []
        const hits = candidates.filter((candidate) => {
          const kind = candidate.event ? candidate.event.kind : "backend_log"
          if (wait.spec.sources && !wait.spec.sources.includes(kind)) return false
          if (!wait.regex) return true
          const line = candidate.event
            ? LiveWake.eventLine(candidate.event)
            : candidate.log
              ? LiveWake.logLine(candidate.log)
              : ""
          return wait.regex.test(line)
        })
        return hits.length > 0 ? [{ wait, hits }] : []
      })
      if (fired.length === 0) return
      channel.waits = channel.waits.filter((wait) => !fired.some((entry) => entry.wait === wait))
      yield* Effect.forEach(fired, (entry) => (entry.wait.fiber ? Fiber.interrupt(entry.wait.fiber) : Effect.void), {
        discard: true,
      })
      // A wake is already going to the agent, so deliver any held digest backlog through it now
      // rather than 15s later on a separate turn that would race this one. Draining once and folding
      // the same issues into each fired wake's outcome keeps the wake and digest views in sync.
      const pendingIssues = channel.pending.map(admissionIssue)
      yield* clearPending(channel)
      yield* Effect.forEach(
        fired,
        (entry) => {
          const matchedEvents = entry.hits.flatMap((hit) => (hit.event ? [hit.event] : []))
          const outcome = outcomeFor(channel, entry.wait, matchedEvents, pendingIssues)
          return publishWake({
            directory: channel.directory,
            sessionID,
            waitID: entry.wait.id,
            description: entry.wait.spec.description,
            note: entry.wait.note,
            timedOut: false,
            armedAt: entry.wait.armedAt,
            ts: now,
            matched: entry.hits,
            outcome,
            text: LiveWake.render({
              description: entry.wait.spec.description,
              note: entry.wait.note,
              timedOut: false,
              armedAt: entry.wait.armedAt,
              ts: now,
              matched: entry.hits,
              outcome,
            }),
          })
        },
        { discard: true },
      )
    })

    return Service.of({
      ingest: Effect.fn("LiveGateway.ingest")(function* (directory, batch) {
        const channel = channelFor(directory)
        const now = Date.now()
        const admissions = batch.events.flatMap((event) => {
          const admission = evaluate(channel, event, now)
          return admission ? [admission] : []
        })
        yield* deliver(channel, admissions, now)
        yield* fireMatches(
          channel,
          batch.events.map((event) => ({ event })),
          now,
        )
      }),
      connect: Effect.fn("LiveGateway.connect")(function* (directory) {
        const channel = channelFor(directory)
        channel.connections += 1
        yield* publishStatus(channel)
        return {
          disconnect: Effect.gen(function* () {
            channel.connections = Math.max(0, channel.connections - 1)
            yield* publishStatus(channel)
          }),
        }
      }),
      read: Effect.fn("LiveGateway.read")(function* (directory, input) {
        const channel = channelFor(directory)
        const limit = input.limit ?? 100
        const entries = channel.entries
          .filter((entry) => input.since === undefined || entry.seq > input.since)
          .filter((entry) => input.kind === undefined || entry.event.kind === input.kind)
          .slice(-limit)
        return { entries, cursor: channel.seq }
      }),
      bind: Effect.fn("LiveGateway.bind")(function* (directory, sessionID) {
        const channel = channelFor(directory)
        // Armed waits and held digests belong to the bound session; rebinding to a different one
        // discards them.
        if (channel.sessionID !== sessionID) {
          yield* clearWaits(channel)
          yield* clearPending(channel)
        }
        channel.sessionID = sessionID
        yield* publishStatus(channel)
      }),
      unbind: Effect.fn("LiveGateway.unbind")(function* (directory) {
        const channel = channelFor(directory)
        yield* clearWaits(channel)
        yield* clearPending(channel)
        channel.sessionID = undefined
        yield* publishStatus(channel)
      }),
      configure: Effect.fn("LiveGateway.configure")(function* (directory, triggers) {
        const channel = channelFor(directory)
        channel.triggers = { ...DEFAULT_TRIGGERS, ...triggers }
      }),
      setFieldsMode: Effect.fn("LiveGateway.setFieldsMode")(function* (directory, mode) {
        const channel = channelFor(directory)
        channel.fieldsMode = mode
      }),
      fieldsMode: Effect.fn("LiveGateway.fieldsMode")(function* (directory) {
        return channelFor(directory).fieldsMode
      }),
      noteUserActivity: Effect.fn("LiveGateway.noteUserActivity")(function* (sessionID) {
        const channel = [...channels.values()].find((candidate) => candidate.sessionID === sessionID)
        if (!channel) return
        channel.lastUserActivity = Date.now()
      }),
      status: Effect.fn("LiveGateway.status")(function* (directory) {
        return statusOf(channelFor(directory))
      }),
      digests: () => Stream.fromPubSub(pubsub),
      arm: Effect.fn("LiveGateway.arm")(function* (directory, input) {
        const channel = channelFor(directory)
        yield* clearWaits(channel)
        const now = Date.now()
        const armed = input.waits.map((spec): ArmedWait => {
          channel.waitSeq += 1
          return {
            id: `wait_${channel.waitSeq}`,
            spec,
            regex: spec.pattern === undefined ? undefined : new RegExp(spec.pattern, "i"),
            armedAt: now,
            armedSeq: channel.seq,
            timeoutAt: spec.timeoutSeconds === undefined ? undefined : now + spec.timeoutSeconds * 1000,
            note: input.note,
          }
        })
        channel.waits = armed
        yield* Effect.forEach(
          armed,
          (wait) =>
            wait.timeoutAt === undefined
              ? Effect.void
              : Effect.sleep(wait.timeoutAt - now).pipe(
                  Effect.andThen(fireTimeout(channel, wait.id)),
                  Effect.forkIn(scope),
                  Effect.map((fiber) => {
                    wait.fiber = fiber
                  }),
                ),
          { discard: true },
        )
        const infos = armed.map(waitInfo)
        yield* events.publish(Live.Event.WaitArmed, {
          directory: channel.directory,
          sessionID: input.sessionID,
          waits: infos,
        })
        yield* publishStatus(channel)
        return infos
      }),
      wakes: () => Stream.fromPubSub(wakePubsub),
      appendLog: Effect.fn("LiveGateway.appendLog")(function* (directory, lines) {
        const channel = channelFor(directory)
        const now = Date.now()
        channel.logSeq += lines.length
        channel.logs.push(...lines)
        if (channel.logs.length > LOG_LIMIT) channel.logs.splice(0, channel.logs.length - LOG_LIMIT)
        const admissions = lines.flatMap((line) => {
          const admission = evaluateLog(channel, line, now)
          return admission ? [admission] : []
        })
        yield* deliver(channel, admissions, now)
        // Unlike the backend_error digest trigger, armed waits match stdout and stderr both.
        yield* fireMatches(
          channel,
          lines.map((log) => ({ log })),
          now,
        )
      }),
      readLogs: Effect.fn("LiveGateway.readLogs")(function* (directory, input) {
        const channel = channelFor(directory)
        const retainedFrom =
          input.since === undefined ? 0 : Math.max(0, channel.logs.length - Math.max(0, channel.logSeq - input.since))
        const limit = input.limit ?? 100
        const lines = channel.logs
          .slice(retainedFrom)
          .filter((log) => !input.grep || log.line.toLowerCase().includes(input.grep.toLowerCase()))
          .slice(-limit)
        return { lines, cursor: channel.logSeq }
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node] })
