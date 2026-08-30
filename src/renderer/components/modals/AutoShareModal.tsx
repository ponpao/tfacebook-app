// ---------------------------------------------------------------------------
// AutoShareModal.tsx  — configure and run Auto Share of a target Facebook
// URL (post/reel/video/livestream) to the personal wall or joined groups.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { Share2, Wand2 } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import type { ShareDestination } from '../../../types/marketing'

export function AutoShareModal({
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

  const [targetUrl, setTargetUrl] = useState('')
  const [destination, setDestination] = useState<ShareDestination>('wall')
  const [caption, setCaption] = useState('')
  const [spinPreview, setSpinPreview] = useState<string[]>([])
  const [groupCount, setGroupCount] = useState(2)
  const [delayMin, setDelayMin] = useState(20)
  const [delayMax, setDelayMax] = useState(60)
  const [running, setRunning] = useState(false)

  const count = selectedIds().length

  const testSpin = async (): Promise<void> => {
    if (!caption.trim()) return
    const results = await Promise.all([
      window.api.utils.parseSpinSyntax(caption),
      window.api.utils.parseSpinSyntax(caption),
      window.api.utils.parseSpinSyntax(caption)
    ])
    setSpinPreview(results)
  }

  const run = async (): Promise<void> => {
    const ids = selectedIds()
    if (ids.length === 0) {
      showToast('Select at least one account first.')
      return
    }
    if (!targetUrl.trim()) {
      showToast('Enter a target Facebook post/reel/video URL.')
      return
    }
    onClose()
    showToast(`Auto Share: running on ${ids.length} account(s)…`)
    try {
      await withQueueRunning(async () => {
        const summary = await window.api.automation.runAutoShare({
          accountIds: ids,
          concurrency: threadCount,
          targetUrl: targetUrl.trim(),
          destination,
          captionTemplate: caption,
          groupCount,
          delayMinSeconds: delayMin,
          delayMaxSeconds: delayMax
        })
        showToast(
          `Auto Share done: ${summary.succeeded}/${summary.total} succeeded, ${summary.failed} failed.`,
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
      title="Auto Share"
      icon={Share2}
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
            {running ? 'Running…' : 'Start Auto Share'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[12px]">
        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-slate-700">
            Target URL (Post, Reel, Video, or Livestream)
          </span>
          <input
            className="win-input"
            placeholder="https://www.facebook.com/.../posts/..."
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
          />
        </label>

        <fieldset className="win-fieldset">
          <legend>Share Options</legend>
          <div className="flex gap-4 py-1">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="share-dest"
                checked={destination === 'wall'}
                onChange={() => setDestination('wall')}
              />
              Share to Personal Wall
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="share-dest"
                checked={destination === 'groups'}
                onChange={() => setDestination('groups')}
              />
              Share to Joined Groups (random count limit)
            </label>
          </div>
        </fieldset>

        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-slate-700">
            Optional Caption (supports Spin Syntax: {'{a|b|c}'})
          </span>
          <textarea
            className="h-20 resize-none rounded border border-slate-300 bg-white p-2 font-mono text-[12px] text-slate-900 outline-none focus:border-[#0078d4]"
            placeholder={'{Check this out|Worth watching}!'}
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
          <button className="win-btn w-fit" onClick={() => void testSpin()}>
            <Wand2 size={13} className="text-[#0067c0]" />
            Test Spin
          </button>
          {spinPreview.length > 0 && (
            <div className="rounded border border-slate-300 bg-white p-2 text-[11px] text-slate-700">
              <div className="mb-1 font-semibold text-slate-500">Preview (3 samples):</div>
              {spinPreview.map((p, i) => (
                <div key={i} className="border-t border-slate-100 py-1 first:border-t-0">
                  {p || <span className="text-slate-400">(empty)</span>}
                </div>
              ))}
            </div>
          )}
        </label>

        {destination === 'groups' && (
          <fieldset className="win-fieldset flex items-center gap-4">
            <legend>Settings</legend>
            <label className="flex items-center gap-1.5">
              Group count limit
              <input
                type="number"
                min={1}
                max={20}
                className="win-input w-16 text-center"
                value={groupCount}
                onChange={(e) => setGroupCount(Number(e.target.value))}
              />
            </label>
          </fieldset>
        )}

        <fieldset className="win-fieldset flex items-center gap-3">
          <legend>Delay between shares (anti-spam)</legend>
          <label className="flex items-center gap-1.5">
            Min (s)
            <input
              type="range"
              min={20}
              max={60}
              value={delayMin}
              onChange={(e) => setDelayMin(Number(e.target.value))}
            />
            <span className="w-8 text-right">{delayMin}</span>
          </label>
          <label className="flex items-center gap-1.5">
            Max (s)
            <input
              type="range"
              min={20}
              max={60}
              value={delayMax}
              onChange={(e) => setDelayMax(Number(e.target.value))}
            />
            <span className="w-8 text-right">{delayMax}</span>
          </label>
        </fieldset>
      </div>
    </ModalShell>
  )
}
