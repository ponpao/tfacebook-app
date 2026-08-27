// ---------------------------------------------------------------------------
// ExportAccountsModal.tsx  — Advanced Export: pick a scope, build a token +
// delimiter format (or a preset), preview the first lines live, then copy /
// save as .txt / .csv.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from 'react'
import { Download, Copy, Save, FileSpreadsheet, X } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { useAccountStore } from '../../store/useAccountStore'
import { EXPORT_TOKENS, EXPORT_PRESETS, type ExportToken } from '../../../types/export'
import { ALL_FOLDERS } from '../../../types/folder'

const DELIMITERS: { label: string; value: string }[] = [
  { label: 'Pipe  |', value: '|' },
  { label: 'Dashes  ----', value: '----' },
  { label: 'Tab', value: 'TAB' },
  { label: 'Comma  ,', value: ',' },
  { label: 'Colon  :', value: ':' }
]

type Scope = 'all' | 'selected' | 'filtered'

export function ExportAccountsModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const selectedIds = useAccountStore((s) => s.selectedIds)
  const total = useAccountStore((s) => s.total)
  const search = useAccountStore((s) => s.search)
  const searchField = useAccountStore((s) => s.searchField)
  const statusFilter = useAccountStore((s) => s.statusFilter)
  const folderId = useAccountStore((s) => s.folderId)
  const showToast = useAccountStore((s) => s.showToast)

  const [scope, setScope] = useState<Scope>('all')
  const [presetIdx, setPresetIdx] = useState(1) // default: UID|PASS|2FA|EMAIL|PASSMAIL
  const [tokens, setTokens] = useState<ExportToken[]>(EXPORT_PRESETS[1].tokens)
  const [delimiter, setDelimiter] = useState('|')
  const [preview, setPreview] = useState<{ lines: string[]; total: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const selectedCount = selectedIds().length
  const isFiltered = Boolean(search.trim()) || statusFilter !== 'All' || folderId !== ALL_FOLDERS

  // Reset the scope to something sensible whenever the modal opens.
  useEffect(() => {
    if (!open) return
    setScope(selectedCount > 0 ? 'selected' : 'all')
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const buildRequest = () => ({
    scope,
    accountIds: scope === 'selected' ? selectedIds() : undefined,
    search: scope === 'filtered' ? search : undefined,
    searchField: scope === 'filtered' ? searchField : undefined,
    status: scope === 'filtered' ? statusFilter : undefined,
    folderId: scope === 'filtered' ? folderId : undefined,
    format: { tokens, delimiter }
  })

  // Live preview (debounced) whenever scope/format changes.
  useEffect(() => {
    if (!open || tokens.length === 0) {
      setPreview(null)
      return
    }
    const t = setTimeout(async () => {
      const res = await window.api.accounts.exportAccounts(buildRequest())
      setPreview(res)
    }, 200)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope, tokens, delimiter])

  const applyPreset = (idx: number): void => {
    setPresetIdx(idx)
    if (EXPORT_PRESETS[idx].tokens.length > 0) setTokens(EXPORT_PRESETS[idx].tokens)
  }

  const toggleToken = (token: ExportToken): void => {
    setPresetIdx(EXPORT_PRESETS.length - 1) // switches to "Custom..."
    setTokens((prev) =>
      prev.includes(token) ? prev.filter((t) => t !== token) : [...prev, token]
    )
  }
  const removeTokenAt = (i: number): void => {
    setPresetIdx(EXPORT_PRESETS.length - 1)
    setTokens((prev) => prev.filter((_, idx) => idx !== i))
  }

  const fullLines = useMemo(
    () => (preview ? preview.lines : []),
    [preview]
  )

  const copyToClipboard = async (): Promise<void> => {
    if (tokens.length === 0) {
      showToast('Pick at least one export field.')
      return
    }
    setBusy(true)
    try {
      const res = await window.api.accounts.exportAccounts(buildRequest())
      await navigator.clipboard.writeText(res.lines.join('\n'))
      showToast(`Copied ${res.total} account line(s) to clipboard.`)
    } finally {
      setBusy(false)
    }
  }

  const saveAsTxt = async (): Promise<void> => {
    if (tokens.length === 0) {
      showToast('Pick at least one export field.')
      return
    }
    setBusy(true)
    try {
      const res = await window.api.accounts.exportAccounts(buildRequest())
      const result = await window.api.utils.saveTextFile(
        res.lines.join('\r\n'),
        'accounts_export.txt',
        'txt'
      )
      if (result.ok) showToast(`Saved ${res.total} account(s) to ${result.filePath}`)
    } finally {
      setBusy(false)
    }
  }

  const saveAsCsv = async (): Promise<void> => {
    if (tokens.length === 0) {
      showToast('Pick at least one export field.')
      return
    }
    setBusy(true)
    try {
      const header = tokens.join(',')
      const res = await window.api.accounts.exportAccounts(buildRequest())
      // Rebuild as comma-separated regardless of the chosen preview delimiter,
      // since CSV/Excel requires commas — reuse the same field order.
      const csvLines = res.lines.map((line) => {
        const parts = delimiter === 'TAB' ? line.split('\t') : line.split(delimiter)
        return parts
          .map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
          .join(',')
      })
      const content = [header, ...csvLines].join('\r\n')
      const result = await window.api.utils.saveTextFile(
        content,
        'accounts_export.csv',
        'csv'
      )
      if (result.ok) showToast(`Saved ${res.total} account(s) to ${result.filePath}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Export Accounts"
      icon={Download}
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-[11px] text-slate-500">
            {preview ? `${preview.total} account(s) will be exported` : ''}
          </span>
          <button className="win-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="win-btn" onClick={() => void copyToClipboard()} disabled={busy}>
            <Copy size={13} className="text-[#0067c0]" />
            Copy to Clipboard
          </button>
          <button className="win-btn" onClick={() => void saveAsTxt()} disabled={busy}>
            <Save size={13} className="text-[#1e9e4a]" />
            Save as .txt
          </button>
          <button className="win-btn-accent" onClick={() => void saveAsCsv()} disabled={busy}>
            <FileSpreadsheet size={13} />
            Save as .csv / Excel
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[12px]">
        {/* Scope */}
        <fieldset className="win-fieldset">
          <legend>Export Scope</legend>
          <div className="flex flex-wrap gap-4 py-1">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="export-scope"
                checked={scope === 'all'}
                onChange={() => setScope('all')}
              />
              All Accounts ({total})
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="export-scope"
                checked={scope === 'selected'}
                onChange={() => setScope('selected')}
                disabled={selectedCount === 0}
              />
              Selected Accounts ({selectedCount})
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="export-scope"
                checked={scope === 'filtered'}
                onChange={() => setScope('filtered')}
                disabled={!isFiltered}
              />
              Filtered Accounts {isFiltered ? '(current search/filter)' : '(no filter active)'}
            </label>
          </div>
        </fieldset>

        {/* Format builder */}
        <fieldset className="win-fieldset">
          <legend>Format Builder</legend>
          <div className="flex flex-col gap-2 py-1">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium text-slate-600">Preset:</span>
              <select
                className="win-select"
                value={presetIdx}
                onChange={(e) => applyPreset(Number(e.target.value))}
              >
                {EXPORT_PRESETS.map((p, i) => (
                  <option key={p.label} value={i}>
                    {p.label}
                  </option>
                ))}
              </select>

              <span className="ml-3 font-medium text-slate-600">Delimiter:</span>
              <select
                className="win-select"
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value)}
              >
                {DELIMITERS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-1 text-[11px] font-medium text-slate-600">
                Selected fields (click a pill below to add/remove):
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tokens.length === 0 && (
                  <span className="text-[11px] text-slate-400">No fields selected</span>
                )}
                {tokens.map((t, i) => (
                  <span
                    key={`${t}-${i}`}
                    className="flex items-center gap-1 rounded border border-[#0078d4] bg-[#e5f1fb] px-2 py-0.5 text-[11px] text-[#0067c0]"
                  >
                    {t}
                    <button onClick={() => removeTokenAt(i)} title="Remove">
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1 mt-1.5 text-[11px] font-medium text-slate-600">
                Available fields:
              </div>
              <div className="flex flex-wrap gap-1.5">
                {EXPORT_TOKENS.map((t) => (
                  <button
                    key={t}
                    onClick={() => toggleToken(t)}
                    className={`rounded border px-2 py-0.5 text-[11px] ${
                      tokens.includes(t)
                        ? 'border-[#0078d4] bg-[#0078d4] text-white'
                        : 'border-slate-300 bg-white text-slate-700 hover:bg-[#e5f1fb]'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </fieldset>

        {/* Preview */}
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-slate-700">
            Preview (first {Math.min(5, fullLines.length)} line
            {fullLines.length === 1 ? '' : 's'}):
          </span>
          <div className="h-28 overflow-auto rounded border border-slate-300 bg-white p-2 font-mono text-[11px] text-slate-800">
            {fullLines.length === 0 ? (
              <span className="text-slate-400">No matching accounts / no fields selected</span>
            ) : (
              fullLines.slice(0, 5).map((line, i) => (
                <div key={i} className="border-b border-slate-100 py-0.5 first:pt-0">
                  {line || <span className="text-slate-400">(empty)</span>}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </ModalShell>
  )
}
