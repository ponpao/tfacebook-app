// ---------------------------------------------------------------------------
// licenseService.ts  — 1-PC-1-License activation gate.
//   * deviceHash is derived from the motherboard/BIOS UUID (Win32_ComputerSystemProduct)
//     via PowerShell — stable across reinstalls of the app/OS user profile, tied to
//     the physical machine, and requires no extra npm dependency (node-machine-id
//     would work too, but this needs nothing beyond what Windows already ships).
//   * The local license file is the offline cache: activateLicense() writes it once
//     the remote API confirms the key, and verifyLicense() re-checks it locally
//     (expiry + device match) on every launch, then also re-validates against the
//     remote /validate endpoint in the background so a revoke/pause/expiry issued
//     server-side after activation takes effect without the user deactivating —
//     while still working offline (a network failure just falls back to the
//     already-validated local cache rather than locking the PC out).
//
// API contract — confirmed against the reference server implementation
// (../../licensehub/functions/index.js, the same "api" Express router now
// served via Firebase Hosting rewrite at https://licensehub-8822.web.app/api
// instead of a raw asia-southeast1-*.cloudfunctions.net Cloud Function URL —
// the old host 404'd because nothing was deployed there; this hosting URL is
// the confirmed-live replacement). handleActivate()/handleValidate() always
// respond HTTP 200 with a JSON body — business-logic failures ("License not
// found", "already used on another PC", "License expired", etc.) come back as
// { ok: false, message } at HTTP 200, never as a 404/409/410 status code.
// Success is { ok: true, token, productId, licenseKey, expiresAt (ISO string),
// status }. A non-2xx status with an empty/non-JSON body means the route
// itself isn't reachable at this URL — a deployment/infra problem, not a
// rejected key — and is reported distinctly below rather than misread as
// "invalid license".
// ---------------------------------------------------------------------------
import { app } from 'electron'
import { join } from 'path'
import { mkdir, readFile, writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { LicenseRecord, LicenseStatus, ActivateLicenseResult } from '../../types/license'

const execFileAsync = promisify(execFile)

export const PRODUCT_ID = 'tfacebook'
export const COMPANY = 'TFacebook'
export const API_BASE = 'https://licensehub-8822.web.app/api'
export const APP_VERSION = '1.0.0'

/**
 * %LOCALAPPDATA%\TFacebook\licenses\tfacebook.json — deliberately NOT under
 * app.getPath('userData') (which is per-Electron-app-id, %APPDATA%\TFACEBOOK):
 * the spec calls for a fixed, company-branded LOCALAPPDATA path independent of
 * Electron's own per-app data dir, matching the "1 PC" identity rather than
 * "1 installed copy of the app" identity.
 */
function getLicenseFilePath(): string {
  const base = process.env['LOCALAPPDATA'] || app.getPath('appData')
  return join(base, COMPANY, 'licenses', `${PRODUCT_ID}.json`)
}

let cachedDeviceHash: string | null = null

/**
 * Best-effort motherboard/BIOS UUID via WMI (Win32_ComputerSystemProduct.UUID).
 * Falls back to Win32_ComputerSystemProduct's other identifiers, then to
 * app.getPath('userData') as a last resort so the app never crashes on a
 * locked-down machine where WMI access is blocked — it just means the device
 * hash is less strictly hardware-bound in that edge case.
 */
async function getRawMachineId(): Promise<string> {
  if (process.platform !== 'win32') {
    // Non-Windows dev machines (this app ships Windows-only, but typecheck /
    // local dev on macOS/Linux should still produce *a* stable string).
    return `${process.platform}-${process.arch}-${app.getPath('userData')}`
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance -Class Win32_ComputerSystemProduct).UUID'
      ],
      { timeout: 10_000, windowsHide: true }
    )
    const uuid = stdout.trim()
    if (uuid && uuid.toUpperCase() !== 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF') {
      return uuid
    }
  } catch {
    /* fall through to wmic / fallback below */
  }
  try {
    // Older Windows builds (or CimInstance being unavailable) — wmic is the
    // pre-PowerShell-Core equivalent of the same Win32_ComputerSystemProduct query.
    const { stdout } = await execFileAsync(
      'wmic',
      ['csproduct', 'get', 'UUID'],
      { timeout: 10_000, windowsHide: true }
    )
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l.toUpperCase() !== 'UUID')
    if (lines[0]) return lines[0]
  } catch {
    /* fall through to final fallback */
  }
  // Last resort — not truly hardware-bound, but keeps the app usable rather
  // than throwing when WMI is unreachable (locked-down/sandboxed machines).
  return `fallback-${app.getPath('userData')}`
}

