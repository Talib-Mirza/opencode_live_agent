import type { LiveStatus } from "@opencode-ai/sdk/v2/client"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import type { ServerConnection } from "@/context/server"

type Language = ReturnType<typeof useLanguage>

// A single diagnostic row: coloured dot + label. `state` drives the dot colour the same way the
// LiveStatusStrip badge does (success / warning / neutral), so the checklist reads at a glance.
function Check(props: { state: "ok" | "warn" | "off"; label: string; hint?: string }) {
  return (
    <div class="flex items-start gap-2.5 py-1">
      <span
        aria-hidden="true"
        class="mt-1.5 size-2 shrink-0 rounded-full"
        classList={{
          "bg-icon-success-base": props.state === "ok",
          "bg-icon-warning-base": props.state === "warn",
          "bg-border-weak-base": props.state === "off",
        }}
      />
      <div class="min-w-0">
        <div class="text-12-regular text-text-strong">{props.label}</div>
        <Show when={props.hint}>{(hint) => <div class="text-11-regular text-text-weak">{hint()}</div>}</Show>
      </div>
    </div>
  )
}

// Copy-to-clipboard button that briefly swaps to a check to confirm the copy landed.
function CopyButton(props: { language: Language; text: string }) {
  const [copied, setCopied] = createSignal(false)
  const copy = () => {
    void navigator.clipboard
      .writeText(props.text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <button
      type="button"
      onClick={copy}
      class="flex shrink-0 items-center gap-1 rounded-md border border-border-weak-base px-2 h-6 text-11-medium text-text-weak hover:text-text-strong"
    >
      <IconV2 name={copied() ? "check" : "outline-copy"} class="size-3" />
      {copied() ? props.language.t("session.live.setup.copied") : props.language.t("session.live.setup.copy")}
    </button>
  )
}

// A step with a monospace code snippet the user copies into their app or shell.
function CodeStep(props: { language: Language; label: string; code: string }) {
  return (
    <div class="flex flex-col gap-1.5">
      <div class="text-12-regular text-text-base">{props.label}</div>
      <div class="flex items-start gap-2">
        <pre class="min-w-0 flex-1 overflow-x-auto rounded-md bg-background-stronger px-2.5 py-2 font-mono text-11-regular text-text-strong">
          {props.code}
        </pre>
        <CopyButton language={props.language} text={props.code} />
      </div>
    </div>
  )
}

function TextStep(props: { label: string }) {
  return <div class="text-12-regular text-text-base">{props.label}</div>
}

// Setup/diagnostics view for a live session (metadata.live). Shows a connection checklist derived
// from the live status plus step-by-step instructions for both capture paths (injected script and
// Chrome DevTools Protocol). Resolves the SDK/event stream from the owning tab's server connection
// (global.ensureServerCtx), matching LiveStatusStrip and LiveBrowserTab.
export function LiveConnectionTab(props: { server: ServerConnection.Any; directory: string; sessionId: string }) {
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

  const serverUrl = createMemo(() => props.server.http.url.replace(/\/+$/, ""))
  const injectTag = createMemo(
    () => `<script src="${serverUrl()}/live/inject.js?directory=${encodeURIComponent(props.directory)}"></script>`,
  )
  const cdpLaunch = `open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.opencode-live-chrome"`
  const cdpConfig = `{
  "live": {
    "cdp": {
      "endpoint": "http://localhost:9222",
      "filter": "localhost"
    }
  }
}`

  const connected = () => !!status()?.connected
  const buffered = () => status()?.buffered ?? 0

  const overall = createMemo<{ state: "ok" | "warn" | "off"; label: string; hint: string }>(() => {
    if (connected() && buffered() > 0)
      return {
        state: "ok",
        label: language.t("session.live.setup.status.connected"),
        hint: language.t("session.live.setup.status.connectedHint"),
      }
    if (connected())
      return {
        state: "warn",
        label: language.t("session.live.setup.status.waiting"),
        hint: language.t("session.live.setup.status.waitingHint"),
      }
    return {
      state: "off",
      label: language.t("session.live.setup.status.disconnected"),
      hint: language.t("session.live.setup.status.disconnectedHint"),
    }
  })

  return (
    <div data-component="live-connection-tab" class="h-full overflow-y-auto">
      <div class="flex flex-col gap-5 px-4 py-4 max-w-[560px]">
        {/* Overall banner */}
        <div class="flex items-start gap-2.5 rounded-lg border border-border-weak-base bg-surface-panel px-3 py-2.5">
          <span
            aria-hidden="true"
            class="mt-1 size-2.5 shrink-0 rounded-full"
            classList={{
              "bg-icon-success-base": overall().state === "ok",
              "bg-icon-warning-base": overall().state === "warn",
              "bg-border-weak-base": overall().state === "off",
            }}
          />
          <div class="min-w-0">
            <div class="text-13-medium text-text-strong">{overall().label}</div>
            <div class="text-12-regular text-text-weak">{overall().hint}</div>
          </div>
        </div>

        {/* Checklist */}
        <div class="flex flex-col gap-0.5">
          <div class="text-11-medium uppercase tracking-wide text-text-faint pb-1">
            {language.t("session.live.setup.checklist")}
          </div>
          <Check
            state={status()?.sessionID ? "ok" : "off"}
            label={
              status()?.sessionID
                ? language.t("session.live.setup.check.session")
                : language.t("session.live.setup.check.sessionOff")
            }
          />
          <Check
            state={connected() ? "ok" : "off"}
            label={
              connected()
                ? language.t("session.live.setup.check.connected")
                : language.t("session.live.setup.check.connectedOff")
            }
          />
          <Check
            state={buffered() > 0 ? "ok" : connected() ? "warn" : "off"}
            label={
              buffered() > 0
                ? language.t("session.live.setup.check.eventsCount", { count: buffered() })
                : language.t("session.live.setup.check.eventsOff")
            }
          />
        </div>

        {/* Method A: injected script */}
        <div class="flex flex-col gap-3 rounded-lg border border-border-weaker-base p-3">
          <div>
            <div class="text-13-medium text-text-strong">{language.t("session.live.setup.method.inject.title")}</div>
            <div class="text-11-regular text-text-weak">{language.t("session.live.setup.method.inject.subtitle")}</div>
          </div>
          <CodeStep
            language={language}
            label={language.t("session.live.setup.method.inject.step1")}
            code={injectTag()}
          />
          <TextStep label={language.t("session.live.setup.method.inject.step2")} />
          <TextStep label={language.t("session.live.setup.method.inject.step3")} />
          <div class="text-11-regular text-text-faint">{language.t("session.live.setup.method.inject.note")}</div>
        </div>

        {/* Method B: CDP */}
        <div class="flex flex-col gap-3 rounded-lg border border-border-weaker-base p-3">
          <div>
            <div class="text-13-medium text-text-strong">{language.t("session.live.setup.method.cdp.title")}</div>
            <div class="text-11-regular text-text-weak">{language.t("session.live.setup.method.cdp.subtitle")}</div>
          </div>
          <CodeStep language={language} label={language.t("session.live.setup.method.cdp.step1")} code={cdpLaunch} />
          <CodeStep language={language} label={language.t("session.live.setup.method.cdp.step2")} code={cdpConfig} />
          <TextStep label={language.t("session.live.setup.method.cdp.step3")} />
          <div class="text-11-regular text-text-faint">{language.t("session.live.setup.method.cdp.note")}</div>
        </div>
      </div>
    </div>
  )
}
