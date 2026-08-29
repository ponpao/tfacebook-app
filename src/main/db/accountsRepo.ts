// ---------------------------------------------------------------------------
// accountsRepo.ts  — all SQL for the `accounts` table lives here.
// ---------------------------------------------------------------------------
import { getDb } from './database'
import { DEFAULT_FOLDER_ID } from './schema'
import type {
  Account,
  AccountListResult,
  AccountQuery,
  AccountStats,
  AccountUpdate,
  NewAccount
} from '../../types/account'
import { ALL_FOLDERS } from '../../types/folder'

// Columns a NewAccount / AccountUpdate is allowed to write.
const WRITABLE_COLUMNS = [
  'uid',
  'password',
  'two_fa',
  'email',
  'email_pass',
  'mail_server',
  'name',
  'dob',
  'created_date',
  'location',
  'gender',
  'friends_count',
  'groups_count',
  'cookie',
  'token',
  'proxy',
  'avatar',
  'user_agent',
  'last_active',
  'status',
  'status_detail',
  'live_status',
  'profile_dir',
  'backup_data',
  'notes',
  'folder_id'
] as const

/** Columns the free-text search can target. */
const SEARCH_FIELDS: Record<string, string> = {
  uid: 'a.uid',
  email: 'a.email',
  name: 'a.name',
  proxy: 'a.proxy'
}

/** Bulk insert accounts inside a single transaction. Duplicates on `uid` are
 *  ignored (INSERT OR IGNORE). Returns number actually inserted. */
export function insertAccounts(accounts: NewAccount[]): number {
  const db = getDb()
  const cols = WRITABLE_COLUMNS
  const placeholders = cols.map((c) => `@${c}`).join(', ')
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO accounts (${cols.join(', ')}) VALUES (${placeholders})`
  )

  const insertMany = db.transaction((rows: NewAccount[]) => {
    let count = 0
    for (const row of rows) {
      // Build a full param object with nulls for missing fields.
      const params: Record<string, unknown> = {}
      for (const c of cols) {
        const v = (row as Record<string, unknown>)[c]
        params[c] = v === undefined ? (c === 'friends_count' || c === 'groups_count' ? 0 : null) : v
      }
      if (params.status == null) params.status = 'Unknown'
      // New accounts land in the default folder unless told otherwise.
      if (params.folder_id == null) params.folder_id = DEFAULT_FOLDER_ID
      const info = stmt.run(params)
      count += info.changes
    }
    return count
  })

  return insertMany(accounts)
}

/**
 * Like insertAccounts(), but for a UID that already exists locally, refreshes
 * the session-critical fields (cookie, token, status, status_detail,
 * live_status, last_active) instead of silently no-op'ing via INSERT OR
 * IGNORE. Used by Backup import and Cloud Sync pull: both restore a profile
 * folder onto disk unconditionally, but insertAccounts() alone would leave
 * an existing row's stale cookie/token in place if the UID already existed
 * locally — the restored profile folder and the DB's session fields would
 * then disagree, and a subsequent browser launch could still see a stale
 * cookie for a session that's actually still valid in the newly-restored
 * profile, or vice versa. Deliberately narrow: does not touch name, notes,
 * proxy, folder assignment, or anything else a user may have edited locally.
 * Returns { inserted, updated } counts.
 */
export function upsertAccountsByUid(rows: NewAccount[]): { inserted: number; updated: number } {
  const db = getDb()
  const findStmt = db.prepare('SELECT id FROM accounts WHERE uid = ? AND is_deleted = 0')
  const updateStmt = db.prepare(
    `UPDATE accounts SET cookie = @cookie, token = @token, status = @status,
     status_detail = @status_detail, live_status = @live_status, last_active = @last_active
     WHERE id = @id`
  )

  let updated = 0
  const toInsert: NewAccount[] = []

  const run = db.transaction((items: NewAccount[]) => {
    for (const row of items) {
      if (!row.uid) {
        toInsert.push(row)
        continue
      }
      const existing = findStmt.get(row.uid) as { id: number } | undefined
      if (!existing) {
        toInsert.push(row)
        continue
      }
      updateStmt.run({
        id: existing.id,
        cookie: row.cookie ?? null,
        token: row.token ?? null,
        status: row.status ?? 'Unknown',
        status_detail: row.status_detail ?? null,
        live_status: row.live_status ?? null,
        last_active: row.last_active ?? null
      })
      updated += 1
    }
  })
  run(rows)

  const inserted = toInsert.length > 0 ? insertAccounts(toInsert) : 0
  return { inserted, updated }
}

/** Paginated + filtered + sorted list. Joins the folder name. Excludes soft-deleted rows. */
export function listAccounts(query: AccountQuery = {}): AccountListResult {
  const db = getDb()
  const clauses: string[] = ['a.is_deleted = 0']
  const params: Record<string, unknown> = {}

  if (query.search && query.search.trim()) {
    params.q = `%${query.search.trim()}%`
    const field = query.searchField && SEARCH_FIELDS[query.searchField]
    if (field) {
      clauses.push(`${field} LIKE @q`)
    } else {
      clauses.push(
        `(a.uid LIKE @q OR a.email LIKE @q OR a.name LIKE @q OR a.proxy LIKE @q OR a.notes LIKE @q)`
      )
    }
  }
  if (query.status && query.status !== 'All') {
    clauses.push(`a.status = @status`)
    params.status = query.status
  }
  if (query.folderId != null && query.folderId !== ALL_FOLDERS) {
    clauses.push(`a.folder_id = @folderId`)
    params.folderId = query.folderId
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

  // Whitelist sort column to avoid injection.
  const sortBy =
    query.sortBy && WRITABLE_COLUMNS.includes(query.sortBy as never)
      ? `a.${query.sortBy}`
      : 'a.id'
  // Default ASC (oldest/first-inserted first) so newly imported accounts —
  // inserted with the next-highest autoincrement id, in the exact order they
  // were parsed from the pasted text — always land at the BOTTOM of the grid
  // rather than jumping to the top. Only an explicit sortDir: 'desc' request
  // (e.g. a user-driven column-header sort) reverses this.
  const sortDir = query.sortDir === 'desc' ? 'DESC' : 'ASC'

  const limit = query.limit && query.limit > 0 ? query.limit : 1000
  const offset = query.offset && query.offset > 0 ? query.offset : 0

  const total = (
    db
      .prepare(`SELECT COUNT(*) as c FROM accounts a ${where}`)
      .get(params) as { c: number }
  ).c

  const rows = db
    .prepare(
      `SELECT a.*, f.name AS folder_name
       FROM accounts a
       LEFT JOIN folders f ON f.id = a.folder_id
       ${where}
       ORDER BY ${sortBy} ${sortDir}
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit, offset }) as Account[]

  return { rows, total }
}

