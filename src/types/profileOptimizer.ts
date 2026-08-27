// ---------------------------------------------------------------------------
// profileOptimizer.ts (types)  — shared shapes for the Profile Optimizer
// (Clean Profile Storage) feature. The actual cleaning logic lives in
// src/main/automation/profileOptimizer.ts; this file is the IPC-safe subset
// importable from preload/renderer code.
// ---------------------------------------------------------------------------
export type CleanMode = 'safe_fb_only' | 'full_wipe'

export interface CleanResult {
  success: boolean
  freedSpaceMB: number
  mode: CleanMode
  detail: string
}

export interface CleanSummary {
  total: number
  succeeded: number
  failed: number
  freedSpaceMB: number
  results: { uid: string | null; result: CleanResult }[]
}
