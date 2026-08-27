// ---------------------------------------------------------------------------
// accountParser.ts
// Robust, format-driven parser that turns raw pasted / imported text into
// structured NewAccount rows, driven by a user-defined token layout.
//
// Design goals:
//   - Support arbitrary separators: '|', '----', ':', ',', tab, or any string.
//   - Tolerate messy data: trailing separators, extra whitespace, blank lines.
//   - Never throw on a single bad line — mark it as an error row instead.
//   - Be pure & side-effect free so it can be unit-tested and reused in a
//     worker if needed.
// ---------------------------------------------------------------------------
import type {
  ImportFormat,
  ImportToken,
  ParsePreviewRow,
  ParseResult
} from '../../types/parser'
import { TOKEN_TO_FIELD } from '../../types/parser'
import type { NewAccount } from '../../types/account'

/** Resolve the special 'TAB' keyword / escape sequences to a real separator. */
export function resolveSeparator(sep: string): string {
  if (sep === 'TAB' || sep === '\t') return '\t'
  if (sep === '\n') return '\n'
  return sep
}

/**
 * Split a single line by a separator that may be more than one character
 * (e.g. '----'). We use split on the literal string rather than a regex so
 * multi-char separators work and no escaping is required.
 */
function splitLine(line: string, separator: string): string[] {
  const sep = resolveSeparator(separator)
  if (sep === '') return [line]
  return line.split(sep)
}

/** Normalise a single parsed value: trim outer whitespace, collapse empties. */
function clean(value: string | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * Parse one raw line into a NewAccount using the given token layout.
 * Extra columns beyond the token list are ignored; missing columns simply
 * stay unset (null).
 */
export function parseLine(line: string, format: ImportFormat): NewAccount {
  const parts = splitLine(line, format.separator)
  const acc: NewAccount = {}

  format.tokens.forEach((token: ImportToken, index: number) => {
    if (token === 'IGNORE') return
    const field = TOKEN_TO_FIELD[token]
    if (!field) return
    const value = clean(parts[index])
    if (value !== null) {
      // friends_count is numeric — everything else is text.
      // (No token maps to friends_count today, but guard for the future.)
      ;(acc as Record<string, unknown>)[field] = value
    }
  })

  return acc
}

/** True when a parsed account carries at least one identifying field. */
function hasUsableData(acc: NewAccount): boolean {
  return Boolean(acc.uid || acc.email || acc.cookie || acc.token)
}

/**
 * Parse a full block of text. Returns one preview row per non-empty source
 * line, capped at `limit` rows when provided (used by the live preview so we
 * don't render 50k rows into the modal).
 */
export function parseText(
  text: string,
  format: ImportFormat,
  limit?: number
): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l) // keep raw; trimming happens per field
    .filter((l, i, arr) => l.trim().length > 0 || i < arr.length) // keep for numbering

  const rows: ParsePreviewRow[] = []
  let validCount = 0
  let errorCount = 0
  let lineNumber = 0

  for (const raw of lines) {
    lineNumber += 1
    if (raw.trim().length === 0) continue // skip blank lines entirely

    if (limit != null && rows.length >= limit) break

    const parsed = parseLine(raw, format)
    const ok = hasUsableData(parsed)
    if (ok) validCount += 1
    else errorCount += 1

    rows.push({
      lineNumber,
      raw,
      parsed,
      error: ok ? undefined : 'No UID / Email / Cookie / Token found'
    })
  }

  return { rows, validCount, errorCount }
}

/**
 * Full parse (no preview limit) returning ONLY the valid, usable accounts —
 * used by the import path before insertion.
 */
export function parseForImport(
  text: string,
  format: ImportFormat,
  folderId?: number
): { accounts: NewAccount[]; errors: string[] } {
  const { rows } = parseText(text, format)
  const accounts: NewAccount[] = []
  const errors: string[] = []

  for (const row of rows) {
    if (row.error) {
      errors.push(`Line ${row.lineNumber}: ${row.error}`)
      continue
    }
    // Attach the selected destination folder to every parsed account —
    // insertAccounts() falls back to the default folder when folder_id is
    // omitted, so this only needs to be set when the user picked one.
    accounts.push(folderId != null ? { ...row.parsed, folder_id: folderId } : row.parsed)
  }

  return { accounts, errors }
}

/**
 * Try to guess a format from a sample line by counting how many parts common
 * separators produce. Handy default when the user first opens the import
 * dialog. Returns the separator only; token layout is left to the user.
 */
export function guessSeparator(sampleLine: string): string {
  const candidates = ['|', '----', '\t', ';', ',', ':']
  let best = '|'
  let bestCount = 0
  for (const sep of candidates) {
    const count = sampleLine.split(resolveSeparator(sep)).length
    if (count > bestCount) {
      bestCount = count
      best = sep
    }
  }
  return best
}
