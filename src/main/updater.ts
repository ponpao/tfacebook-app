// ---------------------------------------------------------------------------
// updater.ts  — electron-updater integration.
//   * autoDownload is OFF — the user always sees "an update is available"
//     with release notes before anything downloads, per the UI spec.
//   * every autoUpdater event is forwarded to the renderer over its own IPC
//     channel (rather than the renderer subscribing to autoUpdater directly,
//     which it can't — autoUpdater only exists in the main process).
//
// NOTE: electron-updater needs a `publish` provider configured in
// electron-builder.json5 (GitHub Releases, S3, a generic HTTP feed, etc.)
// to have anywhere to actually check for updates against. No publish target
// is configured for this app yet — until one is, checkForUpdates() will
// report an error (there's no feed URL to query), not silently succeed.
// This module is fully wired and ready for whichever provider is chosen.
//
// IMPORTANT — lazy require, not a static import: electron-vite's dev bundle
// hoists all top-level imports to plain `require()` calls in source order,
// ahead of the rest of the file's module body. electron-updater does eager
// work (constructing its default AppUpdater) as a side effect of being
// require()'d, and doing that before Electron has finished wiring the `app`
// binding intermittently left `electron.app` unpopulated for whatever ran
// next in the bundle (@electron-toolkit/utils's `is.dev = !electron.app
// .isPackaged`, in this app) — a real
// `TypeError: Cannot read properties of undefined (reading 'isPackaged')`
// crash on startup, reproduced via `npm run dev`. initAutoUpdater() is only
// ever called from inside app.whenReady().then(...), so requiring
// electron-updater lazily, right when it's actually used, guarantees `app`
// is already fully ready by then.
// ---------------------------------------------------------------------------
import { ipcMain, BrowserWindow } from 'electron'
import type { AppUpdater } from 'electron-updater'
import { IPC } from './ipc/channels'
import {
  isPortableBuild,
  checkForPortableUpdate,
  downloadAndInstallPortableUpdate,
  cleanupStalePortableUpdateFiles
} from './customUpdater'

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

let initialized = false

/**
 * Wire up the update-check/download/install IPC handlers used by
 * UpdateNotificationModal.tsx — the same three channels (check,
 * startDownload, quitAndInstall) and the same four broadcast events
 * (onUpdateAvailable, onDownloadProgress, onUpdateDownloaded, onError)
 * regardless of which build is running, so that UI stays entirely unaware
 * of which mechanism is actually behind it:
 *   - Portable build (PORTABLE_EXECUTABLE_FILE set): routed to
 *     customUpdater.ts's version.json-based check + in-place file-swap
 *     install — there is no installer to hand off to for a portable exe.
 *   - NSIS-installed build: electron-updater's autoUpdater, driven by
 *     latest.yml, exactly as before this module gained the branch above.
 * Safe to call once at app startup; a second call is a no-op (guards
 * against double-registration if this were ever imported from more than
 * one place).
 */
export function initAutoUpdater(): void {
  if (initialized) return
  initialized = true

  if (isPortableBuild()) {
    initPortableUpdater()
    return
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const autoUpdater: AppUpdater = (require('electron-updater') as typeof import('electron-updater'))
    .autoUpdater

  autoUpdater.autoDownload = false
  // Don't auto-install on quit either — the user must explicitly click
  // "Restart & Update Now" (or quit normally, applying it on next launch is
  // electron-updater's own default behavior for a downloaded-but-not-yet-
  // installed update).
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-available', (info) => {
    broadcast(IPC.updater.onUpdateAvailable, {
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
      releaseDate: info.releaseDate
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    broadcast(IPC.updater.onUpdateNotAvailable, { version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcast(IPC.updater.onDownloadProgress, {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    broadcast(IPC.updater.onUpdateDownloaded, { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    broadcast(IPC.updater.onError, { message: err instanceof Error ? err.message : String(err) })
  })

  ipcMain.handle(IPC.updater.check, async () => {
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Also broadcast on the same 'error' channel the event listener above
      // uses, so the renderer has one consistent place to observe failures
      // regardless of whether checkForUpdates() rejected or emitted 'error'.
      broadcast(IPC.updater.onError, { message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.updater.startDownload, async () => {
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      broadcast(IPC.updater.onError, { message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.updater.quitAndInstall, () => {
    autoUpdater.quitAndInstall()
    return { ok: true }
  })
}

/** The portable-build branch of initAutoUpdater() — see that function's doc comment for why this exists as a separate mechanism from electron-updater. */
function initPortableUpdater(): void {
  void cleanupStalePortableUpdateFiles()

  // Remembers the version check() last confirmed was available, so
  // startDownload() (which only receives no arguments, per the shared IPC
  // contract with the NSIS flow) knows which version to actually fetch.
  let pendingVersion: string | null = null

  ipcMain.handle(IPC.updater.check, async () => {
    const result = await checkForPortableUpdate()
    if (result.error) {
      broadcast(IPC.updater.onError, { message: result.error })
      return { ok: false, error: result.error }
    }
    if (result.updateAvailable && result.remoteVersion) {
      pendingVersion = result.remoteVersion
      broadcast(IPC.updater.onUpdateAvailable, {
        version: result.remoteVersion,
        releaseNotes: result.changelog?.join('\n') ?? null,
        releaseDate: null
      })
    } else {
      broadcast(IPC.updater.onUpdateNotAvailable, { version: result.currentVersion })
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.updater.startDownload, async () => {
    if (!pendingVersion) {
      const message = 'No update was found to download — run a check first.'
      broadcast(IPC.updater.onError, { message })
      return { ok: false, error: message }
    }
    try {
      await downloadAndInstallPortableUpdate(pendingVersion, (progress) => {
        broadcast(IPC.updater.onDownloadProgress, {
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: 0
        })
      })
      // downloadAndInstallPortableUpdate() calls app.quit() once the
      // detached .bat is spawned — nothing after that point in this
      // process actually runs, but a well-formed return keeps the
      // handler's shape consistent with the NSIS branch's in case that
      // quit is ever made conditional in the future.
      broadcast(IPC.updater.onUpdateDownloaded, { version: pendingVersion })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      broadcast(IPC.updater.onError, { message })
      return { ok: false, error: message }
    }
  })

  // quitAndInstall has nothing extra to do here — downloadAndInstallPortableUpdate()
  // (invoked by startDownload above) already quits the app itself once the
  // detached .bat script is spawned, since a portable exe update needs this
  // process to fully exit before the .bat can overwrite its file. The UI's
  // "Restart & Update Now" button calling this after startDownload succeeds
  // is effectively a no-op by the time it would run.
  ipcMain.handle(IPC.updater.quitAndInstall, () => {
    return { ok: true }
  })
}
