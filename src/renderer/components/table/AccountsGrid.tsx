// ---------------------------------------------------------------------------
// AccountsGrid.tsx  — classic WinForms DataGridView-style grid.
//   * pastel-green rows, deep-blue selection with white text
//   * compact ~26px rows, visible inner gridlines
//   * virtualized for thousands of rows (@tanstack/react-virtual)
//   * column visibility driven by the store
//   * right-click context menu with account actions
// ---------------------------------------------------------------------------
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
const UNKNOWN_ROW_BG = ['bg-surface hover:bg-surface-sunken', 'bg-surface-sunken/40 hover:bg-surface-sunken']

// Each status tint pairs a light-mode pastel with a matching dark-mode tint
// that stays a visible, saturated hue against the dark surface instead of
// going muddy/near-black — plain `bg-emerald-50` etc. render almost
// indistinguishable from the base dark background with default text on top.
function rowStatusTint(status: string, index: number): string {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'live') {
    return 'bg-emerald-50/60 hover:bg-emerald-100/70 dark:bg-emerald-500/15 dark:hover:bg-emerald-500/25'
  }
  if (normalized.startsWith('checkpoint')) {
    return 'bg-amber-50/70 hover:bg-amber-100/80 dark:bg-amber-500/15 dark:hover:bg-amber-500/25'
  }
  if (normalized === 'die' || normalized === 'banned' || normalized === 'disabled') {
    return 'bg-rose-50/70 hover:bg-rose-100/80 dark:bg-rose-500/15 dark:hover:bg-rose-500/25'
  }
  if (normalized === 'changed pass') {
    return 'bg-sky-50/70 hover:bg-sky-100/80 dark:bg-sky-500/15 dark:hover:bg-sky-500/25'
  }
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

// ---------------------------------------------------------------------------
// Excel-like column auto-fit (double-click the resize divider) & header sort.
// ---------------------------------------------------------------------------

const AUTO_FIT_PADDING = 16
const AUTO_FIT_CELL_FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const AUTO_FIT_HEADER_FONT = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

// A single shared offscreen canvas 2D context for measureText() — created
// lazily once and reused for every measurement instead of allocating a new
// canvas per call.
let measureCtx: CanvasRenderingContext2D | null | undefined
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx
  try {
    measureCtx = document.createElement('canvas').getContext('2d')
  } catch {
    measureCtx = null
  }
  return measureCtx
}

function textWidth(text: string, font: string): number {
  const ctx = getMeasureCtx()
  if (!ctx) return text.length * 7 // rough fallback if canvas is unavailable
  ctx.font = font
  return ctx.measureText(text).width
}

/** Plain-string value of a cell for both auto-fit measurement and sorting — prefers the column's own title() (already a flattened string even when render() returns JSX), falling back to String(render()). */
function cellText(c: (typeof GRID_COLUMNS)[number], a: Account, index: number): string {
  if (c.title) return c.title(a)
  const v = c.render(a, index)
  if (v == null) return ''
  return typeof v === 'string' || typeof v === 'number' ? String(v) : ''
}

/**
 * Auto-fit a column to its widest current cell (double-click the resize
 * divider) — Excel's own behavior. Measures every currently-loaded row's
 * text via canvas font metrics rather than each rendered cell's DOM
 * scrollWidth: the grid is virtualized, so most rows have no DOM node to
 * measure at all. RESIZE_MAX_WIDTH still caps the result so one extreme
 * outlier value (a raw cookie string, say) can't blow the column out.
 */
function autoFitWidth(c: (typeof GRID_COLUMNS)[number], accounts: Account[]): number {
  let max = textWidth(c.header, AUTO_FIT_HEADER_FONT)
  for (let i = 0; i < accounts.length; i++) {
    const w = textWidth(cellText(c, accounts[i], i), AUTO_FIT_CELL_FONT)
    if (w > max) max = w
  }
  const fitted = Math.ceil(max) + AUTO_FIT_PADDING
  return Math.max(RESIZE_MIN_WIDTH, Math.min(RESIZE_MAX_WIDTH, fitted))
}

