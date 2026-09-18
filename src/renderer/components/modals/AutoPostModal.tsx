// ---------------------------------------------------------------------------
// AutoPostModal.tsx  — configure and run Auto Post across selected accounts:
// destination (feed / random joined groups), spin-syntax content, optional
// images, group count + delay settings.
// ---------------------------------------------------------------------------
import { useState } from 'react'
import { BookOpen, Wand2, ImagePlus, Film, X } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import type { PostDestination } from '../../../types/marketing'

export function AutoPostModal({
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

  const [destination, setDestination] = useState<PostDestination>('feed')
  const [content, setContent] = useState('')
  const [spinPreview, setSpinPreview] = useState<string[]>([])
  const [imagePaths, setImagePaths] = useState<string[]>([])
  const [groupCount, setGroupCount] = useState(2)
  const [pageCount, setPageCount] = useState(10)
  const [delayMin, setDelayMin] = useState(15)
  const [delayMax, setDelayMax] = useState(45)
  const [commentOn, setCommentOn] = useState(true)
  const [commentTemplate, setCommentTemplate] = useState('')
  const [running, setRunning] = useState(false)

  const count = selectedIds().length

  const testSpin = async (): Promise<void> => {
    if (!content.trim()) return
    const results = await Promise.all([
      window.api.utils.parseSpinSyntax(content),
      window.api.utils.parseSpinSyntax(content),
      window.api.utils.parseSpinSyntax(content)
    ])
    setSpinPreview(results)
  }

  const pickMedia = async (): Promise<void> => {
    const paths = await window.api.utils.selectMedia()
    if (paths.length) setImagePaths(paths)
  }

  const run = async (): Promise<void> => {
    const ids = selectedIds()
    if (ids.length === 0) {
      showToast('Select at least one account first.')
      return
    }
    if (!content.trim() && imagePaths.length === 0) {
      showToast('Enter post content or attach a photo/video.')
      return
    }
    onClose()
    showToast(`Auto Post: running on ${ids.length} account(s)…`)
    try {
      await withQueueRunning(async () => {
        const summary = await window.api.automation.runAutoPost({
          accountIds: ids,
          concurrency: threadCount,
          destination,
          contentTemplate: content,
          imagePaths,
          groupCount,
          pageCount,
          delayMinSeconds: delayMin,
          delayMaxSeconds: delayMax,
          commentTemplate: commentOn && commentTemplate.trim() ? commentTemplate : undefined
        })
        showToast(
          `Auto Post done: ${summary.succeeded}/${summary.total} succeeded, ${summary.failed} failed.`,
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
      title="Auto Post"
      icon={BookOpen}
      footer={
        <>
          <span className="mr-auto text-[11px] text-ink-muted">
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
            {running ? 'Running…' : 'Start Auto Post'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[12px]">
        {/* Destination */}
        <fieldset className="win-fieldset">
          <legend>Post Destination</legend>
          <div className="flex gap-4 py-1">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="post-dest"
                checked={destination === 'feed'}
                onChange={() => setDestination('feed')}
              />
              Post to Personal Feed
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="post-dest"
                checked={destination === 'groups'}
                onChange={() => setDestination('groups')}
              />
              Post to Random Joined Groups
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="post-dest"
                checked={destination === 'pages'}
                onChange={() => setDestination('pages')}
              />
              Post to Managed Pages
            </label>
          </div>
          {destination === 'pages' && (
            <p className="mt-1 text-[11px] text-ink-muted">
              Uses pages saved on the account (run Get Page Info first). Switches into each page, then posts photo/video + caption.
            </p>
          )}
        </fieldset>

        {/* Content */}
        <label className="flex flex-col gap-1.5">
          <span className="font-medium text-ink">
            Post Content (supports Spin Syntax: {'{a|b|c}'})
          </span>
          <textarea
            className="h-28 resize-none rounded-lg border border-edge bg-surface p-2 font-mono text-[12px] text-ink outline-none focus:border-[#0078d4]"
            placeholder={'{Hello|Hi} everyone! {Have a great day|Enjoy your day}!'}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <button className="win-btn" onClick={() => void testSpin()}>
              <Wand2 size={13} className="text-[#0067c0]" />
              Test Spin
            </button>
            <button className="win-btn" onClick={() => void pickMedia()}>
              <ImagePlus size={13} className="text-[#1e9e4a]" />
              <Film size={13} className="text-[#c45c26]" />
              Attach Photo / Video
            </button>
            {imagePaths.length > 0 && (
              <span className="text-[11px] text-ink-muted">
                {imagePaths.length} file(s): {imagePaths.map((p) => p.split(/[/\\]/).pop()).join(', ')}
                <button
                  className="ml-1 text-[#c81e1e]"
                  onClick={() => setImagePaths([])}
                  title="Clear media"
                >
                  <X size={11} className="inline" />
                </button>
              </span>
            )}
          </div>
          {spinPreview.length > 0 && (
            <div className="rounded-lg border border-edge bg-surface p-2 text-[11px] text-ink">
              <div className="mb-1 font-semibold text-ink-muted">Preview (3 samples):</div>
              {spinPreview.map((p, i) => (
                <div key={i} className="border-t border-edge py-1 first:border-t-0">
                  {p}
                </div>
              ))}
            </div>
          )}
        </label>

        {/* Settings */}
        <label className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 font-medium text-ink">
            <input type="checkbox" checked={commentOn} onChange={(e) => setCommentOn(e.target.checked)} />
            Comment a link after posting
          </label>
          {commentOn && (
            <>
              <textarea
                className="h-16 resize-none rounded-lg border border-edge bg-surface p-2 font-mono text-[12px] text-ink outline-none focus:border-[#0078d4]"
                placeholder={'https://yoursite.com/article\nor {https://site.com/a|https://site.com/b}'}
                value={commentTemplate}
                onChange={(e) => setCommentTemplate(e.target.value)}
              />
              <span className="text-[11px] text-ink-muted">
                Posted as a comment on the new post (photo/video stays clean; the URL goes in the comment). Spin syntax supported.
              </span>
            </>
          )}
        </label>

        {(destination === 'groups' || destination === 'pages') && (
          <fieldset className="win-fieldset flex items-center gap-4">
            <legend>Settings</legend>
            {destination === 'groups' && (
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
            )}
            {destination === 'pages' && (
            <label className="flex items-center gap-1.5">
              Page count limit
              <input
                type="number"
                min={1}
                max={50}
                className="win-input w-16 text-center"
                value={pageCount}
                onChange={(e) => setPageCount(Number(e.target.value))}
              />
            </label>
            )}
            <label className="flex items-center gap-1.5">
              Delay min (s)
              <input
                type="number"
                min={1}
                className="win-input w-16 text-center"
                value={delayMin}
                onChange={(e) => setDelayMin(Number(e.target.value))}
              />
            </label>
            <label className="flex items-center gap-1.5">
              Delay max (s)
              <input
                type="number"
                min={1}
                className="win-input w-16 text-center"
                value={delayMax}
                onChange={(e) => setDelayMax(Number(e.target.value))}
              />
            </label>
          </fieldset>
        )}
      </div>
    </ModalShell>
  )
}
