// ---------------------------------------------------------------------------
// AccountsGrid.tsx  — classic WinForms DataGridView-style grid.
//   * pastel-green rows, deep-blue selection with white text
//   * compact ~26px rows, visible inner gridlines
//   * virtualized for thousands of rows (@tanstack/react-virtual)
//   * column visibility driven by the store
//   * right-click context menu with account actions
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Account } from '../../../types/account'
import { useAccountStore } from '../../store/useAccountStore'
import { GRID_COLUMNS, ROW_NUMBER_COLUMN, RESIZE_MIN_WIDTH, RESIZE_MAX_WIDTH } from './gridColumns'
import { AccountContextMenu } from './AccountContextMenu'

const ROW_HEIGHT = 26
const CHECKBOX_W = 34
const COLUMN_WIDTHS_KEY = 'tfacebook_column_widths'

/**
 * Row background + hover tint keyed by account.status — applied to BOTH the
 * outer row (which every middle-column cell shows through, since those
 * cells have no background of their own) and the checkbox/row-number block
 * (which still needs its own explicit, matching color since it's a
 * separate flex child sitting in front of the row rather than transparent
 * over it).
 *
 * `status` is a free-text field in this schema (`'Live' | 'Checkpoint' |
 * 'Die' | 'Changed Pass' | 'Unknown' | string`) — variants like "Checkpoint
 * 282"/"956" live in status_detail/notes, not a separate status value, so
 * matching on the base 'Checkpoint' string already covers them. 'Banned'/
 * 'Disabled' aren't real status values this app produces; grouped under Die
 * defensively in case a custom/imported status ever uses that wording.
 */
/**
 * Unknown/default rows get a flat, consistent neutral tint — NOT the old
 * mc-row/mc-rowAlt zebra pair, which are both pastel greens left over from
 * before status coloring existed. Alternating between two different greens
 * on every Unknown row made them look like inconsistently-colored Live rows
 * at a glance (confirmed against a real screenshot: a grid full of Unknown
 * accounts read as "randomly multicolored" instead of uniformly neutral).
 * Every row of the same status must look identical to the eye, alternating
 * or not, hence a single flat white/slate pair by index parity for texture
 * without implying any status meaning.
 */
const UNKNOWN_ROW_BG = ['bg-white hover:bg-slate-100/70', 'bg-slate-50/40 hover:bg-slate-100/70']

function rowStatusTint(status: string, index: number): string {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'live') return 'bg-emerald-50/60 hover:bg-emerald-100/70'
  if (normalized.startsWith('checkpoint')) return 'bg-amber-50/70 hover:bg-amber-100/80'
  if (normalized === 'die' || normalized === 'banned' || normalized === 'disabled') {
    return 'bg-rose-50/70 hover:bg-rose-100/80'
  }
  if (normalized === 'changed pass') return 'bg-sky-50/70 hover:bg-sky-100/80'
  return UNKNOWN_ROW_BG[index % 2]
}

/**
 * Persisted per-column widths for the resizable middle columns (everything
 * except the locked checkbox/row-number left edge and the locked Status
 * right edge — those never resize, so their widths never need saving).
 * Loaded once at module scope like the other localStorage-backed grid state
 * in this file (columnVisibility, threadCount) rather than routed through
 * the Zustand store — this is pure layout state, not domain data.
 */
function loadColumnWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COLUMN_WIDTHS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore corrupt/blocked storage — falls back to gridColumns.tsx defaults */
  }
  return {}
}

function saveColumnWidths(widths: Record<string, number>): void {
  try {
    localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(widths))
  } catch {
    /* ignore — e.g. storage disabled/full; resizing still works for this session */
  }
}

interface MenuState {
  x: number
  y: number
  account: Account
}

