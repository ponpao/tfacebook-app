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
// ---------------------------------------------------------------------------
import { ipcMain, clipboard, app } from 'electron'
import { IPC } from './channels'

export function registerSystemIpcHandlers(): void {
  ipcMain.handle(IPC.system.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(text ?? '')
    return true
  })

  ipcMain.handle(IPC.system.getAppVersion, () => app.getVersion())
}
