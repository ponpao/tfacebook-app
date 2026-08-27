// ---------------------------------------------------------------------------
// gridColumns.tsx  — shared column definitions for the accounts grid.
// Consumed by AccountsGrid (rendering) and ColumnVisibilityModal (toggles).
//
// Only the checkbox + row-number form the locked left edge (see
// ROW_NUMBER_COLUMN + AccountsGrid.tsx's CHECKBOX_W) — every other column,
// including Status and Activity Status, is a normal resizable middle column
// with its own drag-to-resize handle and RESIZE_MIN_WIDTH/RESIZE_MAX_WIDTH
// bounds. Status previously had its own locked/sticky-right treatment; that's
// been removed so it behaves exactly like every other column.
// ---------------------------------------------------------------------------
import type { Account } from '../../../types/account'
import { useAccountStore } from '../../store/useAccountStore'

export interface GridColumn {
  key: string
  header: string
  width: number
  align?: 'left' | 'center' | 'right'
  render: (a: Account, index: number) => React.ReactNode
  className?: (a: Account) => string
  /** Plain-string value for the cell's hover title (used when render() returns JSX). */
  title?: (a: Account) => string
  /** Drag-to-resize bounds — every column in GRID_COLUMNS is resizable within these. */
  minWidth?: number
  maxWidth?: number
}

export const RESIZE_MIN_WIDTH = 70
export const RESIZE_MAX_WIDTH = 600

export const STATUS_COLOR: Record<string, string> = {
  Live: 'text-[#1e9e4a] font-semibold',
  Checkpoint: 'text-[#c98a00] font-semibold',
  Die: 'text-[#c81e1e] font-semibold',
  'Changed Pass': 'text-[#d1721c] font-semibold',
  Unknown: 'text-[#6b7280]'
}

/** Masked, click-to-copy cell for the (long, sensitive) cookie string. */
function CookieCell({ cookie }: { cookie: string | null }): React.ReactNode {
  if (!cookie) return ''
  const masked = cookie.length > 18 ? `${cookie.slice(0, 12)}…${cookie.slice(-4)}` : cookie
  const copy = (e: React.MouseEvent): void => {
    e.stopPropagation() // don't toggle the row selection
    void navigator.clipboard.writeText(cookie)
    const toast = useAccountStore.getState().showToast
    toast('Cookie copied to clipboard')
  }
  return (
    <span
      className="cursor-pointer font-mono text-[#0067c0] hover:underline"
      title="Click to copy full cookie"
      onClick={copy}
    >
      {masked} 📋
    </span>
  )
}

/**
 * Locked left-edge column — row number. Rendered alongside the checkbox in a
 * fixed, non-resizable, sticky-left block (see AccountsGrid.tsx); not part
 * of GRID_COLUMNS since it can't be hidden/resized/reordered like the rest.
 * This and the checkbox are the ONLY two locked columns in the grid.
 */
export const ROW_NUMBER_COLUMN: GridColumn = {
  key: 'stt',
  header: 'No.',
  width: 40,
  align: 'center',
  render: (_a, i) => i + 1
}

// Column order below matches the spec's numbered sequence exactly (UID,
// Password, 2FA, Mail, Pass Mail, Name, Friends, Proxy, Primary Location,
// Cookie, Created Date, Status, Activity Status). `key` values are this
// app's real `accounts` table column names (e.g. `two_fa`, `email_pass`,
// `location`, `created_date`, `live_status`) — the spec's ids
// (twoFactorSecret, mailPassword, primaryLocation, createdAt,
// activityStatus) are descriptive labels, not actual schema fields.
export const GRID_COLUMNS: GridColumn[] = [
  { key: 'uid', header: 'UID', width: 140, render: (a) => a.uid ?? '' },
  { key: 'password', header: 'Password', width: 120, render: (a) => a.password ?? '' },
  { key: 'two_fa', header: '2FA', width: 140, render: (a) => a.two_fa ?? '' },
  { key: 'email', header: 'Mail', width: 180, render: (a) => a.email ?? '' },
  {
    key: 'email_pass',
    header: 'Pass Mail',
    width: 130,
    render: (a) => a.email_pass ?? ''
  },
  { key: 'name', header: 'Name', width: 130, render: (a) => a.name ?? '' },
  {
    key: 'friends_count',
    header: 'Friends',
    width: 80,
    align: 'right',
    render: (a) => a.friends_count ?? 0
  },
  { key: 'proxy', header: 'Proxy', width: 150, render: (a) => a.proxy ?? '' },
  {
    key: 'location',
    header: 'Primary Location',
    width: 140,
    render: (a) => a.location ?? ''
  },
  {
    key: 'cookie',
    header: 'Cookie',
    width: 160,
    render: (a) => <CookieCell cookie={a.cookie} />,
    title: (a) => (a.cookie ? 'Click to copy full cookie' : '')
  },
  {
    key: 'created_date',
    header: 'Created Date',
    width: 130,
    align: 'center',
    render: (a) => a.created_date ?? ''
  },
  {
    key: 'status',
    header: 'Status',
    width: 110,
    align: 'center',
    render: (a) => a.status ?? 'Unknown',
    className: (a) => STATUS_COLOR[a.status] ?? 'text-[#c81e1e]'
  },
  {
    key: 'live_status',
    header: 'Activity Status',
    width: 160,
    render: (a) => a.live_status ?? ''
  }
]

/** All columns visible by default. */
export const DEFAULT_COLUMN_VISIBILITY: Record<string, boolean> = Object.fromEntries(
  GRID_COLUMNS.map((c) => [c.key, true])
)