/** Returns the current PC's device hash (SHA-256 of the machine UUID), cached in-process. */
export async function getDeviceHash(): Promise<string> {
  if (cachedDeviceHash) return cachedDeviceHash
  const raw = await getRawMachineId()
  cachedDeviceHash = createHash('sha256').update(raw).digest('hex')
  return cachedDeviceHash
}

/** Reads the cached license file from disk, or null if it doesn't exist / is unreadable. */
export async function loadLocalLicense(): Promise<LicenseRecord | null> {
  const filePath = getLicenseFilePath()
  if (!existsSync(filePath)) return null
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<LicenseRecord>
    if (!parsed || typeof parsed.licenseKey !== 'string' || typeof parsed.deviceHash !== 'string') {
      return null
    }
    return {
      licenseKey: parsed.licenseKey,
      deviceHash: parsed.deviceHash,
      expiresAt: parsed.expiresAt ?? null,
      token: parsed.token ?? null,
      activatedAt: parsed.activatedAt ?? new Date().toISOString()
    }
  } catch {
    return null
  }
}

async function saveLocalLicense(record: LicenseRecord): Promise<void> {
  const filePath = getLicenseFilePath()
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8')
}

/** Deletes the local license file, resetting activation state for this PC. */
export async function deactivateLicense(): Promise<{ ok: boolean }> {
  const filePath = getLicenseFilePath()
  await rm(filePath, { force: true }).catch(() => void 0)
  return { ok: true }
}

// Field names below match handleActivate()/handleValidate()'s actual response
// shape exactly (see the contract note above) — no guessed alternate spellings.
function extractMessage(body: Record<string, unknown>): string | undefined {
  return typeof body['message'] === 'string' ? body['message'] : undefined
}

function extractOk(body: Record<string, unknown>): boolean {
  return body['ok'] === true
}

function extractExpiresAt(body: Record<string, unknown>): string | null {
  return typeof body['expiresAt'] === 'string' ? body['expiresAt'] : null
}

function extractToken(body: Record<string, unknown>): string | null {
  return typeof body['token'] === 'string' ? body['token'] : null
}

interface RemoteCallResult {
  ok: boolean
  body: Record<string, unknown>
  /** Set only when the endpoint itself was unreachable (network error / non-JSON 404 page) — distinct from a JSON { ok: false } business rejection. */
  unreachable?: string
}

