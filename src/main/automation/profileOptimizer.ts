// ---------------------------------------------------------------------------
// profileOptimizer.ts  — Profile storage cleanup for persistent browser
// profiles (see browserContext.ts's resolveProfileDir()).
//   * MODE_SAFE_FB_ONLY: aggressively deletes Chromium bloat — caches, the
//     Service Worker store, component-updater/model directories, history/
//     favicon/journal files, and temp/log/singleton scatter — while strictly
//     preserving the files that hold an actual logged-in session (cookies,
//     Local Storage's leveldb, Preferences, Local State). Also vacuums the
//     cookie SQLite database after deleting non-Facebook cookie rows, which
//     is what actually shrinks that file on disk (a plain DELETE leaves the
//     freed pages allocated to the file until VACUUMed). Target: well under
//     10MB per profile post-clean, without logging the account out.
//   * MODE_FULL_WIPE: deletes the entire profile directory outright.
// A profile currently open in a tracked browser context is refused for
// either mode — deleting/rewriting files a running Chromium instance has
// open is unsafe on Windows (locked files) and can corrupt the profile.
//
// Directory shape this operates on (confirmed against a real profile created
// by browserContext.ts's chromium.launchPersistentContext(profileDir, ...) —
// Playwright produces the full standard Chrome user-data-dir layout, not a
// flat folder):
//   {profileDir}/
//     Local State                      <- root-level, preserved
//     BrowserMetrics, Crashpad, ShaderCache, component_crx_cache, ...  <- root-level bloat
//     Default/
//       Cookies, Network/Cookies       <- preserved (login session)
//       Local Storage/leveldb/...      <- preserved (login session)
//       Preferences, Secure Preferences <- preserved
//       Cache, GPUCache, Service Worker, History, Favicons, ...  <- bloat
// ---------------------------------------------------------------------------
import { statSync, rmSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { resolveProfileDir, isTracked } from './browserContext'
import type { CleanMode, CleanResult, CleanSummary } from '../../types/profileOptimizer'

export type { CleanMode, CleanResult, CleanSummary }

// Root-level bloat — component updaters, ML model stores, crash/shader
// caches, and misc Chromium telemetry directories that sit alongside
// Default/ rather than inside it.
const ROOT_BLOAT_PATHS = [
  'WidevineCdm',
  'OptimizationGuidePredictionModels',
  'optimization_guide_model_store',
  'OnDeviceHeadSuggestModel',
  'ZxcvbnData',
  'SafetyTips',
  'SSLErrorAssistant',
  'Recovery',
  'OriginTrials',
  'Subresource Filter',
  'Trust Tokens',
  'Crashpad',
  'BrowserMetrics',
  'ShaderCache',
  'GrShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache', // same category as DawnCache/GraphiteDawnCache — WebGPU shader cache, not in the spec's list but confirmed multi-MB bloat on a real profile
  'GraphiteDawnCache',
  'GPUCache', // Playwright/Chromium also place a GPU shader cache at the profile root, not just under Default/
  'component_crx_cache',
  'extensions_crx_cache',
  'segmentation_platform',
  'Safe Browsing',
  'CrashpadMetrics-active.pma'
]

// Bloat inside Default/ — the actual browsing-data caches and history stores.
const DEFAULT_BLOAT_PATHS = [
  // 1. Service Worker & media cache storage
  join('Service Worker', 'CacheStorage'),
  join('Service Worker', 'ScriptCache'),
  'Service Worker', // catches whatever's left after the two more-specific deletes above
  'File System',
  'blob_storage',
  'Media Cache',
  // 2. component updaters / model stores that land inside Default/ instead of root
  'OptimizationGuidePredictionModels',
  'optimization_guide_model_store',
  // 3. history, icons, DB journals
  'Favicons',
  'Favicons-journal',
  'History',
  'History-journal',
  'History Provider Cache',
  'Top Sites',
  'Top Sites-journal',
  'Shortcuts',
  'Shortcuts-journal',
  'Network Action Predictor',
  'Network Action Predictor-journal',
  'Network Persistent State',
  'Site Characteristics Database',
  'GCM Store',
  'Download Service',
  'AutofillAiModelCache',
  'Feature Engagement Tracker',
  'Visited Links',
  'Code Cache',
  'Cache',
  'GPUCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'Shared Dictionary'
]

// Files/directories that make up the actual logged-in session — never
// touched by the safe-clean mode, regardless of the bloat lists above. Paths
// are relative to Default/ except 'Local State' (root-level).
const PRESERVE_PATHS = new Set([
  'Cookies',
  'Cookies-journal',
  'Network', // holds Network/Cookies on modern Chromium — the whole dir is kept, not just the file, since Network/ also holds other session-relevant state
  'Local Storage', // leveldb (*.ldb, *.log, CURRENT, MANIFEST*) lives inside — the spec calls out the leveldb file types specifically, but the directory is the atomic unit Chromium manages it as
  'IndexedDB', // Facebook stores session/device state here too — clearing it can force re-auth even with cookies intact
  'Preferences',
  'Secure Preferences',
  'Local State' // root-level — device ID / encryption key material Chromium uses to decrypt saved cookies/passwords; deleting it can invalidate the very cookies this clean is trying to preserve
])

/** Recursively sums the byte size of everything under `path` (0 if it doesn't exist). */
function dirSizeBytes(path: string): number {
  if (!existsSync(path)) return 0
  const stat = statSync(path)
  if (!stat.isDirectory()) return stat.size
  let total = 0
  for (const entry of readdirSync(path)) {
    total += dirSizeBytes(join(path, entry))
  }
  return total
}

function bytesToMB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100
}

