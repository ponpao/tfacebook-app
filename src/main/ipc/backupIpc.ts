// ---------------------------------------------------------------------------
// backupIpc.ts  — Backup (export to .zip) and Restore (import from .zip) for
// account records, folder assignments, and Chrome profile folders.
//
// Archive layout:
//   manifest.json         <- BackupManifest (accounts + referenced folder names)
//   profiles/{uid}/...    <- one directory per account that has a profile,
//                            copied verbatim from resolveProfileDir(uid)
//
// Export streams everything through `archiver` (zip) rather than buffering
// in memory — Chrome profile folders can be tens/hundreds of MB each once
// Cache/IndexedDB/LevelDB are included, and a batch backup could cover many
// accounts at once.
// ---------------------------------------------------------------------------
import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import { createWriteStream, existsSync } from 'fs'
import { mkdir, rm, readdir, readFile, cp } from 'fs/promises'
import { join, basename } from 'path'
import { ZipArchive, type Archiver, type ArchiverError } from 'archiver'
import * as unzipper from 'unzipper'
import { IPC } from './channels'
import * as accounts from '../db/accountsRepo'
import * as folders from '../db/foldersRepo'
import { resolveProfileDir, isTracked, closeTrackedContext } from '../automation/browserContext'
import type { BackupManifest, BackupAccountRecord, BackupExportResult, BackupImportResult } from '../../types/backup'
import { RECEIVE_ACCOUNT_FOLDER_NAME } from '../../types/backup'

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

/** Recursively adds a directory's contents into the archive under `destDir`, skipping nothing — a profile folder's exact contents (cookies, Local Storage, etc.) all need to round-trip. */
function addDirectoryToArchive(archive: Archiver, sourceDir: string, destDir: string): void {
  archive.directory(sourceDir, destDir)
}

/**
 * Exports the given accounts (by id) — their DB records, folder names, and
 * (if present on disk) their Chrome profile folders — into a single .zip
 * the user picks a save location for via the native OS dialog. Accounts
 * with no on-disk profile folder are still included in the manifest with
 * `hasProfile: false` (e.g. one that's never actually been opened yet).
 */
async function exportBackup(win: BrowserWindow | undefined, accountIds: number[]): Promise<BackupExportResult> {
  const rows = accounts.getAccountsByIds(accountIds)
  if (rows.length === 0) {
    return { ok: false, message: 'No accounts to back up.' }
  }

  const result = await dialog.showSaveDialog(win as BrowserWindow, {
    title: 'Save Backup As',
    defaultPath: `tfacebook_backup_${todayStamp()}.zip`,
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) {
    return { ok: false, message: 'Backup canceled.' }
  }

  const manifestAccounts: BackupAccountRecord[] = []
  const folderNames = new Set<string>()
  const profileDirs: { uid: string; dir: string }[] = []
  const closedOpenProfiles: string[] = []

  for (const a of rows) {
    // See closeTrackedContext()'s doc comment: a live Chrome process holds
    // locks on / buffers writes to the profile's SQLite files, so zipping
    // it while still open can silently drop or corrupt session state.
    if (a.uid && isTracked(a.uid)) {
      await closeTrackedContext(a.uid)
      closedOpenProfiles.push(a.uid)
    }

    const hasProfile = !!a.uid && existsSync(resolveProfileDir(a.uid))
    if (hasProfile && a.uid) profileDirs.push({ uid: a.uid, dir: resolveProfileDir(a.uid) })
    if (a.folder_name) folderNames.add(a.folder_name)

    manifestAccounts.push({
      uid: a.uid,
      password: a.password,
      two_fa: a.two_fa,
      email: a.email,
      email_pass: a.email_pass,
      mail_server: a.mail_server,
      name: a.name,
      dob: a.dob,
      created_date: a.created_date,
      location: a.location,
      gender: a.gender,
      friends_count: a.friends_count,
      groups_count: a.groups_count,
      cookie: a.cookie,
      token: a.token,
      proxy: a.proxy,
      avatar: a.avatar,
      user_agent: a.user_agent,
      last_active: a.last_active,
      status: a.status,
      status_detail: a.status_detail,
      live_status: a.live_status,
      notes: a.notes,
      folder_name: a.folder_name ?? null,
      hasProfile
    })
  }

  const manifest: BackupManifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    accounts: manifestAccounts,
    folders: [...folderNames].map((name) => ({ name }))
  }

  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(result.filePath!)
    const archive = new ZipArchive({ zlib: { level: 6 } })

    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    // A single file/entry failing to read (e.g. a locked LevelDB lock file
    // held by a live browser) shouldn't abort the whole backup — archiver
    // emits 'warning' for ENOENT-class issues and keeps going.
    archive.on('warning', (err: ArchiverError) => {
      if (err.code !== 'ENOENT') reject(err)
    })

    archive.pipe(output)
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })
    for (const { uid, dir } of profileDirs) {
      addDirectoryToArchive(archive, dir, `profiles/${uid}`)
    }
    void archive.finalize()
  })

  const message =
    closedOpenProfiles.length > 0
      ? `Closed ${closedOpenProfiles.length} open browser profile(s) first to capture a clean session.`
      : undefined
  return { ok: true, filePath: result.filePath, accountCount: manifestAccounts.length, message }
}

/**
 * Imports a .zip backup: extracts to a temp directory, reads manifest.json,
 * inserts/merges the account records (assigned into the "Receive Account"
 * folder, created if missing — matched accounts by uid are updated in
 * place rather than duplicated), and restores each included profile folder
 * back to its resolveProfileDir(uid) location.
 */
