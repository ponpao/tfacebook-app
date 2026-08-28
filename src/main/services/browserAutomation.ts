// ---------------------------------------------------------------------------
// browserAutomation.ts  — "Login with Cookie" batch: opens a headed browser
// per selected account using its already-saved session cookie, with no
// password/2FA re-entry at all. Distinct from queueRunner.ts's Run Auto
// Login (which drives a full credential-based login + warm-up scenario
// pipeline, and is limited to one active batch app-wide via activeRun.ts) —
// this is a lighter, independent operation: just "open these accounts,
// already logged in, for the user to look at or interact with," concurrency-
// limited so a large selection doesn't spawn dozens of Chromium processes
// at once.
//
// launchContext() (browserContext.ts) already injects the account's saved
// cookie into every context it creates (see injectSavedCookies() there) —
// this module doesn't duplicate that logic, it just drives launchContext()
// per account and reports per-account success/failure.
// ---------------------------------------------------------------------------
import { BrowserWindow } from 'electron'
import { launchContext, trackContext } from '../automation/browserContext'
import * as accounts from '../db/accountsRepo'
import { IPC } from '../ipc/channels'

export interface CookieLoginEvent {
  accountId: number
  uid: string | null
  index: number
  total: number
  ok: boolean
  detail: string
}

export interface CookieLoginSummary {
  total: number
  succeeded: number
  failed: number
}

function broadcast(event: CookieLoginEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.automation.onCookieLoginProgress, event)
  }
}

/** Runs `items` through `worker` with at most `limit` in flight at once. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor
      if (index >= items.length) return
      cursor += 1
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

/**
 * Opens a headed, cookie-authenticated browser for each of the given
 * accounts, `concurrency` at a time (the caller passes the current
 * Threads setting from the toolbar — same convention as
 * automation:runQueue). Each account's status is set to "Live" with
 * status_detail "Cookie Login Success" on success (matching the spec's
 * required status text), or a specific failure reason on status_detail
 * without changing `status` — a browser that didn't come up logged in
 * doesn't necessarily mean the account is Die/Checkpoint, just that this
 * particular attempt didn't confirm it, so this deliberately doesn't
 * downgrade status the way a real Check Live/Die classification would.
 * Every launched context stays open afterward for the user to interact
 * with (tracked so Close Browsers can still shut it down) — this is
 * explicitly a "log in and leave it open" action, not a headless check.
 */
export async function loginWithCookieBatch(accountIds: number[], concurrency: number): Promise<CookieLoginSummary> {
  const rows = accounts.getAccountsByIds(accountIds)
  const total = rows.length
  let succeeded = 0
  let failed = 0

  await runWithConcurrency(rows, concurrency, async (account, index) => {
    const key = `cookie-login:${account.uid ?? account.id}`
    try {
      if (!account.cookie?.trim()) {
        throw new Error('No saved cookie for this account')
      }
      const context = await launchContext({ headless: false, account, slotIndex: index })
      trackContext(key, context)

      const page = context.pages()[0] ?? (await context.newPage())
      await page.goto('https://www.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' })

      accounts.updateAccount(account.id, {
        status: 'Live',
        status_detail: 'Cookie Login Success',
        live_status: 'Cookie Login Success',
        last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
      })
      succeeded += 1
      broadcast({ accountId: account.id, uid: account.uid, index: index + 1, total, ok: true, detail: 'Cookie Login Success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      accounts.updateAccount(account.id, { live_status: `Cookie login failed: ${message}` })
      failed += 1
      broadcast({ accountId: account.id, uid: account.uid, index: index + 1, total, ok: false, detail: message })
    }
  })

  return { total, succeeded, failed }
}
