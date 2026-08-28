// ---------------------------------------------------------------------------
// cloudSync.ts  — Device ID-based Cloud Sync via Firebase.
//   * Push: bundle account records + folder metadata + Chrome profile
//     folders into the exact same manifest+zip format backupIpc.ts already
//     uses for local backups, upload the zip to Firebase Storage, and write
//     a small pointer/metadata document to Firestore at
//     devices/{targetMachineId}.
//   * Pull: read that Firestore document, download the zip from Storage,
//     extract it, restore accounts into the "Receive Account" folder and
//     profile folders into resolveProfileDir(uid) — then, ONLY on success,
//     delete both the Firestore document and the Storage object so the
//     payload never lingers in the cloud past a single successful pull.
//
// See firebaseConfig.ts for how (and from where) this loads the project
// credentials needed to actually talk to a real Firebase project — none of
// it is hardcoded in source; it's resolved from a local .env / key file at
// runtime.
// ---------------------------------------------------------------------------
import { existsSync, createWriteStream } from 'fs'
import { mkdir, rm, readdir, readFile, cp } from 'fs/promises'
import { join, basename } from 'path'
import { app as electronApp } from 'electron'
import { initializeApp, cert, applicationDefault, getApps, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { ZipArchive, type ArchiverError } from 'archiver'
import * as unzipper from 'unzipper'
import * as accounts from '../db/accountsRepo'
import * as folders from '../db/foldersRepo'
import { resolveProfileDir } from '../automation/browserContext'
import { resolveServiceAccount, resolveStorageBucket, isFirebaseConfigured } from './firebaseConfig'
import type { BackupManifest, BackupAccountRecord } from '../../types/backup'
import { RECEIVE_ACCOUNT_FOLDER_NAME } from '../../types/backup'
import type { CloudPushResult, CloudPullResult } from '../../types/cloudSync'

let firebaseApp: App | null = null
let firestoreDb: Firestore | null = null

/** Lazily initializes the firebase-admin app on first real use, not at module load — a placeholder config should never throw just from importing this file. */
function getFirebase(): { db: Firestore } {
  if (!isFirebaseConfigured()) {
    throw new Error(
      'Cloud Sync is not configured — firebaseConfig.ts still has placeholder Firebase credentials. See the comments in that file for setup steps.'
    )
  }
  if (!firebaseApp) {
    const serviceAccount = resolveServiceAccount()
    const existing = getApps()
    firebaseApp =
      existing[0] ??
      initializeApp({
        credential: serviceAccount
          ? cert({
              projectId: serviceAccount.projectId,
              clientEmail: serviceAccount.clientEmail,
              privateKey: serviceAccount.privateKey
            })
          : applicationDefault(),
        storageBucket: resolveStorageBucket() ?? undefined
      })
    firestoreDb = getFirestore(firebaseApp)
  }
  return { db: firestoreDb! }
}

function tempWorkDir(label: string): string {
  return join(electronApp.getPath('temp'), `tfacebook-cloudsync-${label}-${Date.now()}`)
}

/** Builds the manifest + zip for the given accounts — identical shape/logic to backupIpc.ts's exportBackup(), factored out so both local backup and Cloud Sync stay in lock-step if the format ever changes. */
async function buildBackupZip(accountIds: number[], zipPath: string): Promise<{ manifest: BackupManifest; accountCount: number }> {
  const rows = accounts.getAccountsByIds(accountIds)
  if (rows.length === 0) {
    throw new Error('No accounts to push.')
  }

  const manifestAccounts: BackupAccountRecord[] = []
  const folderNames = new Set<string>()
  const profileDirs: { uid: string; dir: string }[] = []

  for (const a of rows) {
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
    const output = createWriteStream(zipPath)
    const archive = new ZipArchive({ zlib: { level: 6 } })
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    archive.on('warning', (err: ArchiverError) => {
      if (err.code !== 'ENOENT') reject(err)
    })
    archive.pipe(output)
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })
    for (const { uid, dir } of profileDirs) {
      archive.directory(dir, `profiles/${uid}`)
    }
    void archive.finalize()
  })

  return { manifest, accountCount: manifestAccounts.length }
}

/**
 * Push: bundles the given accounts (records + folders + profile folders)
 * into a zip identical in shape to a local backup, uploads it to Firebase
 * Storage, and writes a small metadata pointer document to Firestore at
 * devices/{targetMachineId}. Overwrites any payload already waiting there
 * for that target (last push wins) — this is a "send the current data to
 * this device" mailbox, not a queue.
 */
