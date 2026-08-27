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

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

let initialized = false

/**
 * Wire up autoUpdater event forwarding + the three IPC handlers. Safe to
 * call once at app startup; a second call is a no-op (guards against
 * double-registration if this were ever imported from more than one place).
 */
export function initAutoUpdater(): void {
  if (initialized) return
  initialized = true

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
