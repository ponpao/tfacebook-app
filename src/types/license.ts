// ---------------------------------------------------------------------------
// license.ts  — shared types for the 1-PC-1-License activation gate.
// ---------------------------------------------------------------------------
export interface LicenseRecord {
  licenseKey: string
  deviceHash: string
  expiresAt: string | null
  token: string | null
  activatedAt: string
}

export interface LicenseStatus {
  isActivated: boolean
  licenseKey?: string
  expiresAt?: string | null
  deviceHash: string
  message?: string
}

export interface ActivateLicenseResult {
  ok: boolean
  message?: string
  status?: LicenseStatus
}