/** Shared POST helper for /activate and /validate — both endpoints take and return the same shape (see contract note above). */
async function callLicenseEndpoint(
  path: 'activate' | 'validate',
  licenseKey: string,
  deviceHash: string
): Promise<RemoteCallResult> {
  let response: Response
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 20_000)
    try {
      response = await fetch(`${API_BASE}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: PRODUCT_ID,
          licenseKey,
          deviceHash,
          appVersion: APP_VERSION
        }),
        signal: controller.signal
      })
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, body: {}, unreachable: `Could not reach the license server: ${detail}` }
  }

  let body: Record<string, unknown>
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  if (!response.ok && Object.keys(body).length === 0) {
    // Non-2xx with an empty/non-JSON body means the route itself isn't
    // reachable at this URL (e.g. a plain "page not found" page) rather than
    // this app's own JSON { ok: false, message } business-logic response.
    return {
      ok: false,
      body,
      unreachable: `License server route not found (HTTP ${response.status}) — /${path} is not reachable at ${API_BASE}.`
    }
  }

  return { ok: response.ok && extractOk(body), body }
}

/**
 * Validates the cached license against the current date and this machine's
 * device hash first (no network dependency, so the gate resolves instantly
 * even offline), then kicks off a background /validate call against the
 * remote API — if the server reports the license revoked/paused/expired or
 * freed from this device (an admin action taken after the last activation),
 * the local cache is corrected and the returned status reflects that. A
 * network failure during the background check is silently ignored — the
 * cached, already-validated-locally status stands, so a temporary outage or
 * offline launch never locks a legitimately activated PC out.
 */
export async function verifyLicense(): Promise<LicenseStatus> {
  const deviceHash = await getDeviceHash()
  const record = await loadLocalLicense()

  if (!record) {
    return { isActivated: false, deviceHash, message: 'No license activated on this PC.' }
  }

  if (record.deviceHash !== deviceHash) {
    return {
      isActivated: false,
      deviceHash,
      message: 'This license was activated on a different PC.'
    }
  }

  if (record.expiresAt) {
    const expiry = new Date(record.expiresAt)
    if (!Number.isNaN(expiry.getTime()) && expiry.getTime() < Date.now()) {
      return {
        isActivated: false,
        deviceHash,
        licenseKey: record.licenseKey,
        expiresAt: record.expiresAt,
        message: 'License has expired.'
      }
    }
  }

  const localStatus: LicenseStatus = {
    isActivated: true,
    deviceHash,
    licenseKey: record.licenseKey,
    expiresAt: record.expiresAt
  }

  const result = await callLicenseEndpoint('validate', record.licenseKey, deviceHash)
  if (result.unreachable) {
    // Couldn't reach the server (offline, or the endpoint is down) — trust
    // the local cache rather than locking the user out.
    return localStatus
  }
  if (!result.ok) {
    // Server explicitly says this activation is no longer valid (revoked,
    // paused, expired server-side, or freed from this device by an admin) —
    // clear the stale local cache so verifyLicense() reports unactivated on
    // every subsequent call too, not just this one.
    await deactivateLicense()
    return {
      isActivated: false,
      deviceHash,
      licenseKey: record.licenseKey,
      message: extractMessage(result.body) ?? 'License is no longer valid.'
    }
  }

  // Server confirmed the activation — refresh expiresAt/token in the local
  // cache in case an admin extended/changed them since the last activation.
  const refreshed: LicenseRecord = {
    ...record,
    expiresAt: extractExpiresAt(result.body) ?? record.expiresAt,
    token: extractToken(result.body) ?? record.token
  }
  await saveLocalLicense(refreshed)

  return { ...localStatus, expiresAt: refreshed.expiresAt }
}

/**
 * Activates a license key against the remote License API for this PC.
 * On success, caches the result locally so subsequent launches don't need
 * a network round-trip (see verifyLicense()).
 */
export async function activateLicense(licenseKey: string): Promise<ActivateLicenseResult> {
  const trimmedKey = licenseKey.trim()
  if (!trimmedKey) {
    return { ok: false, message: 'License key is required.' }
  }

  const deviceHash = await getDeviceHash()
  const result = await callLicenseEndpoint('activate', trimmedKey, deviceHash)

  if (result.unreachable) {
    return { ok: false, message: result.unreachable }
  }
  if (!result.ok) {
    return { ok: false, message: extractMessage(result.body) ?? `Activation failed (${JSON.stringify(result.body)}).` }
  }

  const record: LicenseRecord = {
    licenseKey: trimmedKey,
    deviceHash,
    expiresAt: extractExpiresAt(result.body),
    token: extractToken(result.body),
    activatedAt: new Date().toISOString()
  }
  await saveLocalLicense(record)

  const status: LicenseStatus = {
    isActivated: true,
    deviceHash,
    licenseKey: trimmedKey,
    expiresAt: record.expiresAt
  }
  return { ok: true, status }
}
