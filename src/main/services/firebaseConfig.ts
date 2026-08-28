// ---------------------------------------------------------------------------
// firebaseConfig.ts  — Cloud Sync's Firebase project credentials.
//
// Nothing secret lives in this file (or anywhere else in source) — the
// service account key is loaded at runtime from, in order of preference:
//
//   1. A local JSON key file, path given by FIREBASE_SERVICE_ACCOUNT_PATH
//      (set in a project-root .env for dev, see .env.example).
//   2. Individual FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
//      FIREBASE_PRIVATE_KEY env vars (also settable via .env).
//   3. A JSON key file dropped at {userData}/firebase-service-account.json
//      — {userData} is Electron's per-app data folder
//      (%APPDATA%\fb-account-manager on Windows), well outside source
//      control and outside the installed program files tree.
//   4. A JSON key file placed next to the packaged install (either the
//      folder above resources/app.asar, or the app's own root as reported
//      by app.getAppPath()) — for a packaged build where dropping a file
//      into %APPDATA% isn't convenient, e.g. an installer that bundles the
//      key file as an extra resource next to the .exe.
//   5. GOOGLE_APPLICATION_CREDENTIALS (left to firebase-admin itself via
//      applicationDefault()) if none of the above are set.
//
// A key file found via (3) or (4) fully configures Firebase by itself: its
// own project_id/client_email/private_key fields are all firebase-admin
// needs, so isFirebaseConfigured() does NOT also require
// FIREBASE_STORAGE_BUCKET to be set in that case — it derives the bucket
// from the key file's project_id (`{projectId}.appspot.com`) unless
// FIREBASE_STORAGE_BUCKET is explicitly set to override that guess.
//
// index.ts loads the project-root .env (via dotenv) before anything else
// runs, so process.env is already populated by the time this module is
// first imported.
//
// To enable Cloud Sync for real:
//   1. In the Firebase Console for your project: Project Settings ->
//      Service Accounts -> "Generate new private key". This downloads a
//      JSON file — never commit it or paste its contents anywhere public.
//   2. Do ONE of:
//        (a) Copy .env.example to .env and set FIREBASE_SERVICE_ACCOUNT_PATH
//            to that downloaded file's path.
//        (b) Copy .env.example to .env and fill in FIREBASE_PROJECT_ID /
//            FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY from the JSON's
//            matching fields.
//        (c) Drop the downloaded file, renamed to
//            firebase-service-account.json, at
//            %APPDATA%\fb-account-manager\firebase-service-account.json
//            (this is the option for a packaged build, with no .env
//            present) — no other configuration is needed once this file
//            exists there.
//   3. Optional: set FIREBASE_STORAGE_BUCKET (in .env) if the project's
//      bucket name doesn't match the default `{projectId}.appspot.com`
//      guess (e.g. it's `{projectId}.firebasestorage.app` instead).
//   4. Make sure Cloud Firestore and Cloud Storage are enabled for the
//      project (Firestore holds the small `devices/{machineId}` metadata
//      document; Storage holds the zipped account+profile bundle, since
//      Firestore's 1MB/document limit can't hold a real profile folder).
//
// .env is gitignored (see .gitignore) so none of this ever reaches source
// control — see .env.example for the template of what to fill in.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface ServiceAccountConfig {
  projectId: string
  clientEmail: string
  privateKey: string
}

interface RawServiceAccountJson {
  project_id?: string
  client_email?: string
  private_key?: string
}

const KEY_FILE_NAME = 'firebase-service-account.json'

/** {userData}/firebase-service-account.json — the drop-in path for a packaged build (no .env available). */
function userDataKeyFilePath(): string {
  return join(app.getPath('userData'), KEY_FILE_NAME)
}

