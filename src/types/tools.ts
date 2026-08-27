// ---------------------------------------------------------------------------
// Tools & Utilities  — Fast UID Live Checker, Bulk Proxy Health Checker,
// Remove Duplicate Accounts.
// ---------------------------------------------------------------------------

export interface UidCheckResult {
  accountId: number
  uid: string | null
  status: 'Live' | 'Die' | 'Unknown'
  detail: string
}

export interface ProxyHealthResult {
  proxy: string
  alive: boolean
  latencyMs: number | null
  detail: string
}

export interface DuplicateAccountSummary {
  accountId: number
  uid: string | null
  email: string | null
  name: string | null
}