export function getAccount(id: number): Account | null {
  const db = getDb()
  return (
    (db
      .prepare(
        `SELECT a.*, f.name AS folder_name
         FROM accounts a LEFT JOIN folders f ON f.id = a.folder_id
         WHERE a.id = ?`
      )
      .get(id) as Account) ?? null
  )
}

/** Bulk fetch by id, for exports/backups. Excludes soft-deleted rows. Order not guaranteed to match `ids`. */
export function getAccountsByIds(ids: number[]): Account[] {
  if (ids.length === 0) return []
  const db = getDb()
  const placeholders = ids.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT a.*, f.name AS folder_name
       FROM accounts a LEFT JOIN folders f ON f.id = a.folder_id
       WHERE a.id IN (${placeholders}) AND a.is_deleted = 0`
    )
    .all(...ids) as Account[]
}

/** Patch a single account. Only whitelisted columns are written. */
export function updateAccount(id: number, patch: AccountUpdate): Account | null {
  const db = getDb()
  const entries = Object.entries(patch).filter(([k]) =>
    WRITABLE_COLUMNS.includes(k as never)
  )
  if (entries.length === 0) return getAccount(id)

  const setSql = entries.map(([k]) => `${k} = @${k}`).join(', ')
  const params: Record<string, unknown> = { id }
  for (const [k, v] of entries) params[k] = v

  db.prepare(`UPDATE accounts SET ${setSql} WHERE id = @id`).run(params)
  return getAccount(id)
}

/** Update status (+ optional detail) for many accounts at once. */
export function updateStatus(ids: number[], status: string, detail?: string): number {
  if (ids.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(
    `UPDATE accounts SET status = @status, status_detail = @detail WHERE id = @id`
  )
  const tx = db.transaction((list: number[]) => {
    let n = 0
    for (const id of list) n += stmt.run({ id, status, detail: detail ?? null }).changes
    return n
  })
  return tx(ids)
}

/**
 * Assign a single column to many accounts, each with its own value —
 * used by bulk Proxy / Useragent distribution (sequential, random, or
 * shared-per-N assignment is computed by the caller; this just writes it).
 */
export function bulkAssignField(
  column: 'proxy' | 'user_agent',
  assignments: { id: number; value: string }[]
): number {
  if (assignments.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(`UPDATE accounts SET ${column} = @value WHERE id = @id`)
  const tx = db.transaction((list: { id: number; value: string }[]) => {
    let n = 0
    for (const { id, value } of list) n += stmt.run({ id, value }).changes
    return n
  })
  return tx(assignments)
}

/**
 * Set the same value on one column across many accounts at once — used by
 * the grid's batch context-menu actions (Set/Clear Notes, Clear Activity
 * Status). Deliberately narrow-typed to the specific columns those actions
 * touch, not a generic "any column" endpoint.
 */
export function bulkSetField(column: 'notes' | 'live_status' | 'proxy', ids: number[], value: string): number {
  if (ids.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(`UPDATE accounts SET ${column} = @value WHERE id = @id`)
  const tx = db.transaction((list: number[]) => {
    let n = 0
    for (const id of list) n += stmt.run({ id, value }).changes
    return n
  })
  return tx(ids)
}

// ---------------------------------------------------------------------------
// Soft-delete / Recycle Bin
// ---------------------------------------------------------------------------

/** Move accounts to the Recycle Bin (excluded from all normal listings). */
export function softDeleteAccounts(ids: number[]): number {
  if (ids.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(
    `UPDATE accounts SET is_deleted = 1, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`
  )
  const tx = db.transaction((list: number[]) => {
    let n = 0
    for (const id of list) n += stmt.run(id).changes
    return n
  })
  return tx(ids)
}

/** List every soft-deleted account, most recently deleted first. */
export function getDeletedAccounts(): Account[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT a.*, f.name AS folder_name
       FROM accounts a
       LEFT JOIN folders f ON f.id = a.folder_id
       WHERE a.is_deleted = 1
       ORDER BY a.deleted_at DESC`
    )
    .all() as Account[]
}

