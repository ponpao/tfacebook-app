// ---------------------------------------------------------------------------
// systemIpc.ts  — OS-level integrations that don't belong to any single
// domain repo/automation module. Currently just clipboard access: routing
// copy-to-clipboard through the main process (Electron's `clipboard` module)
// rather than the renderer's `navigator.clipboard`, since the renderer API
// can silently no-op when the window doesn't have focus (e.g. copying from
// a context menu action right after a click moved focus elsewhere).
// ---------------------------------------------------------------------------
import { ipcMain, clipboard } from 'electron'
import { IPC } from './channels'

export function registerSystemIpcHandlers(): void {
  ipcMain.handle(IPC.system.clipboardWriteText, (_e, text: string) => {
    clipboard.writeText(text ?? '')
    return true
  })
}