async function importBackup(win: BrowserWindow | undefined, explicitZipPath?: string): Promise<BackupImportResult> {
  let zipPath = explicitZipPath
  if (!zipPath) {
    const result = await dialog.showOpenDialog(win as BrowserWindow, {
      title: 'Select Backup Zip',
      properties: ['openFile'],
      filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, importedCount: 0, skippedCount: 0, profilesRestoredCount: 0, message: 'Import canceled.' }
    }
    zipPath = result.filePaths[0]
  }

  const tempDir = join(app.getPath('temp'), `tfacebook-restore-${Date.now()}`)
  await mkdir(tempDir, { recursive: true })

  try {
    const dir = await unzipper.Open.file(zipPath)
    await dir.extract({ path: tempDir, concurrency: 4 })

    const manifestPath = join(tempDir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      return {
        success: false,
        importedCount: 0,
        skippedCount: 0,
        profilesRestoredCount: 0,
        message: 'Invalid backup — manifest.json not found in the zip.'
      }
    }
    const manifestRaw = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(manifestRaw) as BackupManifest

    // Destination folder: always "Receive Account" per spec, created if it
    // doesn't already exist — regardless of what folder(s) the accounts
    // originally belonged to at export time (those names are recorded in
    // the manifest for reference/future use, but the restore destination is
    // fixed so a batch import always lands somewhere predictable).
    const allFolders = folders.getAllFolders()
    const receiveFolder =
      allFolders.find((f) => f.name === RECEIVE_ACCOUNT_FOLDER_NAME) ?? folders.createFolder(RECEIVE_ACCOUNT_FOLDER_NAME)

    let importedCount = 0
    let skippedCount = 0
    for (const rec of manifest.accounts) {
      if (!rec.uid) {
        skippedCount++
        continue
      }
      // upsertAccountsByUid: a uid that already exists locally still gets
      // its cookie/token/status refreshed from the imported data, matching
      // the profile folder this same restore overwrites on disk below —
      // otherwise the DB's session fields and the freshly-restored profile
      // folder can disagree, and a browser launch right after a restore
      // might not actually come up logged in.
      const { inserted, updated } = accounts.upsertAccountsByUid([
        {
          uid: rec.uid,
          password: rec.password,
          two_fa: rec.two_fa,
          email: rec.email,
          email_pass: rec.email_pass,
          mail_server: rec.mail_server,
          name: rec.name,
          dob: rec.dob,
          created_date: rec.created_date,
          location: rec.location,
          gender: rec.gender,
          friends_count: rec.friends_count,
          groups_count: rec.groups_count,
          cookie: rec.cookie,
          token: rec.token,
          proxy: rec.proxy,
          avatar: rec.avatar,
          user_agent: rec.user_agent,
          last_active: rec.last_active,
          status: rec.status,
          status_detail: rec.status_detail,
          live_status: rec.live_status,
          notes: rec.notes,
          folder_id: receiveFolder.id
        }
      ])
      // A uid that already existed locally gets updated>0 instead of
      // inserted>0 — still worth restoring its profile folder below (the
      // whole point of a restore), just not double-counted as a newly
      // imported account.
      if (inserted > 0 || updated > 0) importedCount++
      else skippedCount++
    }

    // Restore each included profile folder — copy (not move, tempDir gets
    // cleaned up after) from the extracted profiles/{uid} into the real
    // profile location this app's browser automation actually reads from.
    let profilesRestoredCount = 0
    const extractedProfilesDir = join(tempDir, 'profiles')
    if (existsSync(extractedProfilesDir)) {
      const uidDirs = await readdir(extractedProfilesDir)
      for (const uid of uidDirs) {
        // Close this UID's browser first if it happens to be open — writing
        // a restored profile folder over one Chromium still has open would
        // be fighting an active process for the same files.
        if (isTracked(uid)) await closeTrackedContext(uid)
        const src = join(extractedProfilesDir, uid)
        const dest = resolveProfileDir(basename(uid))
        await mkdir(dest, { recursive: true })
        await copyDirRecursive(src, dest)
        profilesRestoredCount++
      }
    }

    return {
      success: true,
      importedCount,
      skippedCount,
      profilesRestoredCount,
      message: `Imported ${importedCount} account(s), restored ${profilesRestoredCount} profile(s) into "${RECEIVE_ACCOUNT_FOLDER_NAME}".`
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => void 0)
  }
}

/** Recursively copies `src` into `dest` via fs.promises.cp (Node 16.7+ — well within this app's Electron/Node runtime, so no manual walk-and-copy loop is needed). */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true, force: true })
}

export function registerBackupIpcHandlers(): void {
  ipcMain.handle(IPC.backup.export, async (e, accountIds: number[]) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    try {
      return await exportBackup(win, accountIds)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `Backup failed: ${message}` } satisfies BackupExportResult
    }
  })

  ipcMain.handle(IPC.backup.import, async (e, explicitPath?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    try {
      const outcome = await importBackup(win, explicitPath)
      // Notify the renderer to refresh the grid + folder manager — the
      // caller's own IPC response already carries the summary, but a
      // broadcast event lets any open window/component react without
      // needing to thread the result through props.
      if (outcome.success) {
        for (const w of BrowserWindow.getAllWindows()) {
          w.webContents.send(IPC.backup.onImported, outcome)
        }
      }
      return outcome
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        importedCount: 0,
        skippedCount: 0,
        profilesRestoredCount: 0,
        message: `Restore failed: ${message}`
      } satisfies BackupImportResult
    }
  })
}
