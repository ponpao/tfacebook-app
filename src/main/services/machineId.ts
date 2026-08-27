// ---------------------------------------------------------------------------
// machineId.ts  — this PC's persistent, human-shareable Cloud Sync
// identifier: `TFA` + 5 digits (e.g. `TFA90488`). Generated once and
// persisted in the SQLite-backed app settings (settingsRepo.ts) so it never
// changes across restarts — Cloud Sync pushes/pulls are addressed by this
// id, so a value that silently changed would orphan any pending push.
// ---------------------------------------------------------------------------
import { getAppSettings, setAppSettings } from '../db/settingsRepo'

function generateMachineId(): string {
  const digits = Math.floor(10000 + Math.random() * 90000) // always exactly 5 digits
  return `TFA${digits}`
}

/** Returns this PC's Machine ID, generating and persisting one on first call if none exists yet. */
export function getMachineId(): string {
  const settings = getAppSettings()
  if (settings.machineId) return settings.machineId

  const machineId = generateMachineId()
  setAppSettings({ ...settings, machineId })
  return machineId
}
