import type { LiveJournalEntry, LiveTelemetry } from "@opencode-ai/sdk/v2/client"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import type { ServerConnection } from "@/context/server"

const MAX_ENTRIES = 500
const INITIAL_LIMIT = 200
const BOTTOM_THRESHOLD = 24

function formatTime(ts: number) {
  const date = new Date(ts)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function kindLabel(event: LiveTelemetry) {
  if (event.kind === "navigation") return "nav"
  return event.kind
}

function isDanger(event: LiveTelemetry) {
  if (event.kind === "error") return true
  return event.kind === "console" && event.level === "error"
}

function summarize(event: LiveTelemetry) {
  if (event.kind === "navigation") return `→ ${event.url}`
  if (event.kind === "click") return event.text ? `click ${event.selector} "${event.text}"` : `click ${event.selector}`
  if (event.kind === "console") return `console.${event.level} ${event.message}`
  if (event.kind === "network") {
    const duration = event.durationMs !== undefined ? ` (${event.durationMs}ms)` : ""
    return `${event.method} ${event.requestUrl} ${event.status}${duration}`
  }
  if (event.kind === "input")
    return `${event.trigger === "submit" ? "submit" : "field"} ${event.fields.length === 1 ? "1 field" : `${event.fields.length} fields`}`
  return event.message
}

// Feed of captured browser telemetry for a live session (metadata.live), oldest to newest.
// Always resolves the SDK and event stream from the owning tab's own server connection
// (global.ensureServerCtx), never from the ambient/current server, matching LiveStatusStrip.
export function LiveBrowserTab(props: { server: ServerConnection.Any; directory: string; sessionId: string }) {
  const global = useGlobal()
  const language = useLanguage()
  const dirSdk = global.ensureServerCtx(props.server).sdk.ensureDirSdkContext(props.directory)

  const relevant = (event: { sessionID?: string; directory: string }) =>
    event.sessionID === props.sessionId || event.directory === props.directory

  const [entries, setEntries] = createSignal<LiveJournalEntry[]>([])
  let cursor = 0
  let scrollRef: HTMLDivElement | undefined
  let stickToBottom = true

  const isAtBottom = () => {
    if (!scrollRef) return true
    return scrollRef.scrollHeight - scrollRef.clientHeight - scrollRef.scrollTop < BOTTOM_THRESHOLD
  }

  const append = (next: LiveJournalEntry[]) => {
    if (next.length === 0) return
    stickToBottom = isAtBottom()
    setEntries((prev) => {
      const merged = [...prev, ...next]
      return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged
    })
  }

  createEffect(() => {
    entries()
    if (!stickToBottom) return
    const el = scrollRef
    if (!el) return
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
  })

  const refresh = () => {
    dirSdk.client.live
      .journal({ directory: props.directory, since: String(cursor) })
      .then((res) => {
        if (!res.data) return
        cursor = res.data.cursor
        append(res.data.entries)
      })
      .catch(() => {})
  }

  void dirSdk.client.live
    .journal({ directory: props.directory, limit: String(INITIAL_LIMIT) })
    .then((res) => {
      if (!res.data) return
      cursor = res.data.cursor
      append(res.data.entries)
    })
    .catch(() => {})

  onCleanup(
    dirSdk.event.on("live.status.updated", (event) => {
      if (!relevant(event.properties.status)) return
      refresh()
    }),
  )

  onCleanup(
    dirSdk.event.on("live.digest.fired", (event) => {
      if (!relevant(event.properties)) return
      refresh()
    }),
  )

  return (
    <div data-component="live-browser-tab" class="h-full flex flex-col overflow-hidden">
      <Show
        when={entries().length > 0}
        fallback={
          <div class="h-full flex flex-col items-center justify-center text-center px-6">
            <div class="text-12-regular text-text-weak max-w-56">{language.t("session.live.browser.empty")}</div>
          </div>
        }
      >
        <div ref={scrollRef} class="flex-1 min-h-0 overflow-y-auto">
          <For each={entries()}>
            {(entry) => (
              <div class="flex items-start gap-2 px-3 py-1 text-12-regular border-b border-border-weaker-base">
                <span class="shrink-0 w-14 text-text-faint">{formatTime(entry.event.ts)}</span>
                <span class="shrink-0 w-16 uppercase text-11-medium text-text-weak">{kindLabel(entry.event)}</span>
                <span
                  class="min-w-0 flex-1 truncate"
                  classList={{
                    "text-icon-critical-base": isDanger(entry.event),
                    "text-text-base": !isDanger(entry.event),
                  }}
                >
                  {summarize(entry.event)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
