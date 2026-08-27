// ---------------------------------------------------------------------------
// settingsRepo.ts  — simple key/value store backed by the `settings` table.
// ---------------------------------------------------------------------------
import { getDb } from './database'
import { DEFAULT_SETTINGS, SETTINGS_KEY, type AppSettings } from '../../types/settings'

export function getSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = @value`
    )
    .run({ key, value })
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare(`SELECT key, value FROM settings`).all() as {
    key: string
    value: string
  }[]
  const out: Record<string, string> = {}
  for (const r of rows) out[r.key] = r.value
  return out
}

/** Read the General Settings blob, falling back to defaults for missing/invalid fields. */
export function getAppSettings(): AppSettings {
  const raw = getSetting(SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_SETTINGS }
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function setAppSettings(settings: AppSettings): void {
  setSetting(SETTINGS_KEY, JSON.stringify(settings))
}