type SortDir = 'asc' | 'desc'

/** Numeric for count-like/ID columns, date for Created Date, case-insensitive string for everything else (Name, Status, UID, …) — matches the spec's three sort types. */
function compareBySortKey(a: Account, b: Account, key: string, index_a: number, index_b: number, columns: typeof GRID_COLUMNS): number {
  const col = columns.find((c) => c.key === key)
  if (!col) return 0
  const rawA = col.render(a, index_a)
  const rawB = col.render(b, index_b)

  if (key === 'created_date') {
    const ta = a.created_date ? Date.parse(a.created_date) : NaN
    const tb = b.created_date ? Date.parse(b.created_date) : NaN
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0
    if (Number.isNaN(ta)) return -1
    if (Number.isNaN(tb)) return 1
    return ta - tb
  }

  const numA = typeof rawA === 'number' ? rawA : Number(rawA)
  const numB = typeof rawB === 'number' ? rawB : Number(rawB)
  if (!Number.isNaN(numA) && !Number.isNaN(numB) && (typeof rawA === 'number' || typeof rawB === 'number')) {
    return numA - numB
  }

  const strA = (col.title ? col.title(a) : String(rawA ?? '')).toLowerCase()
  const strB = (col.title ? col.title(b) : String(rawB ?? '')).toLowerCase()
  return strA.localeCompare(strB)
}

interface MenuState {
  x: number
  y: number
  account: Account
}

interface GridRowProps {
  account: Account
  index: number
  selected: boolean
  virtualStart: number
  columns: Array<(typeof GRID_COLUMNS)[number] & { width: number }>
  isDragging: boolean
  stickyLeft: string
  LEFT_EDGE_W: number
  cellBorder: string
  onRowMouseDown: (index: number, e: React.MouseEvent) => void
  onRowMouseEnter: (index: number, e: React.MouseEvent) => void
  onRowClick: (index: number, a: Account, selected: boolean, e: React.MouseEvent) => void
  onRowContextMenu: (e: React.MouseEvent, a: Account) => void
  onToggleRow: (id: number, checked: boolean) => void
}

