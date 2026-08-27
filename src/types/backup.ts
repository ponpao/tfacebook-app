// ---------------------------------------------------------------------------
// backup.ts  — shared shapes for the Backup/Restore (Zip) feature. The
// actual archive-building/extraction logic lives in
// src/main/ipc/backupIpc.ts; this file is the IPC-safe subset importable
// from preload/renderer code.
// ---------------------------------------------------------------------------

/**
 * The single JSON file (`manifest.json`) written at the root of every backup
 * zip — the account/folder records plus a pointer to where each account's
 * profile folder lives inside the archive. Chrome profile folders are large
 * and already well-structured on disk, so they're stored as their own
 * directory tree under `profiles/{uid}/...` in the zip rather than being
 * serialized into this JSON — the manifest just records which accounts have
 * one included.
 */
export interface BackupManifest {
  /** Bumped only if the on-disk shape of this manifest changes incompatibly. */
  formatVersion: 1
  createdAt: string
  /** Account records, in NewAccount shape (no id/created_at/updated_at — those are re-assigned fresh on import to avoid clobbering an existing local id). */
  accounts: BackupAccountRecord[]
  /** Folder names referenced by accounts.folder_name, so a restore can recreate them if missing (rather than only ever using the fallback "Receive Account" folder). */
  folders: { name: string }[]
}

/** One account's exported fields, plus whether its profile folder is included in the archive and under what path. */
export interface BackupAccountRecord {
  uid: string | null
  password: string | null
  two_fa: string | null
  email: string | null
  email_pass: string | null
  mail_server: string | null
  name: string | null
  dob: string | null
  created_date: string | null
  location: string | null
  gender: string | null
  friends_count: number
  cookie: string | null
  token: string | null
  proxy: string | null
  avatar: string | null
  user_agent: string | null
  last_active: string | null
  status: string
  status_detail: string | null
  live_status: string | null
  notes: string | null
  /** The folder this account belonged to at export time — used to recreate/match the folder on restore. Null = was in no folder / default. */
  folder_name: string | null
  /** True if a `profiles/{uid}/` directory for this account is included in the zip. */
  hasProfile: boolean
}

export interface BackupExportResult {
  ok: boolean
  filePath?: string
  accountCount?: number
  message?: string
}

export interface BackupImportResult {
  success: boolean
  importedCount: number
  skippedCount: number
  profilesRestoredCount: number
  message?: string
}

/** Name of the folder every restored account is placed into, per spec. Created automatically if it doesn't already exist. */
export const RECEIVE_ACCOUNT_FOLDER_NAME = 'Receive Account'
