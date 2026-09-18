import { useCallback, useEffect, useMemo, useState } from 'react'
import { Layers, ImagePlus, Film, Play, Search, CheckSquare, Square, Square as StopIcon } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import { ALL_FOLDERS } from '../../../types/folder'
import type { Account, ManagedPage } from '../../../types/account'
import type { LinkPostMode, PagePostTarget } from '../../../types/marketing'

interface PageRow {
  rowKey: string
  accountId: number
  accountUid: string
  accountName: string
  pageId: string
  name: string
  followers: string
  category: string
}

function parseLinks(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

function assignLink(links: string[], mode: LinkPostMode, index: number): string {
  if (!links.length) return ''
  if (mode === 'single') return links[0]
  if (mode === 'sequential') return links[index % links.length]
  return links[Math.floor(Math.random() * links.length)]
}

export function PostToPageModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const folders = useAccountStore((s) => s.folders)
  const threadCount = useAccountStore((s) => s.threadCount)
  const showToast = useAccountStore((s) => s.showToast)
  const withQueueRunning = useAccountStore((s) => s.withQueueRunning)
  const stopQueueRun = useAccountStore((s) => s.stopQueueRun)
  const refresh = useAccountStore((s) => s.refresh)

  const [folderId, setFolderId] = useState<number>(ALL_FOLDERS)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [caption, setCaption] = useState('')
  const [linksText, setLinksText] = useState('')
  const [linkMode, setLinkMode] = useState<LinkPostMode>('single')
  const [mediaPaths, setMediaPaths] = useState<string[]>([])
  const [delayMin, setDelayMin] = useState(20)
  const [delayMax, setDelayMax] = useState(45)
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const queueProgress = useAccountStore((s) => s.queueProgress)

  const load = useCallback(async () => {
    const res = await window.api.accounts.list({
      folderId: folderId === ALL_FOLDERS ? undefined : folderId,
      limit: 10000
    })
    setAccounts(res.rows)
  }, [folderId])

  useEffect(() => {
    if (open && !running) void load()
  }, [open, load, running])

  const rows = useMemo<PageRow[]>(() => {
    const list: PageRow[] = []
    const q = search.trim().toLowerCase()
    for (const acc of accounts) {
      if (!acc.pages_data) continue
      let pages: ManagedPage[] = []
      try {
        pages = JSON.parse(acc.pages_data) as ManagedPage[]
      } catch {
        continue
      }
      if (!Array.isArray(pages)) continue
      for (const p of pages) {
        if (!p.pageId || !p.name || p.status === 'Deactivated / Deleted' || p.status === 'Summary') continue
        const row: PageRow = {
          rowKey: `${acc.id}_${p.pageId}`,
          accountId: acc.id,
          accountUid: acc.uid || `#${acc.id}`,
          accountName: acc.name || '',
          pageId: p.pageId,
          name: p.name,
          followers: p.followers || '0',
          category: p.category || ''
        }
        if (q) {
          const hay = `${row.name} ${row.pageId} ${row.accountUid} ${row.accountName} ${row.category}`.toLowerCase()
          if (!hay.includes(q)) continue
        }
        list.push(row)
      }
    }
    return list
  }, [accounts, search])

  const toggle = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAll = (): void => {
    if (selected.size === rows.length) setSelected(new Set())
    else setSelected(new Set(rows.map((r) => r.rowKey)))
  }

  const pickMedia = async (): Promise<void> => {
    const paths = await window.api.utils.selectMedia()
    if (paths.length) setMediaPaths(paths)
  }

  const run = async (): Promise<void> => {
    const chosen = rows.filter((r) => selected.has(r.rowKey))
    if (chosen.length === 0) {
      showToast('Select at least one page in the table.')
      return
    }
    if (!caption.trim() && mediaPaths.length === 0) {
      showToast('Enter a caption or attach a photo/video.')
      return
    }
    const links = parseLinks(linksText)
    if (links.length === 0) {
      showToast('Paste at least one link for the comment.')
      return
    }

    const pageTargets: PagePostTarget[] = chosen.map((r, i) => ({
      accountId: r.accountId,
      pageId: r.pageId,
      comment: assignLink(links, linkMode, i)
    }))

    setLog([
      `Starting ${chosen.length} page(s) · ${linkMode} · ${mediaPaths.length} file(s)`,
      ...pageTargets.map((t, i) => `${i + 1}. page ${t.pageId} → ${t.comment}`)
    ])
    showToast(`Post To Page: ${chosen.length} page(s)…`)
    setRunning(true)
    try {
      await withQueueRunning(async () => {
        const summary = await window.api.automation.runAutoPost({
          accountIds: [...new Set(chosen.map((r) => r.accountId))],
          concurrency: threadCount,
          destination: 'pages',
          contentTemplate: caption,
          imagePaths: mediaPaths,
          pageTargets,
          links,
          linkMode,
          delayMinSeconds: delayMin,
          delayMaxSeconds: delayMax
        })
        const done = `Done: ${summary.succeeded}/${summary.total} account(s) ok, ${summary.failed} failed${summary.cancelled ? ' (stopped)' : ''}`
        setLog((prev) => [...prev, done])
        showToast(done, 6000)
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setLog((prev) => [...prev, `Error: ${msg}`])
      showToast(msg)
    } finally {
      setRunning(false)
      await refresh()
    }
  }

  if (!open) return null

  return (
    <ModalShell
      open={open}
      onClose={() => {
        if (running) return
        onClose()
      }}
      title={running ? 'Post To Page — running (stay on this window)' : 'Post To Page'}
      icon={Layers}
      width="max-w-[1280px]"
      height="h-[90vh] max-h-[860px]"
      bodyClassName="flex-1 min-h-0 overflow-hidden flex flex-col p-2.5 bg-surface-sunken"
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-[11px] text-ink-muted">
            {rows.length} page(s) · {selected.size} selected · {threadCount} thread(s)
          </span>
          <div className="flex gap-2">
            {running && (
              <button className="win-btn" onClick={() => void stopQueueRun()}>
                <StopIcon size={13} />
                Stop
              </button>
            )}
            <button className="win-btn" onClick={onClose} disabled={running}>
              Close
            </button>
            <button className="win-btn-accent" onClick={() => void run()} disabled={running}>
              <Play size={13} />
              {running ? 'Posting… stay on this window' : 'Start Post To Page'}
            </button>
          </div>
        </div>
      }
    >
      <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-edge bg-surface px-3 py-2">
        <label className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
          Category folder
          <select
            className="win-input max-w-[180px]"
            value={folderId}
            onChange={(e) => {
              setFolderId(Number(e.target.value))
              setSelected(new Set())
            }}
          >
            <option value={ALL_FOLDERS}>All folders</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name} ({f.account_count || 0})
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1 rounded-lg border border-edge bg-surface px-2">
          <Search size={12} className="text-ink-muted" />
          <input
            className="h-7 w-44 border-0 bg-transparent text-[12px] outline-none"
            placeholder="Search page, UID, category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button className="win-btn" onClick={selectAll}>
          {selected.size === rows.length && rows.length > 0 ? <CheckSquare size={13} /> : <Square size={13} />}
          {selected.size === rows.length && rows.length > 0 ? 'Unselect all' : 'Select all pages'}
        </button>
        <button className="win-btn" onClick={() => void pickMedia()}>
          <ImagePlus size={13} />
          <Film size={13} />
          Photo / Video
        </button>
        {mediaPaths.length > 0 && (
          <span className="max-w-[220px] truncate text-[11px] text-ink-muted">
            {mediaPaths.length} file(s): {mediaPaths.map((p) => p.split(/[/\\]/).pop()).join(', ')}
            <button className="ml-1 text-[#c81e1e]" onClick={() => setMediaPaths([])}>
              ×
            </button>
          </span>
        )}
        <label className="flex items-center gap-1 text-[11px]">
          Delay
          <input
            type="number"
            min={1}
            className="win-input w-14 text-center"
            value={delayMin}
            onChange={(e) => setDelayMin(Number(e.target.value))}
          />
          –
          <input
            type="number"
            min={1}
            className="win-input w-14 text-center"
            value={delayMax}
            onChange={(e) => setDelayMax(Number(e.target.value))}
          />
          s
        </label>
      </div>

      <div className="mb-2 grid shrink-0 grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11px] font-semibold text-ink-muted">
          Caption (on the post)
          <textarea
            className="h-16 resize-none rounded-lg border border-edge bg-surface p-2 font-normal text-[12px] text-ink"
            placeholder="Photo/video caption. Spin: {Hello|Hi}"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-semibold text-ink-muted">
          Links (commented after each post, one per line)
          <textarea
            className="h-16 resize-none rounded-lg border border-edge bg-surface p-2 font-mono font-normal text-[12px] text-ink"
            placeholder={'https://yoursite.com/post-1\nhttps://yoursite.com/post-2'}
            value={linksText}
            onChange={(e) => setLinksText(e.target.value)}
          />
        </label>
      </div>

      <div className="mb-2 flex shrink-0 gap-4 text-[12px]">
        <span className="font-semibold text-ink-muted">Link mode:</span>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="link-mode" checked={linkMode === 'single'} onChange={() => setLinkMode('single')} />
          One link (same comment on every page)
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="radio"
            name="link-mode"
            checked={linkMode === 'sequential'}
            onChange={() => setLinkMode('sequential')}
          />
          Link by link (1→page1, 2→page2, …)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" name="link-mode" checked={linkMode === 'random'} onChange={() => setLinkMode('random')} />
          Random link per page
        </label>
      </div>

      {(running || log.length > 0) && (
        <div className="mb-2 max-h-28 shrink-0 overflow-auto rounded-lg border border-edge bg-surface px-3 py-2 font-mono text-[11px] text-ink">
          {Object.values(queueProgress).map((p) => (
            <div key={p.accountId} className="text-[#1a5c96]">
              [{p.uid || p.accountId}] {p.stage}
              {p.detail ? ` — ${p.detail}` : ''}
            </div>
          ))}
          {log.map((line, i) => (
            <div key={`l${i}`}>{line}</div>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-edge bg-surface">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 bg-surface-sunken text-left text-[11px] uppercase tracking-wide text-ink-muted">
            <tr>
              <th className="w-8 px-2 py-2">
                <input
                  type="checkbox"
                  checked={rows.length > 0 && selected.size === rows.length}
                  onChange={selectAll}
                />
              </th>
              <th className="px-2 py-2">#</th>
              <th className="px-2 py-2">UID</th>
              <th className="px-2 py-2">Page</th>
              <th className="px-2 py-2">Page ID</th>
              <th className="px-2 py-2">Followers</th>
              <th className="px-2 py-2">Category</th>
              <th className="px-2 py-2">Account</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-ink-muted">
                  No pages in this folder. Run <strong>Pages → Get Page Info</strong> first.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr
                key={r.rowKey}
                className={`border-t border-edge hover:bg-surface-sunken ${selected.has(r.rowKey) ? 'bg-blue-50 dark:bg-blue-500/10' : ''}`}
                onClick={() => toggle(r.rowKey)}
              >
                <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(r.rowKey)} onChange={() => toggle(r.rowKey)} />
                </td>
                <td className="px-2 py-1.5 text-ink-muted">{i + 1}</td>
                <td className="px-2 py-1.5 font-mono text-[11px]">{r.accountUid}</td>
                <td className="px-2 py-1.5 font-semibold">{r.name}</td>
                <td className="px-2 py-1.5 font-mono text-[11px]">{r.pageId}</td>
                <td className="px-2 py-1.5">{r.followers}</td>
                <td className="px-2 py-1.5">{r.category || '—'}</td>
                <td className="px-2 py-1.5 text-ink-muted">{r.accountName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ModalShell>
  )
}
