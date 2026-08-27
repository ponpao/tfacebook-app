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
//      — this is the path a packaged/distributed build should use, since it
//      ships no .env and nothing under the install directory is meant to be
//      writable/secret-holding. {userData} is Electron's per-app data folder
//      (%APPDATA%\TFACEBOOK on Windows), well outside source control and
//      outside the installed program files tree.
//   4. GOOGLE_APPLICATION_CREDENTIALS (left to firebase-admin itself via
//      applicationDefault()) if none of the above are set.
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
//        (c) Drop the downloaded file at
//            %APPDATA%\TFACEBOOK\firebase-service-account.json (this is
//            the option for a packaged build, with no .env present).
//   3. Set FIREBASE_STORAGE_BUCKET (in .env) to the project's bucket name
//      (usually `{projectId}.appspot.com` or `{projectId}.firebasestorage.app`).
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

/** {userData}/firebase-service-account.json — the drop-in path for a packaged build (no .env available). */
function userDataKeyFilePath(): string {
  return join(app.getPath('userData'), 'firebase-service-account.json')
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

  return loadFromKeyFile(userDataKeyFilePath())
}

/** The project's Storage bucket, e.g. 'your-project-id.firebasestorage.app'. Set via FIREBASE_STORAGE_BUCKET in .env. */
export function resolveStorageBucket(): string | null {
  return process.env.FIREBASE_STORAGE_BUCKET || null
}

/** True once a service account (from any source above) and a storage bucket are both resolvable. */
export function isFirebaseConfigured(): boolean {
  if (!resolveStorageBucket()) return false
  // A null service account is still "configured" if GOOGLE_APPLICATION_CREDENTIALS
  // is set, since applicationDefault() will pick it up — but if neither an
  // explicit service account NOR that env var is present, there's nothing
  // for firebase-admin to authenticate with at all.
  if (!resolveServiceAccount() && !process.env.GOOGLE_APPLICATION_CREDENTIALS) return false
  return true
}