/**
 * Other places a packaged build might reasonably have the key file dropped
 * next to it, for setups where writing into %APPDATA% isn't how the key
 * gets distributed (e.g. it ships as an extra resource alongside the
 * installed app instead). Wrapped in try/catch: process.resourcesPath is
 * undefined outside a packaged Electron app (e.g. under ts-node in a
 * script), and app.getAppPath() can throw before the app is ready in rare
 * startup orderings — neither should ever crash a credentials lookup.
 */
function packagedInstallKeyFilePaths(): string[] {
  const paths: string[] = []
  try {
    if (process.resourcesPath) {
      paths.push(join(process.resourcesPath, '..', KEY_FILE_NAME))
    }
  } catch {
    /* process.resourcesPath not meaningful here — not a packaged build */
  }
  try {
    paths.push(join(app.getAppPath(), KEY_FILE_NAME))
  } catch {
    /* app.getAppPath() unavailable this early — ignore */
  }
  return paths
}

function loadFromKeyFile(path: string): ServiceAccountConfig | null {
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf8')) as RawServiceAccountJson
    if (!raw.project_id || !raw.client_email || !raw.private_key) return null
    return { projectId: raw.project_id, clientEmail: raw.client_email, privateKey: raw.private_key }
  } catch {
    return null
  }
}

function loadFromEnvFields(): ServiceAccountConfig | null {
  const projectId = process.env.FIREBASE_PROJECT_ID
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
  if (!projectId || !clientEmail || !privateKey) return null
  // .env files can't hold literal newlines in a single-line value, so a key
  // pasted there typically has its line breaks escaped as "\n" — un-escape.
  return { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }
}

/**
 * Resolves the service account to use, checking each source in order.
 * Returns null if none are configured (GOOGLE_APPLICATION_CREDENTIALS, if
 * set, is left for firebase-admin's own applicationDefault() to pick up —
 * cloudSync.ts already falls back to that when this returns null).
 */
export function resolveServiceAccount(): ServiceAccountConfig | null {
  const explicitPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
  if (explicitPath) {
    const fromExplicitPath = loadFromKeyFile(explicitPath)
    if (fromExplicitPath) return fromExplicitPath
  }

  const fromEnvFields = loadFromEnvFields()
  if (fromEnvFields) return fromEnvFields

  const fromUserData = loadFromKeyFile(userDataKeyFilePath())
  if (fromUserData) return fromUserData

  for (const path of packagedInstallKeyFilePaths()) {
    const fromPackagedInstall = loadFromKeyFile(path)
    if (fromPackagedInstall) return fromPackagedInstall
  }

  return null
}

/**
 * The project's Storage bucket. Prefers an explicit FIREBASE_STORAGE_BUCKET
 * override (needed when the real bucket name doesn't match the default
 * guess below — e.g. it's `{projectId}.firebasestorage.app` instead), but
 * falls back to deriving `{projectId}.appspot.com` from a resolved service
 * account so a key-file-only setup (no .env at all) still works without any
 * separate bucket configuration step.
 */
export function resolveStorageBucket(): string | null {
  if (process.env.FIREBASE_STORAGE_BUCKET) return process.env.FIREBASE_STORAGE_BUCKET
  const serviceAccount = resolveServiceAccount()
  return serviceAccount ? `${serviceAccount.projectId}.appspot.com` : null
}

/**
 * True once Firebase can actually be initialized: either a service account
 * was resolved from any source above (a key file alone is enough — its
 * project_id derives a usable storage bucket automatically, see
 * resolveStorageBucket()), or GOOGLE_APPLICATION_CREDENTIALS is set for
 * firebase-admin's applicationDefault() to pick up (in which case an
 * explicit FIREBASE_STORAGE_BUCKET is required, since there's no key file
 * here to derive a bucket name from).
 */
export function isFirebaseConfigured(): boolean {
  if (resolveServiceAccount()) return true
  return !!process.env.GOOGLE_APPLICATION_CREDENTIALS && !!process.env.FIREBASE_STORAGE_BUCKET
}
