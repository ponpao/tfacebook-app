// ---------------------------------------------------------------------------
// customUpdater.ts  — true in-place updater for the PORTABLE build only.
//
// Distinct from updater.ts (electron-updater / NSIS): that flow drives the
// installed build's Setup.exe update path via latest.yml, and stays exactly
// as-is. A portable .exe has no installer and no registered install
// location to run an installer against — the exe the user double-clicked
// *is* the app — so it needs a different mechanism entirely: download the
// new portable .exe, then swap it in for the running one on disk.
//
// Detecting "am I the portable build" and "which file do I overwrite" both
// rely on PORTABLE_EXECUTABLE_FILE, an environment variable electron-
// builder's own portable launcher sets to the real, user-facing .exe path
// before extracting/running the app (see node_modules/app-builder-lib/
// templates/nsis/portable.nsi). This is NOT the same as process.execPath:
// a portable app's process.execPath points at a temp-directory copy
// extracted for this one run, which is discarded and re-extracted fresh
// next launch — overwriting that would silently accomplish nothing, since
// the next launch re-extracts from the original portable .exe regardless.
// PORTABLE_EXECUTABLE_FILE is the actual file that needs replacing.
//
// version.json (this repo's root, published as a release asset by
// .github/workflows/release.yml) is the update feed: fetched from GitHub's
// "latest release" download alias so the URL never needs to change between
// versions. Its version field is compared against app.getVersion(); a newer
// remote version triggers downloading
// TFACEBOOK-Portable-{remoteVersion}.exe from the same release.
//
// The actual file swap happens via a detached .bat script (a running .exe
// cannot overwrite/delete its own file on Windows while it's still the
// process image in use) that: waits for this process to fully exit
// (taskkill /F, then a poll loop rather than trusting a single kill to be
// synchronous), copies the downloaded update over the original portable
// .exe, relaunches it, then deletes itself and the downloaded temp file.
// ---------------------------------------------------------------------------
import { app } from 'electron'
import { join } from 'path'
import { writeFile, unlink } from 'fs/promises'
import { spawn } from 'child_process'

const OWNER = 'ponpao'
const REPO = 'tfacebook-app'
const VERSION_JSON_URL = `https://github.com/${OWNER}/${REPO}/releases/latest/download/version.json`

export interface RemoteVersionInfo {
  version: string
  releaseDate?: string
  changelog?: { en?: string[]; km?: string[] }
}

export interface PortableUpdateCheckResult {
  isPortable: boolean
  updateAvailable: boolean
  currentVersion: string
  remoteVersion?: string
  changelog?: string[]
  error?: string
}

/** True only when running as the portable build — the in-place swap this module implements makes no sense for an NSIS-installed app (that's updater.ts's job). */
export function isPortableBuild(): boolean {
  return !!process.env.PORTABLE_EXECUTABLE_FILE
}

