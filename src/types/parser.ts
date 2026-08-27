// ---------------------------------------------------------------------------
// Import / parser types
// ---------------------------------------------------------------------------
import type { NewAccount } from './account'

/** All tokens the user can place inside a custom import format string. */
export const IMPORT_TOKENS = [
  'UID',
  'PASS',
  '2FA',
  'EMAIL',
  'PASSMAIL',
  'MAIL_SERVER',
  'DOB',
  'CREATED_DATE',
  'LOCATION',
  'GENDER',
  'COOKIE',
  'TOKEN',
  'PROXY',
  'IGNORE' // skip this column
] as const

export type ImportToken = (typeof IMPORT_TOKENS)[number]

/** Maps a parser token to the Account column it fills. */
export const TOKEN_TO_FIELD: Record<Exclude<ImportToken, 'IGNORE'>, keyof NewAccount> = {
  UID: 'uid',
  PASS: 'password',
  '2FA': 'two_fa',
  EMAIL: 'email',
  PASSMAIL: 'email_pass',
  MAIL_SERVER: 'mail_server',
  DOB: 'dob',
  CREATED_DATE: 'created_date',
  LOCATION: 'location',
  GENDER: 'gender',
  COOKIE: 'cookie',
  TOKEN: 'token',
  PROXY: 'proxy'
}

/** A saved / active import format definition. */
export interface ImportFormat {
  /** Ordered list of tokens describing each field position. */
  tokens: ImportToken[]
  /** Separator between fields. Special value 'TAB' => '\t'. */
  separator: string
  /** Optional name for saving named presets. */
  name?: string
}

export interface ParsePreviewRow {
  lineNumber: number
  raw: string
  parsed: NewAccount
  /** true when the line produced no usable fields (likely malformed). */
  error?: string
}

export interface ParseResult {
  rows: ParsePreviewRow[]
  validCount: number
  errorCount: number
}

export interface ImportResult {
  inserted: number
  skipped: number
  errors: string[]
}
