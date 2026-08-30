// ---------------------------------------------------------------------------
// WatchLiveModal.tsx  — configure and run Watch Live: open a livestream URL,
// stay on it for a set duration, and optionally drop one random comment.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { Video } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'

const DURATION_UNITS = [
  { value: 'seconds', label: 'Seconds', mult: 1 },
  { value: 'minutes', label: 'Minutes', mult: 60 }
] as const
type DurationUnit = (typeof DURATION_UNITS)[number]['value']

export function WatchLiveModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const selectedIds = useAccountStore((s) => s.selectedIds)
  const threadCount = useAccountStore((s) => s.threadCount)
  const showToast = useAccountStore((s) => s.showToast)
  const refresh = useAccountStore((s) => s.refresh)
  const withQueueRunning = useAccountStore((s) => s.withQueueRunning)
  const stopQueueRun = useAccountStore((s) => s.stopQueueRun)

  const [liveUrl, setLiveUrl] = useState('')
  const [duration, setDuration] = useState(3)
  const [durationUnit, setDurationUnit] = useState<DurationUnit>('minutes')
  const [commentsText, setCommentsText] = useState('')
  const [running, setRunning] = useState(false)

  const count = selectedIds().length
  const comments = commentsText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const unitMult = DURATION_UNITS.find((u) => u.value === durationUnit)?.mult ?? 1
  const watchSeconds = Math.max(1, Math.round(duration * unitMult))

  const run = async (): Promise<void> => {
    const ids = selectedIds()
    if (ids.length === 0) {
      showToast('Select at least one account first.')
      return
    }
    if (!liveUrl.trim()) {
      showToast('Enter a livestream URL.')
      return
    }
    onClose()
    showToast(`Watch Live: running on ${ids.length} account(s)…`)
    try {
      await withQueueRunning(async () => {
        const summary = await window.api.automation.runWatchLive({
          accountIds: ids,
          concurrency: threadCount,
          liveUrl: liveUrl.trim(),
          watchSeconds,
          comments: comments.length > 0 ? comments : undefined
        })
        showToast(
          `Watch Live done: ${summary.succeeded}/${summary.total} succeeded, ${summary.failed} failed.`,
          6000
        )
      })
    } finally {
      await refresh()
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={() => {
        if (running) {
          void stopQueueRun()
        }
        onClose()
      }}
      title="Watch Live"
      icon={Video}
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">
            {count} account(s) selected · {threadCount} thread(s)
          </span>
          <button
            className="win-btn"
            onClick={() => {
              if (running) {
                void stopQueueRun()
              }
              onClose()
            }}
          >
            {running ? 'Stop / Cancel' : 'Cancel'}
          </button>
          <button className="win-btn-accent" onClick={() => void run()} disabled={running}>
            {running ? 'Running…' : 'Start Watching'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[12px]">
        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-slate-700">Livestream URL</span>
          <input
            className="win-input"
            placeholder="https://www.facebook.com/.../videos/..."
            value={liveUrl}
            onChange={(e) => setLiveUrl(e.target.value)}
          />
        </label>

        <fieldset className="win-fieldset flex items-center gap-3">
          <legend>Watch Duration</legend>
          <input
            type="number"
            min={1}
            className="win-input w-20 text-center"
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
          <select
            className="win-select"
            value={durationUnit}
            onChange={(e) => setDurationUnit(e.target.value as DurationUnit)}
          >
            {DURATION_UNITS.map((u) => (
              <option key={u.value} value={u.value}>
                {u.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-slate-500">= {watchSeconds}s per account</span>
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-slate-700">
            Optional Random Comment List <span className="text-slate-400">(one per line)</span>
          </span>
          <textarea
            className="h-24 resize-none rounded border border-slate-300 bg-white p-2 font-mono text-[12px] text-slate-900 outline-none focus:border-[#0078d4]"
            placeholder={'Great stream!\nLove this!\n🔥🔥🔥'}
            value={commentsText}
            onChange={(e) => setCommentsText(e.target.value)}
          />
          <span className="text-[11px] text-slate-500">
            {comments.length > 0
              ? `${comments.length} comment(s) — one random line is posted per account, ~halfway through the watch window.`
              : 'Leave empty to just watch without commenting.'}
          </span>
        </label>
      </div>
    </ModalShell>
  )
}
