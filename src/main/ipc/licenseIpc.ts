// ---------------------------------------------------------------------------
// licenseIpc.ts  — IPC handlers for the license activation gate.
// ---------------------------------------------------------------------------
import { ipcMain } from 'electron'
import { IPC } from './channels'
import { activateLicense, deactivateLicense, verifyLicense } from '../license/licenseService'

export function registerLicenseIpcHandlers(): void {
  ipcMain.handle(IPC.license.getStatus, () => verifyLicense())
  ipcMain.handle(IPC.license.activate, (_e, licenseKey: string) => activateLicense(licenseKey))
  ipcMain.handle(IPC.license.deactivate, () => deactivateLicense())
}
