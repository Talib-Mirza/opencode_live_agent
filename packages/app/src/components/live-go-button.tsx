import { Button } from "@opencode-ai/ui/button"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createSignal } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import type { ServerConnection } from "@/context/server"
import { errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"

// Titlebar "Go Live" control for a session that is not live yet: turns the session into the live
// session for its directory. Only one session per directory can be live, so if another session
// already holds the binding a confirmation dialog warns that continuing will stop it first. Once
// live, the server sets metadata.live and the header swaps this button for the LiveStatusStrip.
export function GoLiveButton(props: { server: ServerConnection.Any; directory: string; sessionId: string }) {
  const global = useGlobal()
  const language = useLanguage()
  const dialog = useDialog()
  const [busy, setBusy] = createSignal(false)

  const serverCtx = () => global.ensureServerCtx(props.server)
  const dirSdk = () => serverCtx().sdk.ensureDirSdkContext(props.directory)

  const boundSessionTitle = (sessionID: string) => {
    const [store] = serverCtx().sync.child(props.directory)
    return store.session?.find((session) => session.id === sessionID)?.title
  }

  const start = () => {
    setBusy(true)
    dirSdk()
      .client.live.start({ directory: props.directory, sessionID: props.sessionId })
      .then((res) => {
        if (!res.data) showToast({ title: language.t("common.requestFailed") })
      })
      .catch((err: unknown) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err, language.t("common.requestFailed")),
        }),
      )
      .finally(() => setBusy(false))
  }

  const goLive = () => {
    if (busy()) return
    setBusy(true)
    dirSdk()
      .client.live.status({ directory: props.directory })
      .then((res) => {
        const bound = res.data?.sessionID
        if (bound && bound !== props.sessionId) {
          setBusy(false)
          const title = boundSessionTitle(bound)
          dialog.show(() => <DialogGoLiveConfirm title={title} onConfirm={start} />)
          return
        }
        start()
      })
      .catch((err: unknown) => {
        setBusy(false)
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
      })
  }

  return (
    <ButtonV2
      data-action="session-go-live"
      variant="ghost-muted"
      size="normal"
      icon="monitor"
      class="h-6 px-2 shrink-0 [font-weight:530]"
      disabled={busy()}
      onClick={goLive}
    >
      {language.t("command.session.goLive")}
    </ButtonV2>
  )
}

function DialogGoLiveConfirm(props: { title?: string; onConfirm: () => void }) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog title={language.t("session.live.confirm.title")} class="w-full max-w-[420px] mx-auto">
      <div class="flex flex-col gap-6 p-6 pt-0">
        <p class="text-14-regular text-text-weak">
          {props.title
            ? language.t("session.live.confirm.body", { title: props.title })
            : language.t("session.live.confirm.body.unknown")}
        </p>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="large"
            onClick={() => {
              dialog.close()
              props.onConfirm()
            }}
          >
            {language.t("session.live.confirm.continue")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