const GridRow = memo(function GridRow({
  account: a,
  index,
  selected,
  virtualStart,
  columns,
  isDragging,
  stickyLeft,
  LEFT_EDGE_W,
  cellBorder,
  onRowMouseDown,
  onRowMouseEnter,
  onRowClick,
  onRowContextMenu,
  onToggleRow
}: GridRowProps) {
  const rowBg = rowStatusTint(a.status ?? 'Unknown', index)
  return (
    <div
      className={`absolute left-0 flex w-full ${
        selected ? 'bg-accent text-white' : `${rowBg} text-ink`
      }`}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: ROW_HEIGHT,
        transform: `translateY(${virtualStart}px)`,
        willChange: 'transform',
        userSelect: isDragging ? 'none' : undefined
      }}
      onMouseDown={(e) => onRowMouseDown(index, e)}
      onMouseEnter={(e) => onRowMouseEnter(index, e)}
      onClick={(e) => onRowClick(index, a, selected, e)}
      onContextMenu={(e) => onRowContextMenu(e, a)}
    >
      {/* Locked left edge: checkbox + row number */}
      <div
        className={`flex shrink-0 items-center ${stickyLeft} ${
          selected ? 'bg-accent' : rowBg
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
            className="accent-accent"
            checked={selected}
            onChange={(e) => onToggleRow(a.id, e.target.checked)}
          />
        </div>
        <div
          className={`flex h-full shrink-0 items-center justify-center text-2xs ${cellBorder}`}
          style={{ width: ROW_NUMBER_COLUMN.width }}
        >
          {ROW_NUMBER_COLUMN.render(a, index)}
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
            title={c.title ? c.title(a) : String(c.render(a, index) ?? '')}
          >
            <span className="truncate">{c.render(a, index)}</span>
          </div>
        )
      })}

      {/* Flexible filler */}
      <div className={`flex-1 ${cellBorder}`} />
    </div>
  )
})

export function AccountsGrid(): React.JSX.Element {
  const rawAccounts = useAccountStore((s) => s.accounts)
  const rowSelection = useAccountStore((s) => s.rowSelection)
  const toggleRow = useAccountStore((s) => s.toggleRow)
  const toggleAll = useAccountStore((s) => s.toggleAll)
  const setRowSelection = useAccountStore((s) => s.setRowSelection)
  const loading = useAccountStore((s) => s.loading)
  const columnVisibility = useAccountStore((s) => s.columnVisibility)

  // Header click sort: Unsorted -> Ascending -> Descending -> Unsorted, one
  // column at a time. Applied client-side over whatever rows are currently
  // loaded — doesn't touch the store's own fetch/query. Declared here (ahead
  // of selectRange/drag-selection below, both of which index into the
  // user-visible `accounts` array) so sorted rows, not raw fetch order,
  // drive selection-by-index everywhere else in this component.
  const [sortState, setSortState] = useState<{ key: string; dir: SortDir } | null>(null)

  const onHeaderClick = useCallback((key: string) => {
    setSortState((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
  }, [])

  const accounts = useMemo(() => {
    if (!sortState) return rawAccounts
    const { key, dir } = sortState
    const withIndex = rawAccounts.map((a, i) => ({ a, i }))
    withIndex.sort((x, y) => {
      const cmp = compareBySortKey(x.a, y.a, key, x.i, y.i, GRID_COLUMNS)
      return dir === 'asc' ? cmp : -cmp
    })
    return withIndex.map((w) => w.a)
  }, [rawAccounts, sortState])

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
  const dragBaseSelectionRef = useRef<Record<string, boolean>>({})
  // Selection as it was when the current drag started. A Ctrl-drag adds its
  // range on top of this snapshot, so every mouseenter recomputes from the
  // original set rather than compounding onto the previous frame's result
  // (which would make rows dragged over and then back off stay selected).
  const selectRange = useCallback(
    (fromIndex: number, toIndex: number, additive = false): void => {
      const lo = Math.min(fromIndex, toIndex)
      const hi = Math.max(fromIndex, toIndex)
      const next: Record<string, boolean> = additive ? { ...dragBaseSelectionRef.current } : {}
      for (let i = lo; i <= hi; i++) {
        const acc = accounts[i]
        if (acc) next[acc.id] = true
      }
      setRowSelection(next)
    },
    [accounts, setRowSelection]
  )

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

  // Auto-scroll while drag-selecting past the visible top/bottom edge. The
  // virtualizer only renders rows currently in the viewport, so a row that
  // hasn't scrolled into view yet can never fire its own onMouseEnter — a
  // cursor held still at the edge (the whole point of this feature) never
  // reaches it through the per-row handlers alone. This effect instead
  // drives BOTH the scroll and the range extension itself, keyed off the
  // cursor's last known Y position, independent of row-level mouse events.
  const dragPointerYRef = useRef<number | null>(null)
  const dragCtrlHeldRef = useRef(false)
  useEffect(() => {
    if (!isDragging) return
    const el = parentRef.current
    if (!el) return

    const EDGE_ZONE_PX = 36
    const MAX_SCROLL_PX_PER_FRAME = 18

    const onMove = (e: MouseEvent): void => {
      dragPointerYRef.current = e.clientY
      dragCtrlHeldRef.current = e.ctrlKey || e.metaKey
    }
    document.addEventListener('mousemove', onMove)

    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const y = dragPointerYRef.current
      if (y == null) return
      const rect = el.getBoundingClientRect()

      const distFromTop = y - rect.top
      const distFromBottom = rect.bottom - y
      let delta = 0
      if (distFromTop >= 0 && distFromTop < EDGE_ZONE_PX) {
        // Closer to the edge -> faster scroll, capped at MAX_SCROLL_PX_PER_FRAME.
        delta = -Math.ceil(MAX_SCROLL_PX_PER_FRAME * (1 - distFromTop / EDGE_ZONE_PX))
      } else if (distFromBottom >= 0 && distFromBottom < EDGE_ZONE_PX) {
        delta = Math.ceil(MAX_SCROLL_PX_PER_FRAME * (1 - distFromBottom / EDGE_ZONE_PX))
      }
      if (delta === 0) return

      const before = el.scrollTop
      el.scrollTop = before + delta
      if (el.scrollTop === before) return // hit the top/bottom of the list

      // Extend the selection to whatever row is now under the cursor —
      // since that row may never have rendered/fired its own mouseenter
      // (it just scrolled into view this frame), recompute directly from
      // the new scroll offset instead of waiting for a DOM event.
      if (dragAnchorIndex !== null) {
        const rowsFromTop = Math.floor((el.scrollTop + (y - rect.top)) / ROW_HEIGHT)
        const targetIndex = Math.max(0, Math.min(accounts.length - 1, rowsFromTop))
        selectRange(dragAnchorIndex, targetIndex, dragCtrlHeldRef.current)
      }
    }
    raf = requestAnimationFrame(tick)

    return () => {
      document.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(raf)
      dragPointerYRef.current = null
    }
  }, [isDragging, dragAnchorIndex, accounts.length, selectRange])

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

  // Double-click a column's resize divider to auto-fit it to its widest
  // current cell (Excel's own behavior) — measures via canvas font metrics
  // over `accounts` (see autoFitWidth) since the virtualized grid has no DOM
  // node for most rows to read scrollWidth from.
  const onAutoFitColumn = useCallback(
    (key: string) => {
      const col = GRID_COLUMNS.find((c) => c.key === key)
      if (!col) return
      const width = autoFitWidth(col, accounts)
      setColumnWidths((prev) => {
        const next = { ...prev, [key]: width }
        saveColumnWidths(next)
        return next
      })
    },
    [accounts]
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
    overscan: 8
  })

  const { allChecked, someChecked } = useMemo(() => {
    if (accounts.length === 0) return { allChecked: false, someChecked: false }
    let count = 0
    for (const a of accounts) {
      if (rowSelection[a.id]) count++
    }
    return {
      allChecked: count === accounts.length,
      someChecked: count > 0 && count < accounts.length
    }
  }, [accounts, rowSelection])

  const LEFT_EDGE_W = CHECKBOX_W + ROW_NUMBER_COLUMN.width
  const totalWidth = LEFT_EDGE_W + columns.reduce((sum, c) => sum + c.width, 0)
  const virtualRows = virtualizer.getVirtualItems()

  const cellBorder = 'border-r border-b border-edge'
  const headBorder = 'border-r border-b border-edge'
  const stickyLeft = ''

  const onRowContextMenu = useCallback((e: React.MouseEvent, a: Account): void => {
    e.preventDefault()
    if (!useAccountStore.getState().rowSelection[a.id]) {
      setRowSelection({ [a.id]: true })
    }
    setMenu({ x: e.clientX, y: e.clientY, account: a })
  }, [setRowSelection])

  const onRowMouseDown = useCallback((index: number, e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragBaseSelectionRef.current = { ...useAccountStore.getState().rowSelection }
    setDragAnchorIndex(index)
    setIsDragging(true)
  }, [])

  const onRowMouseEnter = useCallback(
    (index: number, e: React.MouseEvent) => {
      if (isDragging && dragAnchorIndex !== null) {
        selectRange(dragAnchorIndex, index, e.ctrlKey || e.metaKey)
      }
    },
    [isDragging, dragAnchorIndex, selectRange]
  )

  const onRowClick = useCallback(
    (index: number, a: Account, selected: boolean, e: React.MouseEvent) => {
      if (dragAnchorIndex !== null && dragAnchorIndex !== index) {
        lastClickedIndexRef.current = index
        setDragAnchorIndex(null)
        return
      }
      setDragAnchorIndex(null)
      if (e.shiftKey && lastClickedIndexRef.current !== null) {
        selectRange(lastClickedIndexRef.current, index, e.ctrlKey || e.metaKey)
      } else if (e.ctrlKey || e.metaKey) {
        toggleRow(a.id, !selected)
        lastClickedIndexRef.current = index
      } else {
        setRowSelection({ [a.id]: true })
        lastClickedIndexRef.current = index
      }
    },
    [dragAnchorIndex, selectRange, toggleRow, setRowSelection]
  )

  return (
    <div className="flex w-full flex-1 flex-col overflow-hidden rounded-xl border border-edge bg-surface select-none">
      <div ref={parentRef} className="relative flex-1 overflow-x-auto overflow-y-auto">
        {/* Inner width = at least the window width, expanding to fit all columns */}
        <div className="w-full" style={{ minWidth: totalWidth }}>
          {/* Header */}
          <div className="sticky top-0 z-10 flex w-full bg-surface-sunken">
            {/* Checkbox + row number */}
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
                  className="accent-accent"
                  checked={allChecked}
                  ref={(el) => {
                    if (el) el.indeterminate = someChecked
                  }}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </div>
              <div
                className={`flex h-full shrink-0 items-center justify-center text-center text-2xs font-semibold text-ink ${headBorder}`}
                style={{ width: ROW_NUMBER_COLUMN.width }}
              >
                {ROW_NUMBER_COLUMN.header}
              </div>
            </div>

            {/* Resizable + sortable middle columns */}
            {columns.map((c) => (
              <div
                key={c.key}
                className={`group relative flex shrink-0 cursor-pointer select-none items-center justify-center gap-0.5 bg-transparent px-1.5 text-center text-2xs font-semibold text-ink hover:bg-surface-sunken ${headBorder}`}
                style={{ width: c.width, height: ROW_HEIGHT }}
                onClick={(e) => {
                  // Defense-in-depth alongside the resize handle's own
                  // stopPropagation calls: never sort if the click actually
                  // landed on the resizer (e.g. a future handle variant that
                  // forgets to stop propagation shouldn't silently regress
                  // into double-toggling sort on every column resize).
                  if ((e.target as HTMLElement).closest('[data-col-resize-handle]')) return
                  onHeaderClick(c.key)
                }}
                title="Click to sort"
              >
                <span className="truncate">{c.header}</span>
                {sortState?.key === c.key && (
                  <span className="text-accent">{sortState.dir === 'asc' ? '▲' : '▼'}</span>
                )}
                <div
                  data-col-resize-handle="true"
                  className="absolute right-0 top-0 z-10 h-full w-1.5 -mr-0.5 cursor-col-resize hover:bg-accent/40"
                  onClick={(e) => {
                    // A double-click fires click -> click -> dblclick on this
                    // element; each of those two intermediate `click`s bubbles
                    // to the header div's onClick (sort toggle) unless stopped
                    // here too — stopping only mousedown/dblclick isn't enough,
                    // since it's the click events in between that were
                    // actually reaching onHeaderClick and toggling sort twice
                    // on every auto-fit double-click.
                    e.stopPropagation()
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation() // don't trigger the header's own sort-click
                    beginResize(c.key, c.width)(e)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    e.preventDefault()
                    onAutoFitColumn(c.key)
                  }}
                  title="Double-click to auto-fit"
                />
              </div>
            ))}

            <div className={`flex-1 bg-transparent ${headBorder}`} />
          </div>

          {/* Body (virtualized + GPU hardware composited) */}
          <div
            className="w-full"
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {virtualRows.map((vRow) => {
              const a = accounts[vRow.index]
              if (!a) return null
              return (
                <GridRow
                  key={a.id}
                  account={a}
                  index={vRow.index}
                  selected={!!rowSelection[a.id]}
                  virtualStart={vRow.start}
                  columns={columns}
                  isDragging={isDragging}
                  stickyLeft={stickyLeft}
                  LEFT_EDGE_W={LEFT_EDGE_W}
                  cellBorder={cellBorder}
                  onRowMouseDown={onRowMouseDown}
                  onRowMouseEnter={onRowMouseEnter}
                  onRowClick={onRowClick}
                  onRowContextMenu={onRowContextMenu}
                  onToggleRow={toggleRow}
                />
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
