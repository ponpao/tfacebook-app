// ---------------------------------------------------------------------------
// exportAccounts.ts  — resolve an ExportAccountsRequest to plain-text lines
// (for .txt / clipboard) and to CSV (for .csv / Excel).
// ---------------------------------------------------------------------------
import type { Account } from '../../types/account'
import type { ExportAccountsRequest, ExportFormat } from '../../types/export'
import { EXPORT_TOKEN_TO_FIELD } from '../../types/export'
import * as accountsRepo from '../db/accountsRepo'

/** Resolve the 'TAB' keyword to a real tab character; everything else is literal. */
function resolveDelimiter(delimiter: string): string {
  if (delimiter === 'TAB' || delimiter === '\\t') return '\t'
  return delimiter
}

/** Build one output line for an account using the given token/delimiter format. */
export function formatAccountLine(account: Account, format: ExportFormat): string {
  const sep = resolveDelimiter(format.delimiter)
  return format.tokens
    .map((token) => {
      const field = EXPORT_TOKEN_TO_FIELD[token]
      const value = account[field]
      return value == null ? '' : String(value)
    })
    .join(sep)
}

/** Fetch the accounts matching the request's scope (all / selected / filtered). */
export function resolveExportAccounts(req: ExportAccountsRequest): Account[] {
  if (req.scope === 'selected') {
    if (!req.accountIds || req.accountIds.length === 0) return []
    return req.accountIds
      .map((id) => accountsRepo.getAccount(id))
      .filter((a): a is Account => a != null)
  }

  if (req.scope === 'filtered') {
    const { rows } = accountsRepo.listAccounts({
      search: req.search,
      searchField: req.searchField,
      status: req.status,
      folderId: req.folderId,
      limit: 1_000_000
    })
    return rows
  }

  // scope === 'all'
  const { rows } = accountsRepo.listAccounts({ limit: 1_000_000 })
  return rows
}

export function buildExportLines(req: ExportAccountsRequest): string[] {
  const accounts = resolveExportAccounts(req)
  return accounts.map((a) => formatAccountLine(a, req.format))
}

/** CSV-escape one field: wrap in quotes and double up any embedded quotes if needed. */
function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

export function buildExportCsv(req: ExportAccountsRequest): string {
  const accounts = resolveExportAccounts(req)
  const header = req.format.tokens.join(',')
  const rows = accounts.map((a) =>
    req.format.tokens
      .map((token) => {
        const field = EXPORT_TOKEN_TO_FIELD[token]
        const value = a[field]
        return csvEscape(value == null ? '' : String(value))
      })
      .join(',')
  )
  return [header, ...rows].join('\r\n')
}