/** Restore accounts from the Recycle Bin back to the active account list. */
export function restoreAccounts(ids: number[]): number {
  if (ids.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(
    `UPDATE accounts SET is_deleted = 0, deleted_at = NULL WHERE id = ? AND is_deleted = 1`
  )
  const tx = db.transaction((list: number[]) => {
    let n = 0
    for (const id of list) n += stmt.run(id).changes
    return n
  })
  return tx(ids)
}

/**
 * Permanently remove accounts from SQLite. Returns the removed rows'
 * `profile_dir` values (non-null) so the caller can clean up the matching
 * Playwright profile folders on disk.
 */
export function permanentDeleteAccounts(ids: number[]): { removed: number; uids: (string | null)[] } {
  if (ids.length === 0) return { removed: 0, uids: [] }
  const db = getDb()
  const selectStmt = db.prepare(`SELECT uid FROM accounts WHERE id = ?`)
  const deleteStmt = db.prepare(`DELETE FROM accounts WHERE id = ?`)
  const tx = db.transaction((list: number[]) => {
    let removed = 0
    const uids: (string | null)[] = []
    for (const id of list) {
      const row = selectStmt.get(id) as { uid: string | null } | undefined
      uids.push(row?.uid ?? null)
      removed += deleteStmt.run(id).changes
    }
    return { removed, uids }
  })
  return tx(ids)
}

/** Permanently remove every account currently in the Recycle Bin. */
export function emptyRecycleBin(): { removed: number; uids: (string | null)[] } {
  const db = getDb()
  const ids = (
    db.prepare(`SELECT id FROM accounts WHERE is_deleted = 1`).all() as { id: number }[]
  ).map((r) => r.id)
  return permanentDeleteAccounts(ids)
}

/** Aggregate dashboard stats in a single pass. */
export function getStats(): AccountStats {
  const db = getDb()
  const rows = db
    .prepare(`SELECT status, COUNT(*) as c FROM accounts GROUP BY status`)
    .all() as { status: string; c: number }[]

  const stats: AccountStats = {
    total: 0,
    live: 0,
    checkpoint: 0,
    die: 0,
    changed: 0,
    unknown: 0,
    error: 0,
    proxies: 0
  }

  for (const { status, c } of rows) {
    stats.total += c
    switch (status) {
      case 'Live':
        stats.live += c
        break
      case 'Checkpoint':
        stats.checkpoint += c
        break
      case 'Die':
        stats.die += c
        break
      case 'Changed Pass':
        stats.changed += c
        break
      case 'Unknown':
        stats.unknown += c
        break
      default:
        stats.error += c // any custom/error state
    }
  }

  stats.proxies = (
    db.prepare(`SELECT COUNT(*) as c FROM proxies`).get() as { c: number }
  ).c

  return stats
}

// ---------------------------------------------------------------------------
// Duplicate detection (Tools & Utilities — Remove Duplicate Accounts)
// ---------------------------------------------------------------------------

/** Find every account sharing a UID with an earlier (lower id) account. */
export function findDuplicateAccounts(): Account[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT a.* FROM accounts a
       WHERE a.is_deleted = 0
         AND a.uid IS NOT NULL AND a.uid <> ''
         AND a.id > (
           SELECT MIN(b.id) FROM accounts b
           WHERE b.uid = a.uid AND b.is_deleted = 0
         )
       ORDER BY a.uid, a.id`
    )
    .all() as Account[]
}

/** Soft-delete every duplicate UID row, keeping the oldest account for each UID. */
export function removeDuplicateAccounts(): number {
  const duplicates = findDuplicateAccounts()
  return softDeleteAccounts(duplicates.map((a) => a.id))
}
