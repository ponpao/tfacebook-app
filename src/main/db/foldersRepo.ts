// ---------------------------------------------------------------------------
// foldersRepo.ts  — SQL for the `folders` table + account/folder relations.
// ---------------------------------------------------------------------------
import { getDb } from './database'
import { DEFAULT_FOLDER_ID } from './schema'
import type { Folder } from '../../types/folder'

/** All folders with a live account count per folder. */
export function getAllFolders(): Folder[] {
  return getDb()
    .prepare(
      `SELECT f.id, f.name, f.created_at, COUNT(a.id) AS account_count
       FROM folders f
       LEFT JOIN accounts a ON a.folder_id = f.id
       GROUP BY f.id
       ORDER BY f.id ASC`
    )
    .all() as Folder[]
}

export function createFolder(name: string): Folder {
  const db = getDb()
  const info = db.prepare(`INSERT INTO folders (name) VALUES (?)`).run(name.trim())
  return db
    .prepare(
      `SELECT id, name, created_at, 0 AS account_count FROM folders WHERE id = ?`
    )
    .get(info.lastInsertRowid) as Folder
}

export function renameFolder(id: number, newName: string): void {
  getDb().prepare(`UPDATE folders SET name = ? WHERE id = ?`).run(newName.trim(), id)
}

/**
 * Delete a folder and reassign its accounts to `fallbackFolderId`
 * (default folder). The default folder itself cannot be deleted.
 */
export function deleteFolder(
  id: number,
  fallbackFolderId: number = DEFAULT_FOLDER_ID
): boolean {
  if (id === DEFAULT_FOLDER_ID) return false
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(`UPDATE accounts SET folder_id = @fb WHERE folder_id = @id`).run({
      fb: fallbackFolderId,
      id
    })
    db.prepare(`DELETE FROM folders WHERE id = ?`).run(id)
  })
  tx()
  return true
}

/** Move a set of accounts into a target folder. Returns rows affected. */
export function moveAccountsToFolder(
  accountIds: number[],
  targetFolderId: number
): number {
  if (accountIds.length === 0) return 0
  const db = getDb()
  const stmt = db.prepare(`UPDATE accounts SET folder_id = @folder WHERE id = @id`)
  const tx = db.transaction((ids: number[]) => {
    let n = 0
    for (const id of ids) n += stmt.run({ folder: targetFolderId, id }).changes
    return n
  })
  return tx(accountIds)
}
