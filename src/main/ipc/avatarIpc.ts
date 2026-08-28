// ---------------------------------------------------------------------------
// avatarIpc.ts  — IPC handlers for the direct (no-browser) avatar downloader.
// ---------------------------------------------------------------------------
import { ipcMain } from 'electron'
import { IPC } from './channels'
import { downloadAvatarsBatch, getLocalAvatarPath } from '../services/avatarService'

export function registerAvatarIpcHandlers(): void {
  ipcMain.handle(IPC.avatars.downloadBatch, (_e, accountIds: number[]) =>
    downloadAvatarsBatch(accountIds)
  )

  ipcMain.handle(IPC.avatars.getLocalPath, (_e, uid: string) => getLocalAvatarPath(uid))
}