/** Simple numeric-segment semver comparison — good enough for this app's plain X.Y.Z versions (no pre-release tags to worry about). Returns true if `remote` is newer than `current`. */
function isNewerVersion(remote: string, current: string): boolean {
  const r = remote.split('.').map((n) => parseInt(n, 10) || 0)
  const c = current.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const diff = (r[i] ?? 0) - (c[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

/** Fetches version.json from the latest GitHub Release and compares it against this build's own version. Never throws — a network/parsing failure is reported via `error`, not an exception, since a failed check should never crash the app. */
export async function checkForPortableUpdate(): Promise<PortableUpdateCheckResult> {
  const currentVersion = app.getVersion()
  if (!isPortableBuild()) {
    return { isPortable: false, updateAvailable: false, currentVersion }
  }
  try {
    const res = await fetch(VERSION_JSON_URL, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const info = (await res.json()) as RemoteVersionInfo
    const updateAvailable = isNewerVersion(info.version, currentVersion)
    return {
      isPortable: true,
      updateAvailable,
      currentVersion,
      remoteVersion: info.version,
      changelog: info.changelog?.en
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { isPortable: true, updateAvailable: false, currentVersion, error: message }
  }
}

export interface PortableDownloadProgress {
  percent: number
  transferred: number
  total: number
}

/** Reads a fetch Response body to a single Buffer, reporting progress as chunks arrive — a streamed alternative to response.arrayBuffer() so the caller can drive a progress bar for a ~230MB download. */
async function readResponseWithProgress(
  res: Response,
  total: number,
  onProgress?: (progress: PortableDownloadProgress) => void
): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer())

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let transferred = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    transferred += value.byteLength
    onProgress?.({
      transferred,
      total,
      percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0
    })
  }
  return Buffer.concat(chunks)
}

/**
 * Downloads TFACEBOOK-Portable-{version}.exe to %TEMP%, writes a detached
 * .bat that waits for this process to exit, overwrites the real portable
 * .exe (PORTABLE_EXECUTABLE_FILE, not process.execPath — see module header),
 * relaunches it, and self-deletes — then quits this process to let that
 * happen. Only ever called after checkForPortableUpdate() reports
 * updateAvailable: true for a portable build. `onProgress`, if given, is
 * called as the download streams in (byte counts are only as accurate as
 * the Content-Length header GitHub Releases returns for the asset).
 */
export async function downloadAndInstallPortableUpdate(
  remoteVersion: string,
  onProgress?: (progress: PortableDownloadProgress) => void
): Promise<void> {
  const targetExe = process.env.PORTABLE_EXECUTABLE_FILE
  if (!targetExe) {
    throw new Error('Not running as the portable build — PORTABLE_EXECUTABLE_FILE is not set.')
  }

  const downloadUrl = `https://github.com/${OWNER}/${REPO}/releases/latest/download/TFACEBOOK-Portable-${remoteVersion}.exe`
  const tempDir = process.env.TEMP || process.env.TMP || app.getPath('temp')
  const downloadedExe = join(tempDir, 'TFACEBOOK_update.exe')
  const batScript = join(tempDir, 'TFACEBOOK_update.bat')

  const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(300000) })
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const buffer = await readResponseWithProgress(res, total, onProgress)
  await writeFile(downloadedExe, buffer)

  const currentPid = process.pid
  // taskkill first (fast path for the common case), then a poll loop via
  // tasklist as a fallback/confirmation — taskkill can return before the
  // process handle is actually released on Windows, and the subsequent
  // `copy` would fail with a sharing violation if it ran a moment too soon.
  const script = [
    '@echo off',
    `taskkill /F /PID ${currentPid} >nul 2>&1`,
    ':waitloop',
    `tasklist /FI "PID eq ${currentPid}" 2>nul | find "${currentPid}" >nul`,
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto waitloop',
    ')',
    `copy /Y "${downloadedExe}" "${targetExe}" >nul`,
    `start "" "${targetExe}"`,
    `del "${downloadedExe}" >nul 2>&1`,
    'del "%~f0" >nul 2>&1'
  ].join('\r\n')
  await writeFile(batScript, script)

  spawn('cmd.exe', ['/c', batScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  }).unref()

  // Give the spawned .bat a brief head start before this process disappears
  // out from under it — cmd.exe launching is effectively instant, but this
  // avoids any theoretical race with the OS still finishing process setup.
  await new Promise((resolve) => setTimeout(resolve, 300))
  app.quit()
}

/** Best-effort cleanup of a previous run's temp files, in case a prior update attempt failed partway through and left them behind. Safe to call unconditionally at startup. */
export async function cleanupStalePortableUpdateFiles(): Promise<void> {
  const tempDir = process.env.TEMP || process.env.TMP || app.getPath('temp')
  for (const name of ['TFACEBOOK_update.exe', 'TFACEBOOK_update.bat']) {
    await unlink(join(tempDir, name)).catch(() => void 0)
  }
}
