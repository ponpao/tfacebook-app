// ---------------------------------------------------------------------------
// UpdateNotificationModal.tsx  — auto-opens when the main process reports an
// available update. Owns its own subscription to the updater IPC events
// (mounted once in App.tsx) rather than being opened/closed by a parent —
// there's no "open" trigger other than the update-available event itself
// (plus the manual "Check for Updates" button in Help & About, which shares
// the same event stream).
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { ModalShell } from './ModalShell'
import type {
  UpdateAvailableInfo,
  DownloadProgressInfo,
  UpdateDownloadedInfo,
  UpdaterErrorInfo
} from '../../../types/ipc'

type Phase = 'available' | 'downloading' | 'downloaded'

export function UpdateNotificationModal(): React.JSX.Element | null {
  const [info, setInfo] = useState<UpdateAvailableInfo | null>(null)
  const [phase, setPhase] = useState<Phase>('available')
  const [progress, setProgress] = useState<DownloadProgressInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const offAvailable = window.api.updater.onUpdateAvailable((payload: UpdateAvailableInfo) => {
      setInfo(payload)
      setPhase('available')
      setProgress(null)
      setError(null)
      setDismissed(false)
    })
    const offProgress = window.api.updater.onDownloadProgress((payload: DownloadProgressInfo) => {
      setPhase('downloading')
      setProgress(payload)
    })
    const offDownloaded = window.api.updater.onUpdateDownloaded((_payload: UpdateDownloadedInfo) => {
      setPhase('downloaded')
      setProgress(null)
    })
    const offError = window.api.updater.onError((payload: UpdaterErrorInfo) => {
      setError(payload.message)
    })
    return () => {
      offAvailable()
      offProgress()
      offDownloaded()
      offError()
    }
  }, [])

  if (!info || dismissed) return null

  const startDownload = async (): Promise<void> => {
    setError(null)
    setPhase('downloading')
    setProgress({ percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
    const res = await window.api.updater.startDownload()
    if (!res.ok) setError(res.error ?? 'Download failed')
  }

  const restartAndInstall = (): void => {
    void window.api.updater.quitAndInstall()
  }

  return (
    <ModalShell
      open
      onClose={() => setDismissed(true)}
      title="Update Available"
      icon={RefreshCw}
      width="max-w-md"
      footer={
        phase === 'downloaded' ? (
          <button className="win-btn-accent" onClick={restartAndInstall}>
            🔄 Restart &amp; Update Now
          </button>
        ) : phase === 'downloading' ? (
          <button className="win-btn" disabled>
            Downloading…
          </button>
        ) : (
          <>
            <button className="win-btn" onClick={() => setDismissed(true)}>
              ⏳ Skip / Later
            </button>
            <button className="win-btn-accent" onClick={() => void startDownload()}>
              🚀 Update Now
            </button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3 text-[12px]">
        <div>
          <span className="font-medium text-slate-700">New version:</span>{' '}
          <span className="font-mono">{info.version}</span>
        </div>

        {info.releaseNotes && (
          <div className="flex flex-col gap-1">
            <span className="font-medium text-slate-700">Release notes</span>
            <div
              className="max-h-40 overflow-auto rounded border border-slate-300 bg-white p-2 text-[11px] text-slate-700"
              // Release notes come from the update feed's own metadata, not
              // user input — rendered as plain text (not HTML) to be safe
              // regardless of what a given publish provider puts there.
            >
              {info.releaseNotes}
            </div>
          </div>
        )}

        {phase === 'downloading' && progress && (
          <div className="flex flex-col gap-1">
            <div className="h-3 w-full overflow-hidden rounded border border-slate-300 bg-white">
              <div
                className="h-full bg-[#0078d4] transition-[width]"
                style={{ width: `${Math.round(progress.percent)}%` }}
              />
            </div>
            <span className="text-[11px] text-slate-500">{Math.round(progress.percent)}%</span>
          </div>
        )}

        {phase === 'downloaded' && (
          <p className="text-[11px] text-emerald-700">
            Update downloaded — restart to finish installing.
          </p>
        )}

        {error && <p className="text-[11px] text-[#c81e1e]">Error: {error}</p>}
      </div>
    </ModalShell>
  )
}
