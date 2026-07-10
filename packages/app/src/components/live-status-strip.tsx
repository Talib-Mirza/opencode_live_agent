import type { LiveStatus } from "@opencode-ai/sdk/v2/client"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import type { ServerConnection } from "@/context/server"

function digestAgeLabel(language: ReturnType<typeof useLanguage>, elapsedMs: number) {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000))
  if (seconds < 60) return language.t("session.live.digest.seconds", { count: seconds })
  return language.t("session.live.digest.minutes", { count: Math.floor(seconds / 60) })
}

// Renders a small connection badge for a live session (metadata.live). Always resolves the SDK
// and event stream from the owning tab's own server connection (global.ensureServerCtx), never
// from the ambient/current server, so the badge stays correct even if this session isn't the
// foreground tab.
export function LiveStatusStrip(props: { server: ServerConnection.Any; directory: string; sessionId: string }) {
  const global = useGlobal()
  const language = useLanguage()
  const dirSdk = global.ensureServerCtx(props.server).sdk.ensureDirSdkContext(props.directory)

  const relevant = (status: LiveStatus) => status.sessionID === props.sessionId || status.directory === props.directory

  const [status, setStatus] = createSignal<LiveStatus>()

  void dirSdk.client.live
    .status({ directory: props.directory })
    .then((res) => {
      if (res.data && relevant(res.data)) setStatus(res.data)
    })
    .catch(() => {})

  onCleanup(
    dirSdk.event.on("live.status.updated", (event) => {
      if (!relevant(event.properties.status)) return
      setStatus(event.properties.status)
    }),
  )

  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const digestLabel = createMemo(() => {
    const lastDigest = status()?.lastDigest
    if (!lastDigest) return
    return digestAgeLabel(language, now() - lastDigest)
  })

  // Wake conditions the agent armed via live_wait — surfaced so the user can see exactly what
  // the agent is waiting for.
  const waitLabel = createMemo(() => {
    const waits = status()?.waits ?? []
    if (waits.length === 0) return
    if (waits.length === 1) return language.t("session.live.waiting", { description: waits[0].description })
    return language.t("session.live.waiting.more", { description: waits[0].description, count: waits.length - 1 })
  })

  const waitTitle = createMemo(() => {
    const waits = status()?.waits ?? []
    if (waits.length === 0) return
    return waits.map((wait) => wait.description).join("\n")
  })

  const [stopping, setStopping] = createSignal(false)

  const stop = () => {
    setStopping(true)
    dirSdk.client.live
      .stop({ directory: props.directory })
      .then((res) => {
        if (res.data) setStatus(res.data)
      })
      .catch(() => {})
      .finally(() => setStopping(false))
  }

  return (
    <div
      data-component="live-status-strip"
      class="flex shrink-0 items-center gap-1.5 rounded-md border border-border-weak-base bg-surface-panel px-2 h-6 text-12-regular text-text-weak"
    >
      <span
        aria-hidden="true"
        class="size-1.5 shrink-0 rounded-full"
        classList={{
          "bg-icon-success-base": !!status()?.connected,
          "bg-border-weak-base": !status()?.connected,
        }}
      />
      <span class="text-text-strong">{language.t("session.live.label")}</span>
      <Show when={status()?.buffered}>
        {(buffered) => <span>{language.t("session.live.buffered", { count: buffered() })}</span>}
      </Show>
      <Show when={digestLabel()}>{(label) => <span>{label()}</span>}</Show>
      <Show when={waitLabel()}>
        {(label) => (
          <span class="max-w-48 truncate" title={waitTitle()}>
            {label()}
          </span>
        )}
      </Show>
      <Show when={status()?.sessionID}>
        <IconButtonV2
          type="button"
          size="small"
          variant="ghost-muted"
          disabled={stopping()}
          onClick={stop}
          aria-label={language.t("session.live.stop")}
          icon={<IconV2 name="xmark-small" />}
        />
      </Show>
    </div>
  )
}
