// ---------------------------------------------------------------------------
// ImportModal.tsx  — paste raw account text, define a token layout + separator,
// preview the parsed result live, then import into SQLite.
// WinForms light theme with a solid opaque background and dark backdrop.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react'
import { X, FileInput, Wand2, FolderPlus } from 'lucide-react'
import { IMPORT_TOKENS, type ImportToken, type ParseResult } from '../../../types/parser'
import { ALL_FOLDERS } from '../../../types/folder'
import { useAccountStore } from '../../store/useAccountStore'
import { HEADER_HEX_PATTERN_URL } from '../../assets/headerHexPattern'

const SEPARATORS: { label: string; value: string }[] = [
  { label: 'Pipe  |', value: '|' },
  { label: 'Dashes  ----', value: '----' },
  { label: 'Colon  :', value: ':' },
  { label: 'Comma  ,', value: ',' },
  { label: 'Semicolon  ;', value: ';' },
  { label: 'Tab', value: 'TAB' }
]

// A sensible default layout matching a very common share format.
const DEFAULT_TOKENS: ImportToken[] = ['UID', 'PASS', '2FA', 'EMAIL', 'PASSMAIL']

export function ImportModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const [text, setText] = useState('')
  const [separator, setSeparator] = useState('|')
  const [tokens, setTokens] = useState<ImportToken[]>(DEFAULT_TOKENS)
  const [preview, setPreview] = useState<ParseResult | null>(null)
  const [importing, setImporting] = useState(false)

  const refresh = useAccountStore((s) => s.refresh)
  const refreshFolders = useAccountStore((s) => s.refreshFolders)
  const folders = useAccountStore((s) => s.folders)
  const activeFolderId = useAccountStore((s) => s.folderId)

  // Target folder for the accounts about to be imported — defaults to
  // whichever folder is currently active in the main grid, falling back to
  // the first real folder if "All Folders" is selected there (ALL_FOLDERS
  // isn't a real destination to import into).
  const [targetFolderId, setTargetFolderId] = useState<number | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creatingFolderBusy, setCreatingFolderBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    if (targetFolderId != null && folders.some((f) => f.id === targetFolderId)) return
    const fallback = activeFolderId !== ALL_FOLDERS ? activeFolderId : (folders[0]?.id ?? null)
    setTargetFolderId(fallback)
  }, [open, folders, activeFolderId, targetFolderId])

  const createFolder = async (): Promise<void> => {
    const name = newFolderName.trim()
    if (!name || creatingFolderBusy) return
    setCreatingFolderBusy(true)
    try {
      const created = await window.api.folders.create(name)
      await refreshFolders()
      setTargetFolderId(created.id)
      setNewFolderName('')
      setCreatingFolder(false)
    } finally {
      setCreatingFolderBusy(false)
    }
  }

  const format = useMemo(() => ({ tokens, separator }), [tokens, separator])

  // Live preview (debounced) whenever text / format changes.
  useEffect(() => {
    if (!open) return
    if (!text.trim()) {
      setPreview(null)
      return
    }
    const t = setTimeout(async () => {
      const res = await window.api.parser.preview(text, format, 100)
      setPreview(res)
    }, 250)
    return () => clearTimeout(t)
  }, [text, format, open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const setTokenAt = (index: number, value: ImportToken): void => {
    setTokens((prev) => {
      const next = [...prev]
      next[index] = value
      return next
    })
  }
  const addColumn = (): void => setTokens((prev) => [...prev, 'IGNORE'])
  const removeColumn = (index: number): void =>
    setTokens((prev) => prev.filter((_, i) => i !== index))

  const guess = (): void => {
    const firstLine = text.split(/\r?\n/).find((l) => l.trim())
    if (!firstLine) return
    const found = SEPARATORS.map((s) => ({
      sep: s.value,
      count: firstLine.split(s.value === 'TAB' ? '\t' : s.value).length
    })).sort((a, b) => b.count - a.count)[0]
    if (found) {
      setSeparator(found.sep)
      // Pad / trim token list to match detected column count.
      setTokens((prev) => {
        const next = [...prev]
        while (next.length < found.count) next.push('IGNORE')
        return next.slice(0, found.count)
      })
    }
  }

  const doImport = async (): Promise<void> => {
    setImporting(true)
    try {
      const res = await window.api.parser.import(text, format, targetFolderId ?? undefined)
      await refresh()
      await refreshFolders()
      alert(
        `Imported ${res.inserted} account(s). Skipped ${res.skipped} (duplicates/invalid).`
      )
      onClose()
      setText('')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex h-full max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded border border-slate-400 bg-[#f0f2f5] shadow-2xl">
        {/* Header */}
        <div
          className="flex items-center justify-between border-b border-[#e4d8bc] bg-[#fdf9f0] px-4 py-2"
          style={{
            backgroundImage: HEADER_HEX_PATTERN_URL,
            backgroundSize: '56px 98px',
            backgroundRepeat: 'repeat'
          }}
        >
          <div className="flex items-center gap-2">
            <FileInput size={17} className="text-[#0067c0]" />
            <h2 className="text-[13px] font-semibold text-slate-900">Import Accounts</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-[#e81123]">
            <X size={17} />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-2 gap-0 overflow-hidden">
          {/* Left: input + format */}
          <div className="flex flex-col gap-3 overflow-auto border-r border-slate-300 p-4">
            {/* Target Folder */}
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-slate-700">
                Target Folder
              </label>
              {!creatingFolder ? (
                <div className="flex items-center gap-2">
                  <select
                    className="win-select flex-1"
                    value={targetFolderId ?? ''}
                    onChange={(e) => setTargetFolderId(e.target.value ? Number(e.target.value) : null)}
                  >
                    {folders.length === 0 && <option value="">No folders</option>}
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} ({f.account_count})
                      </option>
                    ))}
                  </select>
                  <button
                    className="win-btn shrink-0"
                    onClick={() => setCreatingFolder(true)}
                    title="Create a new folder"
                  >
                    <FolderPlus size={14} className="text-[#0067c0]" />
                    New Folder
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    className="win-input flex-1"
                    placeholder="Enter new folder name..."
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createFolder()
                      if (e.key === 'Escape') {
                        setCreatingFolder(false)
                        setNewFolderName('')
                      }
                    }}
                  />
                  <button
                    className="win-btn-accent shrink-0"
                    disabled={!newFolderName.trim() || creatingFolderBusy}
                    onClick={() => void createFolder()}
                  >
                    {creatingFolderBusy ? 'Creating…' : 'Add / Create'}
                  </button>
                  <button
                    className="win-btn shrink-0"
                    onClick={() => {
                      setCreatingFolder(false)
                      setNewFolderName('')
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>

            <label className="text-[12px] font-medium text-slate-700">
              Paste account list (one per line)
            </label>
            <textarea
              className="h-48 resize-none rounded border border-slate-300 bg-white p-2 font-mono text-[12px] leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 focus:border-[#0078d4]"
              placeholder={'uid|password|2fa|email|emailpass\n...'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />

            <div className="flex items-center gap-2">
              <label className="text-[12px] font-medium text-slate-700">Separator</label>
              <select
                className="win-select"
                value={separator}
                onChange={(e) => setSeparator(e.target.value)}
              >
                {SEPARATORS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button className="win-btn" onClick={guess}>
                <Wand2 size={14} className="text-[#0067c0]" />
                Auto-detect
              </button>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[12px] font-medium text-slate-700">
                  Column layout (left → right)
                </label>
                <button
                  className="text-[12px] text-[#0067c0] hover:underline"
                  onClick={addColumn}
                >
                  + Add column
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tokens.map((tok, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1 rounded border border-slate-300 bg-white px-1.5 py-1"
                  >
                    <span className="text-[10px] text-slate-400">#{i + 1}</span>
                    <select
                      className="bg-transparent text-[12px] text-slate-900 outline-none"
                      value={tok}
                      onChange={(e) => setTokenAt(i, e.target.value as ImportToken)}
                    >
                      {IMPORT_TOKENS.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <button
                      className="text-slate-400 hover:text-[#e81123]"
                      onClick={() => removeColumn(i)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: preview */}
          <div className="flex flex-col overflow-hidden p-4">
            <div className="mb-2 flex items-center justify-between">
              <label className="text-[12px] font-medium text-slate-700">Preview</label>
              {preview && (
                <span className="text-[12px] text-slate-500">
                  <span className="font-semibold text-[#1e9e4a]">
                    {preview.validCount} valid
                  </span>
                  {preview.errorCount > 0 && (
                    <span className="text-[#c81e1e]">
                      {' '}
                      · {preview.errorCount} invalid
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-auto rounded border border-slate-300 bg-white">
              {!preview ? (
                <div className="flex h-full items-center justify-center text-[12px] text-slate-400">
                  Paste some lines to preview
                </div>
              ) : (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-[#f5f5f5] text-slate-700">
                    <tr>
                      <th className="border-b border-slate-300 px-2 py-1.5 text-left font-semibold">
                        #
                      </th>
                      <th className="border-b border-slate-300 px-2 py-1.5 text-left font-semibold">
                        UID
                      </th>
                      <th className="border-b border-slate-300 px-2 py-1.5 text-left font-semibold">
                        Pass
                      </th>
                      <th className="border-b border-slate-300 px-2 py-1.5 text-left font-semibold">
                        2FA
                      </th>
                      <th className="border-b border-slate-300 px-2 py-1.5 text-left font-semibold">
                        Email
                      </th>
                      <th className="border-b border-slate-300 px-2 py-1.5 text-left font-semibold">
                        PassMail
                      </th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-slate-800">
                    {preview.rows.map((r) => (
                      <tr
                        key={r.lineNumber}
                        className={`border-b border-slate-100 ${
                          r.error ? 'bg-red-50' : ''
                        }`}
                      >
                        <td className="px-2 py-1 text-slate-400">{r.lineNumber}</td>
                        <td className="px-2 py-1">{r.parsed.uid ?? '—'}</td>
                        <td className="px-2 py-1">{r.parsed.password ?? '—'}</td>
                        <td className="px-2 py-1">{r.parsed.two_fa ?? '—'}</td>
                        <td className="px-2 py-1">{r.parsed.email ?? '—'}</td>
                        <td className="px-2 py-1">{r.parsed.email_pass ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-300 bg-[#f6f6f6] px-4 py-2.5">
          <button className="win-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="win-btn-accent"
            disabled={!preview || preview.validCount === 0 || importing}
            onClick={() => void doImport()}
          >
            {importing ? 'Importing…' : `Import ${preview?.validCount ?? 0} account(s)`}
          </button>
        </div>
      </div>
    </div>
  )
}