/**
 * Deletes non-Facebook cookie entries from Chromium's SQLite cookie
 * database, then VACUUMs it — a plain DELETE marks rows' pages free but
 * leaves them allocated to the file (SQLite doesn't shrink a DB file on
 * DELETE alone), so without the VACUUM the file stays exactly the same size
 * on disk regardless of how many rows were removed. VACUUM rebuilds the file
 * from only the live pages, which is what actually shrinks it down to
 * kilobytes. Best-effort throughout: the DB can be missing (fresh profile)
 * or briefly locked — either is silently skipped rather than failing the
 * whole clean, since a failure here should never risk the cookie file the
 * "keep logged in" guarantee depends on.
 */
function cleanAndVacuumCookieDb(profileDir: string): void {
  const cookiesPath = join(profileDir, 'Default', 'Network', 'Cookies')
  const fallbackPath = join(profileDir, 'Default', 'Cookies')
  const path = existsSync(cookiesPath) ? cookiesPath : fallbackPath
  if (!existsSync(path)) return

  let db: Database.Database | null = null
  try {
    db = new Database(path)
    // VACUUM cannot run inside a transaction, and better-sqlite3 wraps
    // .exec() bodies in an implicit transaction only via .transaction() — a
    // plain .prepare().run() for the DELETE followed by a separate .exec()
    // for VACUUM keeps them as two independent statements, not one transaction.
    db.pragma('journal_mode = DELETE') // avoid leaving a stray -wal/-shm Chromium isn't managing between runs
    db.prepare(
      `DELETE FROM cookies WHERE host_key NOT LIKE '%facebook.com%' AND host_key NOT LIKE '%.fb.com%'`
    ).run()
    db.exec('VACUUM')
  } catch {
    // Locked, missing table, or unreadable — leave cookies untouched rather than risk corrupting the DB.
  } finally {
    db?.close()
  }
}

/**
 * Deletes `profileDir/relativePath` if present — no-op if it doesn't exist.
 * Refuses (throws) if the path's first segment is in PRESERVE_PATHS — a
 * last-line-of-defense check so a future edit that accidentally adds a
 * preserved name to one of the bloat lists fails loudly instead of silently
 * deleting a piece of the login session.
 */
function deletePath(profileDir: string, relativePath: string): void {
  const firstSegment = relativePath.split(/[\\/]/)[0]
  if (PRESERVE_PATHS.has(firstSegment)) {
    throw new Error(
      `Refusing to delete "${relativePath}" — "${firstSegment}" is on the login-preservation whitelist.`
    )
  }
  rmSync(join(profileDir, relativePath), { recursive: true, force: true })
}

