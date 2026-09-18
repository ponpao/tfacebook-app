// ---------------------------------------------------------------------------
// AutoShutdownDialog.tsx  — 60-second cancellable countdown shown after a
// login-queue run finishes, when General Settings' "Auto Shutdown PC after
// queue completes" is enabled. Confirming does nothing extra (the real OS
// shutdown was already scheduled the moment this dialog opened, matching
// `shutdown /s /t 60`'s own grace period) — Cancel is the only action that
// changes anything, calling cancelShutdown() to abort it.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { PowerOff } from 'lucide-react'

const COUNTDOWN_SECONDS = 60

export function AutoShutdownDialog({
  open,
  onCancelled
}: {
  open: boolean
  /** Called once the user cancels — the parent should just close this dialog; the shutdown itself is already cancelled by the time this fires. */
  onCancelled: () => void
}): React.JSX.Element | null {
  const [secondsLeft, setSecondsLeft] = useState(COUNTDOWN_SECONDS)

  useEffect(() => {
    if (!open) return
    setSecondsLeft(COUNTDOWN_SECONDS)
    void window.api.system.scheduleShutdown(COUNTDOWN_SECONDS)
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1))
    }, 1000)
    return () => clearInterval(interval)
  }, [open])

  if (!open) return null

  const cancel = (): void => {
    void window.api.system.cancelShutdown()
    onCancelled()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6">
      <div className="flex w-full max-w-sm flex-col overflow-hidden rounded-xl border border-edge border-t-4 border-t-accent bg-surface">
        <div className="flex items-center gap-2 border-b border-edge bg-surface-sunken px-4 py-2">
          <PowerOff size={16} className="text-[#c81e1e]" />
          <h2 className="text-[13px] font-semibold text-ink">Auto Shutdown</h2>
        </div>

        <div className="flex flex-col items-center gap-3 p-5 text-center">
          <p className="text-[12px] text-ink">
            The queue has finished. This PC will shut down in:
          </p>
          <div className="text-3xl font-bold tabular-nums text-[#c81e1e]">{secondsLeft}s</div>
          <p className="text-[11px] text-ink-muted">Cancel to keep this PC running.</p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-edge bg-surface px-4 py-2.5">
          <button className="win-btn-accent" onClick={cancel}>
            Cancel Shutdown
          </button>
        </div>
      </div>
    </div>
  )
}