export async function pushToDevice(targetMachineId: string, accountIds: number[]): Promise<CloudPushResult> {
  const { db } = getFirebase()
  const workDir = tempWorkDir('push')
  await mkdir(workDir, { recursive: true })
  const zipPath = join(workDir, 'payload.zip')

  try {
    const { accountCount } = await buildBackupZip(accountIds, zipPath)

    const storagePath = `devices/${targetMachineId}/payload.zip`
    const bucket = getStorage(firebaseApp!).bucket()
    await bucket.upload(zipPath, { destination: storagePath })

    await db
      .collection('devices')
      .doc(targetMachineId)
      .set({
        storagePath,
        accountCount,
        createdAt: new Date().toISOString()
      })

    return { ok: true, accountCount, targetMachineId }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, message }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => void 0)
  }
}

/** {userData}/firebase-service-account.json — same path resolveServiceAccount() checks as its final fallback (see firebaseConfig.ts). Checked again here, explicitly, so a pull fails with an unambiguous message up front rather than surfacing an opaque firebase-admin auth error deeper in the call stack. */
function userDataKeyFilePath(): string {
  return join(electronApp.getPath('userData'), 'firebase-service-account.json')
}

/**
 * Pull: reads the pointer doc at devices/{machineId}, downloads the zip from
 * Storage, extracts it, restores accounts into "Receive Account" and
 * profile folders into resolveProfileDir(uid) — and ONLY if every step
 * above succeeds, deletes the Firestore document and the Storage object so
 * the payload doesn't linger in the cloud past this one successful pull. A
 * failure at any point leaves the cloud data untouched, so the user can
 * retry the pull rather than losing the payload to a failed first attempt.
 *
 * Every failure path returns rather than throws, with an explicit `message`
 * describing exactly what went wrong (missing key file, no pending payload,
 * a Storage download error, a corrupt archive, etc.) — the one exception is
 * a genuinely unexpected error, which the outer try/catch still converts to
 * the same { success: false, message } shape rather than letting it reject.
 */
export async function pullPendingPayload(targetMachineId: string): Promise<CloudPullResult> {
  const failure = (message: string): CloudPullResult => ({
    success: false,
    importedCount: 0,
    skippedCount: 0,
    profilesRestoredCount: 0,
    count: 0,
    message
  })

  const workDir = tempWorkDir('pull')

  try {
    // Only meaningful when no inline/env service account is configured
    // either — resolveServiceAccount() already checks this same path as its
    // last fallback, but a pull that's about to fail deep inside the
    // firebase-admin SDK with an opaque auth error is much harder to
    // diagnose than one that fails here with a plain, specific message.
    if (!resolveServiceAccount() && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const keyPath = userDataKeyFilePath()
      if (!existsSync(keyPath)) {
        throw new Error('Firebase Key file not found in fb-account-manager directory.')
      }
    }

    const { db } = getFirebase()
    await mkdir(workDir, { recursive: true })

    const docRef = db.collection('devices').doc(targetMachineId)
    const doc = await docRef.get()
    if (!doc.exists) {
      return failure('No pending sync package found for this Machine ID on Cloud.')
    }
    const data = doc.data() as { storagePath?: string }
    if (!data?.storagePath) {
      return failure('Cloud Sync record is malformed (missing storage path) — not deleting it automatically.')
    }

    const zipPath = join(workDir, 'payload.zip')
    const bucket = getStorage(firebaseApp!).bucket()
    try {
      await bucket.file(data.storagePath).download({ destination: zipPath })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return failure(message)
    }

    const extractDir = join(workDir, 'extracted')
    await mkdir(extractDir, { recursive: true })
    const dir = await unzipper.Open.file(zipPath)
    await dir.extract({ path: extractDir, concurrency: 4 })

    const manifestPath = join(extractDir, 'manifest.json')
    if (!existsSync(manifestPath)) {
      return failure('Downloaded payload is invalid (manifest.json missing) — not deleting the cloud record.')
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest

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
      const inserted = accounts.insertAccounts([
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
      if (inserted > 0) importedCount++
      else skippedCount++
    }

    let profilesRestoredCount = 0
    const extractedProfilesDir = join(extractDir, 'profiles')
    if (existsSync(extractedProfilesDir)) {
      const uidDirs = await readdir(extractedProfilesDir)
      for (const uid of uidDirs) {
        const src = join(extractedProfilesDir, uid)
        const dest = resolveProfileDir(basename(uid))
        await mkdir(dest, { recursive: true })
        await cp(src, dest, { recursive: true, force: true })
        profilesRestoredCount++
      }
    }

    // Everything above succeeded — auto-delete the cloud copy now, per spec.
    // Deliberately AFTER the local restore is fully complete, not before:
    // deleting first and then failing the restore would lose the data
    // entirely with no way to retry.
    await bucket.file(data.storagePath).delete().catch(() => void 0)
    await docRef.delete()

    return {
      success: true,
      importedCount,
      skippedCount,
      profilesRestoredCount,
      count: importedCount,
      message: `Pulled ${importedCount} account(s) and restored ${profilesRestoredCount} profile(s) into "${RECEIVE_ACCOUNT_FOLDER_NAME}". Cloud copy deleted.`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return failure(message)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => void 0)
  }
}