/**
 * Recursively deletes stray *.tmp / *.old / *.log / Singleton* files
 * anywhere under `dir` — Chromium scatters these at multiple levels (profile
 * root, Default/, and inside surviving cache-adjacent directories), not just
 * at the top. Walks the tree once; directories in PRESERVE_PATHS are still
 * walked into (a preserved directory can itself contain an unrelated stray
 * .log file worth sweeping) but the preserved *named* files/dirs inside are
 * never deleted since only files matching the patterns below are removed.
 */
function sweepTempAndLogFiles(dir: string): void {
  if (!existsSync(dir)) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return // permission error / mid-write race — skip rather than crash the whole clean
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch {
      continue // file vanished between readdir and stat (Chromium background process) — skip
    }
    if (stat.isDirectory()) {
      sweepTempAndLogFiles(full)
      continue
    }
    if (
      entry.endsWith('.tmp') ||
      entry.endsWith('.old') ||
      entry.endsWith('.log') ||
      entry === 'chrome_debug.log' ||
      entry.startsWith('Singleton')
    ) {
      rmSync(full, { force: true })
    }
  }
}

/** Deletes every bloat path under profileDir (root-level and Default/), then sweeps stray temp/log/Singleton files across the whole tree. */
function deleteBloatPaths(profileDir: string): void {
  for (const name of ROOT_BLOAT_PATHS) {
    deletePath(profileDir, name)
  }

  const defaultDir = join(profileDir, 'Default')
  for (const name of DEFAULT_BLOAT_PATHS) {
    deletePath(defaultDir, name)
  }

  sweepTempAndLogFiles(profileDir)
}

/**
 * Cleans one account's persistent profile folder. `uid` identifies both the
 * profile directory (see resolveProfileDir()) and the tracked-context key
 * used to refuse cleaning a profile that's currently open in a live browser.
 */
export function cleanProfile(uid: string | null, mode: CleanMode): CleanResult {
  const profileDir = resolveProfileDir(uid)

  if (!existsSync(profileDir)) {
    return { success: true, freedSpaceMB: 0, mode, detail: 'No profile folder on disk — nothing to clean.' }
  }

  if (isTracked(`profile:${uid ?? 'unknown'}`)) {
    return {
      success: false,
      freedSpaceMB: 0,
      mode,
      detail: 'Profile is currently open in a browser — close it before cleaning.'
    }
  }

  const beforeBytes = dirSizeBytes(profileDir)

  try {
    if (mode === 'full_wipe') {
      rmSync(profileDir, { recursive: true, force: true })
      return {
        success: true,
        freedSpaceMB: bytesToMB(beforeBytes),
        mode,
        detail: 'Profile folder fully wiped — this account will need to log in again next time.'
      }
    }

    // MODE_SAFE_FB_ONLY — delete bloat first, then clean+VACUUM the cookie DB
    // last: VACUUM rewrites the whole file, so doing it after the bulk of the
    // deletions means it isn't racing any other write to that same file.
    deleteBloatPaths(profileDir)
    cleanAndVacuumCookieDb(profileDir)
    const afterBytes = dirSizeBytes(profileDir)
    const freed = Math.max(0, beforeBytes - afterBytes)
    return {
      success: true,
      freedSpaceMB: bytesToMB(freed),
      mode,
      detail: `Freed ${bytesToMB(freed)} MB of cache/bloat — login session preserved.`
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, freedSpaceMB: 0, mode, detail: `Clean failed: ${message}` }
  }
}

/** Cleans profiles for a batch of accounts (by uid), one at a time. */
export function cleanProfiles(uids: (string | null)[], mode: CleanMode): CleanSummary {
  const results = uids.map((uid) => ({ uid, result: cleanProfile(uid, mode) }))
  const succeeded = results.filter((r) => r.result.success).length
  const freedSpaceMB = bytesToMB(
    results.reduce((sum, r) => sum + r.result.freedSpaceMB * 1024 * 1024, 0)
  )
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    freedSpaceMB,
    results
  }
}