export function AccountsGrid(): React.JSX.Element {
  const accounts = useAccountStore((s) => s.accounts)
  const rowSelection = useAccountStore((s) => s.rowSelection)
  const toggleRow = useAccountStore((s) => s.toggleRow)
  const toggleAll = useAccountStore((s) => s.toggleAll)
  const setRowSelection = useAccountStore((s) => s.setRowSelection)
  const loading = useAccountStore((s) => s.loading)
  const columnVisibility = useAccountStore((s) => s.columnVisibility)

  const [menu, setMenu] = useState<MenuState | null>(null)

  // Drag-to-select: mousedown on a row starts a drag from that row's index;
  // while the mouse button is held, entering another row extends a
  // contiguous highlighted range between the anchor and the current row.
  // `lastClickedIndex` also anchors Shift+Click range selection, kept
  // separate from the drag anchor since a plain click (no drag) should still
  // update the shift-click anchor for the next click.
  const [dragAnchorIndex, setDragAnchorIndex] = useState<number | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const lastClickedIndexRef = useRef<number | null>(null)
  // Selection as it was when the current drag started. A Ctrl-drag adds its
  // range on top of this snapshot, so every mouseenter recomputes from the
  // original set rather than compounding onto the previous frame's result
  // (which would make rows dragged over and then back off stay selected).
  const dragBaseSelectionRef = useRef<Record<string, boolean>>({})

  const selectRange = (fromIndex: number, toIndex: number, additive = false): void => {
    const lo = Math.min(fromIndex, toIndex)
    const hi = Math.max(fromIndex, toIndex)
    // Additive (Ctrl held): start from the pre-drag selection and add the
    // range. Non-additive: the range becomes the entire selection.
    const next: Record<string, boolean> = additive ? { ...dragBaseSelectionRef.current } : {}
    for (let i = lo; i <= hi; i++) {
      const acc = accounts[i]
      if (acc) next[acc.id] = true
    }
    setRowSelection(next)
  }

  // A drag that never left its starting row is just a click (handled by the
  // row's own onClick) — only commit the drag-selected range on mouseup if
  // the drag actually moved across rows. Global mouseup listener so
  // releasing the button outside the grid still ends the drag cleanly.
  useEffect(() => {
    if (!isDragging) return
    const onMouseUp = (): void => setIsDragging(false)
    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [isDragging])

  // Persisted custom widths for the resizable middle columns — merged over
  // each column's built-in default width from gridColumns.tsx.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(loadColumnWidths)

  // Only render the columns the user has enabled, sized per columnWidths.
  const columns = useMemo(
    () =>
      GRID_COLUMNS.filter((c) => columnVisibility[c.key] !== false).map((c) => ({
        ...c,
        width: columnWidths[c.key] ?? c.width
      })),
    [columnVisibility, columnWidths]
  )

  // Drag-to-resize: mousedown on a header's resize handle captures the
  // column key + starting pointer X + starting width, then a window-level
  // mousemove/mouseup pair (not a per-handle listener) tracks the drag so it
  // keeps working even if the pointer moves off the thin handle itself.
  const resizeState = useRef<{ key: string; startX: number; startWidth: number } | null>(null)
  const [resizingKey, setResizingKey] = useState<string | null>(null)

  const beginResize = useCallback(
    (key: string, startWidth: number) => (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      resizeState.current = { key, startX: e.clientX, startWidth }
      setResizingKey(key)
    },
    []
  )

  useEffect(() => {
    if (!resizingKey) return
    const onMove = (e: MouseEvent): void => {
      const state = resizeState.current
      if (!state) return
      const delta = e.clientX - state.startX
      const next = Math.max(RESIZE_MIN_WIDTH, Math.min(RESIZE_MAX_WIDTH, state.startWidth + delta))
      setColumnWidths((prev) => ({ ...prev, [state.key]: next }))
    }
    const onUp = (): void => {
      resizeState.current = null
      setResizingKey(null)
      // Persist once at the end of the drag rather than on every pixel of
      // movement — setColumnWidths above already re-renders live during the
      // drag; this just avoids hammering localStorage on every mousemove.
      setColumnWidths((current) => {
        saveColumnWidths(current)
        return current
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [resizingKey])

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: accounts.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15
  })

  const allChecked = accounts.length > 0 && accounts.every((a) => rowSelection[a.id])
  const someChecked = accounts.some((a) => rowSelection[a.id]) && !allChecked

  const LEFT_EDGE_W = CHECKBOX_W + ROW_NUMBER_COLUMN.width
  const totalWidth = LEFT_EDGE_W + columns.reduce((sum, c) => sum + c.width, 0)
  const virtualRows = virtualizer.getVirtualItems()

  const cellBorder = 'border-r border-b border-[#b8cbb0]'
  const headBorder = 'border-r border-b border-slate-200'
  // The checkbox/row-number block used to be pinned via `sticky left-0` so
  // it stayed visible while middle columns scrolled underneath it. Removed:
  // every column (including this one) now scrolls together horizontally,
  // with nothing frozen in place — this constant is kept as an empty string
  // rather than deleted outright so the two render call sites below don't
  // need their own separate edits if a locked edge is ever reintroduced.
  const stickyLeft = ''

  const onRowContextMenu = (e: React.MouseEvent, a: Account): void => {
    e.preventDefault()
    // If the right-clicked row isn't part of the current selection, select just it.
    if (!rowSelection[a.id]) {
      setRowSelection({ [a.id]: true })
    }
    setMenu({ x: e.clientX, y: e.clientY, account: a })
  }

  return (
    <div className="flex w-full min-w-full flex-1 flex-col overflow-hidden rounded-md border-[1.5px] border-slate-300 bg-white shadow-sm">
      <div ref={parentRef} className="relative flex-1 overflow-auto">
        {/* Inner width = at least the window width, expanding to fit all columns */}
        <div className="w-full" style={{ minWidth: totalWidth }}>
          {/* Header — clean, flat bg-slate-100 (no pattern); text
              force-centered + semibold regardless of each column's own data
              alignment (left-aligned data cells still read naturally below
              a centered header label). */}
          <div className="sticky top-0 z-10 flex w-full bg-slate-100">
            {/* Checkbox + row number — fixed width, never resizable, but scrolls horizontally with everything else (not pinned/frozen). */}
            <div
              className={`flex shrink-0 items-center ${stickyLeft}`}
              style={{ width: LEFT_EDGE_W, height: ROW_HEIGHT }}
            >
              <div
                className={`flex h-full shrink-0 items-center justify-center ${headBorder}`}
                style={{ width: CHECKBOX_W }}
              >
                <input
                  type="checkbox"
                  className="accent-[#0078d4]"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked
                  }}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </div>
              <div
                className={`flex h-full shrink-0 items-center justify-center text-center text-2xs font-semibold text-slate-800 ${headBorder}`}
                style={{ width: ROW_NUMBER_COLUMN.width }}
              >
                {ROW_NUMBER_COLUMN.header}
              </div>
            </div>

            {/* Resizable middle columns */}
            {columns.map((c) => (
              <div
                key={c.key}
                className={`group relative flex shrink-0 items-center justify-center bg-transparent px-1.5 text-center text-2xs font-semibold text-slate-800 ${headBorder}`}
                style={{ width: c.width, height: ROW_HEIGHT }}
              >
                <span className="truncate">{c.header}</span>
                {/* Drag handle — a thin hit-zone straddling the header's right border. */}
                <div
                  className="absolute right-0 top-0 z-10 h-full w-1.5 -mr-0.5 cursor-col-resize hover:bg-[#0078d4]/40"
                  onMouseDown={beginResize(c.key, c.width)}
                />
              </div>
            ))}

            {/* Flexible filler so a short column set doesn't leave a gap of
                bare background after the last middle column. */}
            <div className={`flex-1 bg-transparent ${headBorder}`} />
          </div>

          {/* Body (virtualized) */}
          <div
            className="w-full"
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualRows.map((vRow) => {
              const a = accounts[vRow.index]
              const selected = !!rowSelection[a.id]
              // Every row's background is status-driven — never over the
              // selection highlight, though: a selected row must stay
              // clearly, unambiguously highlighted regardless of status.
              const rowBg = rowStatusTint(a.status ?? 'Unknown', vRow.index)
              return (
                <div
                  key={a.id}
                  className={`absolute left-0 flex w-full ${
                    selected ? 'bg-mc-sel text-mc-selText' : `${rowBg} text-[#1a1a1a]`
                  }`}
                  style={{ top: vRow.start, height: ROW_HEIGHT, userSelect: isDragging ? 'none' : undefined }}
                  onMouseDown={(e) => {
                    // Only the primary button starts a drag-select; a
                    // checkbox click already stops propagation before this
                    // fires, and right-click is handled separately below.
                    if (e.button !== 0) return
                    // Snapshot the selection at drag start so a Ctrl-drag can
                    // add to it (see selectRange's `additive` branch).
                    dragBaseSelectionRef.current = { ...rowSelection }
                    setDragAnchorIndex(vRow.index)
                    setIsDragging(true)
                  }}
                  onMouseEnter={(e) => {
                    if (isDragging && dragAnchorIndex !== null) {
                      // Ctrl/Cmd held -> add this range to the pre-drag
                      // selection; otherwise the range replaces it entirely.
                      selectRange(dragAnchorIndex, vRow.index, e.ctrlKey || e.metaKey)
                    }
                  }}
                  onClick={(e) => {
                    // A drag that moved across rows already committed its
                    // range on mouseenter — the trailing click on mouseup
                    // must not then collapse the selection back to one row.
                    if (dragAnchorIndex !== null && dragAnchorIndex !== vRow.index) {
                      lastClickedIndexRef.current = vRow.index
                      setDragAnchorIndex(null)
                      return
                    }
                    setDragAnchorIndex(null)
                    if (e.shiftKey && lastClickedIndexRef.current !== null) {
                      selectRange(lastClickedIndexRef.current, vRow.index, e.ctrlKey || e.metaKey)
                    } else if (e.ctrlKey || e.metaKey) {
                      // Ctrl+Click toggles just this row, preserving the rest
                      // of the selection (5 selected + 1 new = 6).
                      toggleRow(a.id, !selected)
                      lastClickedIndexRef.current = vRow.index
                    } else {
                      // Plain click resets the selection to exactly this row —
                      // 5 selected, click a 6th, and only that 6th stays
                      // selected. (toggleRow alone would leave the other 5.)
                      setRowSelection({ [a.id]: true })
                      lastClickedIndexRef.current = vRow.index
                    }
                  }}
                  onContextMenu={(e) => onRowContextMenu(e, a)}
                >
                  {/* Locked left edge: checkbox + row number — same fixed width as the header's, own background (matching the row's status tint) so it opaquely covers scrolled-under middle columns with no mismatched stripe. */}
                  <div
                    className={`flex shrink-0 items-center ${stickyLeft} ${
                      selected ? 'bg-mc-sel' : rowBg
                    }`}
                    style={{ width: LEFT_EDGE_W }}
                  >
                    <div
                      className={`flex h-full shrink-0 items-center justify-center ${cellBorder}`}
                      style={{ width: CHECKBOX_W }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        className="accent-[#0078d4]"
                        checked={selected}
                        onChange={(e) => toggleRow(a.id, e.target.checked)}
                      />
                    </div>
                    <div
                      className={`flex h-full shrink-0 items-center justify-center text-2xs ${cellBorder}`}
                      style={{ width: ROW_NUMBER_COLUMN.width }}
                    >
                      {ROW_NUMBER_COLUMN.render(a, vRow.index)}
                    </div>
                  </div>

                  {/* Resizable middle columns */}
                  {columns.map((c) => {
                    const extra = !selected && c.className ? c.className(a) : ''
                    return (
                      <div
                        key={c.key}
                        className={`flex shrink-0 items-center overflow-hidden whitespace-nowrap px-1.5 text-2xs ${cellBorder} ${extra}`}
                        style={{
                          width: c.width,
                          justifyContent:
                            c.align === 'center'
                              ? 'center'
                              : c.align === 'right'
                                ? 'flex-end'
                                : 'flex-start'
                        }}
                        title={c.title ? c.title(a) : String(c.render(a, vRow.index) ?? '')}
                      >
                        <span className="truncate">{c.render(a, vRow.index)}</span>
                      </div>
                    )
                  })}

                  {/* Flexible filler — matches the header's, so a short column set doesn't leave a gap of bare background. */}
                  <div className={`flex-1 ${cellBorder}`} />
                </div>
              )
            })}
          </div>
        </div>

        {!loading && accounts.length === 0 && (
          <div className="flex h-40 flex-col items-center justify-center gap-1 text-[12px] text-[#888]">
            <span>No accounts yet.</span>
            <span>
              Click{' '}
              <span className="font-semibold text-[#c07a00]">Import Accounts</span> to add
              your accounts.
            </span>
          </div>
        )}
      </div>

      {menu && (
        <AccountContextMenu
          x={menu.x}
          y={menu.y}
          account={menu.account}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
