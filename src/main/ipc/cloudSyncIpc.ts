// ---------------------------------------------------------------------------
// cloudSyncIpc.ts  — IPC handlers for the Device ID Cloud Sync feature
// (push to another Machine ID, pull from one, and reading this PC's own
// Machine ID).
// ---------------------------------------------------------------------------
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from './channels'
import { getMachineId } from '../services/machineId'
import { pushToDevice, pullPendingPayload } from '../services/cloudSync'
import type { CloudPullResult } from '../../types/cloudSync'

export function registerCloudSyncIpcHandlers(): void {
  ipcMain.handle(IPC.cloudSync.getMachineId, () => getMachineId())

  ipcMain.handle(IPC.cloudSync.push, (_e, targetMachineId: string, accountIds: number[]) =>
    pushToDevice(targetMachineId.trim().toUpperCase(), accountIds)
  )

  ipcMain.handle(IPC.cloudSync.pull, async (_e, machineId: string) => {
    const outcome = await pullPendingPayload(machineId.trim().toUpperCase())
    if (outcome.success) {
      // Same cross-window refresh pattern as backupIpc.ts's import handler —
      // any open window's grid/folder manager should pick up the newly
      // arrived "Receive Account" accounts without needing a manual refresh.
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send(IPC.cloudSync.onPulled, outcome satisfies CloudPullResult)
      }
    }
    return outcome
  })
}
