// ---------------------------------------------------------------------------
// ColumnVisibilityModal.tsx  — WinForms-style dialog to show/hide grid columns.
// Toggling a checkbox updates the store immediately (persisted in localStorage).
// ---------------------------------------------------------------------------
import { useEffect } from 'react'
import { X, Eye, Check } from 'lucide-react'
import { useAccountStore } from '../../store/useAccountStore'
import { GRID_COLUMNS, DEFAULT_COLUMN_VISIBILITY } from '../table/gridColumns'
import { HEADER_HEX_PATTERN_URL } from '../../assets/headerHexPattern'

export function ColumnVisibilityModal({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const columnVisibility = useAccountStore((s) => s.columnVisibility)
  const toggleColumn = useAccountStore((s) => s.toggleColumn)
  const setColumnVisibility = useAccountStore((s) => s.setColumnVisibility)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const selectAll = (): void =>
    setColumnVisibility(
      Object.fromEntries(GRID_COLUMNS.map((c) => [c.key, true]))
    )
  const resetDefault = (): void =>
    setColumnVisibility({ ...DEFAULT_COLUMN_VISIBILITY })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[80vh] w-[360px] flex-col overflow-hidden rounded border border-slate-400 bg-[#f0f2f5] shadow-2xl">
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
            <Eye size={16} className="text-[#0067c0]" />
            <h2 className="text-[13px] font-semibold text-slate-900">Display Columns</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-[#e81123]">
            <X size={16} />
          </button>
        </div>

        {/* Column list */}
        <div className="flex-1 overflow-auto p-2">
          {GRID_COLUMNS.map((c) => {
            const visible = columnVisibility[c.key] !== false
            return (
              <button
                key={c.key}
                onClick={() => toggleColumn(c.key)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-slate-800 hover:bg-[#e5f1fb]"
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-[2px] border ${
                    visible
                      ? 'border-[#0078d4] bg-[#0078d4] text-white'
                      : 'border-slate-400 bg-white'
                  }`}
                >
                  {visible && <Check size={12} />}
                </span>
                {c.header}
              </button>
            )
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-300 bg-[#f6f6f6] px-4 py-2.5">
          <div className="flex gap-2">
            <button className="win-btn" onClick={selectAll}>
              Select All
            </button>
            <button className="win-btn" onClick={resetDefault}>
              Reset to Default
            </button>
          </div>
          <button className="win-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
