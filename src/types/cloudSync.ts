// ---------------------------------------------------------------------------
// cloudSync.ts (types)  — shared shapes for the Firebase-based Device ID
// Cloud Sync feature. The actual push/pull logic lives in
// src/main/services/cloudSync.ts; this file is the IPC-safe subset
// importable from preload/renderer code.
// ---------------------------------------------------------------------------

export interface CloudPushResult {
  ok: boolean
  accountCount?: number
  targetMachineId?: string
  message?: string
}

export interface CloudPullResult {
  success: boolean
  importedCount: number
  skippedCount: number
  profilesRestoredCount: number
  message?: string
}
