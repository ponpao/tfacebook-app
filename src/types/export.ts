// ---------------------------------------------------------------------------
// export.ts  — token/format types for the Advanced Export Accounts modal.
// ---------------------------------------------------------------------------
import type { Account } from './account'

export const EXPORT_TOKENS = [
  'UID',
  'PASS',
  '2FA',
  'EMAIL',
  'PASSMAIL',
  'COOKIE',
  'TOKEN',
  'PROXY',
  'STATUS',
  'NAME',
  'NOTES',
  'FRIENDS_COUNT',
  'CREATED_DATE',
  'USER_AGENT'
] as const

export type ExportToken = (typeof EXPORT_TOKENS)[number]

/** Maps an export token to the Account field it reads. */
export const EXPORT_TOKEN_TO_FIELD: Record<ExportToken, keyof Account> = {
  UID: 'uid',
  PASS: 'password',
  '2FA': 'two_fa',
  EMAIL: 'email',
  PASSMAIL: 'email_pass',
  COOKIE: 'cookie',
  TOKEN: 'token',
  PROXY: 'proxy',
  STATUS: 'status',
  NAME: 'name',
  NOTES: 'notes',
  FRIENDS_COUNT: 'friends_count',
  CREATED_DATE: 'created_date',
  USER_AGENT: 'user_agent'
}

export interface ExportFormat {
  tokens: ExportToken[]
  /** Literal separator string; 'TAB' resolves to a real tab character. */
  delimiter: string
}

export const EXPORT_PRESETS: { label: string; tokens: ExportToken[] }[] = [
  { label: 'UID|PASS|2FA', tokens: ['UID', 'PASS', '2FA'] },
  { label: 'UID|PASS|2FA|EMAIL|PASSMAIL', tokens: ['UID', 'PASS', '2FA', 'EMAIL', 'PASSMAIL'] },
  { label: 'UID|PASS|2FA|COOKIE|TOKEN', tokens: ['UID', 'PASS', '2FA', 'COOKIE', 'TOKEN'] },
  { label: 'Custom...', tokens: [] }
]

export type ExportScope = 'all' | 'selected' | 'filtered'

export interface ExportAccountsRequest {
  scope: ExportScope
  /** Only used when scope = 'selected'. */
  accountIds?: number[]
  /** Only used when scope = 'filtered' — reuses the grid's current query. */
  search?: string
  searchField?: 'uid' | 'email' | 'name' | 'proxy'
  status?: string
  folderId?: number
  format: ExportFormat
}

export interface ExportPreviewResult {
  lines: string[]
  total: number
}
