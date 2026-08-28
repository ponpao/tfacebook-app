// ---------------------------------------------------------------------------
// systemIpc.ts  — OS-level integrations that don't belong to any single
// domain repo/automation module.
//   * Clipboard access: routing copy-to-clipboard through the main process
//     (Electron's `clipboard` module) rather than the renderer's
//     `navigator.clipboard`, since the renderer API can silently no-op when
//     the window doesn't have focus (e.g. copying from a context menu
//     action right after a click moved focus elsewhere).
//   * App version: exposes Electron's own app.getVersion() (which reads the
//     packaged app's package.json — the single source of truth already
//     bumped on every release) so the UI never has a second, driftable
//     hardcoded copy of the version number.
//   * Auto Shutdown PC (General Settings): schedules/cancels a real OS
//     shutdown via Windows' own `shutdown` command — the countdown dialog
//     itself lives in the renderer (AutoShutdownDialog.tsx), this just
//     executes/cancels the actual command since a renderer can't spawn
//     processes directly.
// ---------------------------------------------------------------------------
import { ipcMain, clipboard, app } from 'electron'
import { exec } from 'child_process'
import { IPC } from './channels'

export function registerSystemIpcHandlers(): void {
  ipcMain.handle(IPC.system.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(text ?? '')
    return true
  })

  ipcMain.handle(IPC.system.getAppVersion, () => app.getVersion())

  ipcMain.handle(IPC.system.scheduleShutdown, (_e, seconds: number) => {
    if (process.platform !== 'win32') {
      return { ok: false, message: 'Auto Shutdown is only supported on Windows.' }
    }
    exec(`shutdown /s /t ${Math.max(0, Math.floor(seconds))}`, (err) => {
      if (err) console.error('[shutdown] schedule failed:', err.message)
    })
    return { ok: true }
  })

  ipcMain.handle(IPC.system.cancelShutdown, () => {
    if (process.platform !== 'win32') return { ok: false }
    exec('shutdown /a', (err) => {
      // ERROR_NOT_FOUND (1116) just means nothing was scheduled to cancel —
      // not a real failure worth surfacing.
      if (err && !err.message.includes('1116')) console.error('[shutdown] cancel failed:', err.message)
    })
    return { ok: true }
  })
}
