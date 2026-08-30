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
// this module doesn't duplicate that injection logic, it just drives
// launchContext() per account. It DOES duplicate the cookie's c_user/xs
// validation (validateCookieString) up front, and verifies the actual
// post-navigation page state (classifyPage) rather than trusting that a
// non-throwing goto() means the account is really logged in — a cookie
// missing session fields (e.g. only _GRECAPTCHA=...) still lets goto()
// resolve normally onto Facebook's login page, which is not a success.
//
// Unlike openProfile/loginWithCookie's OLD behavior, the launched context is
// ALWAYS closed once verification + metadata extraction finish (success or
// failure) — this is a batch data-refresh action, not "open and leave it for
// the user," so leaving dozens of Chromium processes running after a large
// batch would just burn RAM for no one to look at.
// ---------------------------------------------------------------------------
import { BrowserWindow } from 'electron'
import type { Page } from 'playwright'
import {
  launchContext,
  trackContext,
  untrackContext,
  validateCookieString,
  applyWindowTitle,
  buildWindowTitle
} from '../automation/browserContext'
import {
  classifyPage,
  extractCookiesAndToken,
  extractFromInlineScripts,
  extractProfileName,
  extractFriendsAndFollowers,
  extractCreatedDateFromActivityLog,
  extractPrimaryLocation,
  extractCurrentDeviceLocation,
  extractGroupsCount,
  extractPagesCount
} from '../automation/autoLogin'
import { getAppSettings } from '../db/settingsRepo'
import type { Account } from '../../types/account'
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

/** Words that indicate extracted text is interstitial/generic UI chrome, not a real display name. */
const NON_NAME_HINTS = ['facebook', 'log in', 'sign up', 'notification', 'home', 'watch', 'marketplace']

function looksLikeRealName(s: string | null | undefined): s is string {
  if (!s) return false
  const name = s.trim()
  if (name.length < 2 || name.length > 60) return false
  const lower = name.toLowerCase()
  return !NON_NAME_HINTS.some((h) => lower.includes(h))
}



/** Runs `items` through `worker` with at most `limit` in flight at once. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      // Claim an index ATOMICALLY: post-increment reads and advances the
      // cursor in one expression, with no statement in between where another
      // worker could resume. The previous `const index = cursor; if (...);
      // cursor += 1` sequence had a real race — every worker awaits inside
      // this loop, so two could both read the same cursor value before
      // either incremented it, then process the SAME account twice while
      // silently skipping another (the "dropped task" symptom with 2+
      // threads).
      const index = cursor++
      if (index >= items.length) return
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
 * status_detail "Cookie Login Success" only once BOTH (a) the saved cookie
 * actually contains the c_user and xs session cookies Facebook requires,
 * and (b) the post-navigation page genuinely classifies as logged in
 * (classifyPage) rather than having merely reached facebook.com's login
 * page without throwing. A cookie missing those fields (e.g. only
 * _GRECAPTCHA=... saved) is reported as "Invalid/Incomplete Cookie" and
 * never claims success. Any other failure reason lands on status_detail
 * without changing `status` — a browser that didn't come up logged in
 * doesn't necessarily mean the account is Die/Checkpoint, just that this
 * particular attempt didn't confirm it, so this deliberately doesn't
 * downgrade status the way a real Check Live/Die classification would.
 * Once verification (and, unless Metadata Extraction Mode is "None",
 * metadata extraction) finishes, the context is ALWAYS closed in a finally
 * block — success, failure, or a thrown error all release the browser
 * process rather than leaving it open.
 */
export async function loginWithCookieBatch(
  accountIds: number[],
  concurrency: number,
  /** Optional map of accountId -> the account's 1-based row number in the grid as the user sees it, used only for the Chrome window title. */
  rowNumbers?: Record<number, number>
): Promise<CookieLoginSummary> {
  const rows = accounts.getAccountsByIds(accountIds)
  const total = rows.length
  let succeeded = 0
  let failed = 0

  await runWithConcurrency(rows, concurrency, async (account, index) => {
    const key = `cookie-login:${account.uid ?? account.id}`
    let context: Awaited<ReturnType<typeof launchContext>> | null = null

    // Writes the in-progress step to the account's live_status AND pushes a
    // progress event so the grid's Activity Status column updates in real
    // time instead of only flipping once at the very end. Keyed on
    // account.id — with 2+ threads each worker reports only its own account,
    // and the renderer matches strictly on accountId (never row index).
    const step = (detail: string): void => {
      accounts.updateAccount(account.id, { live_status: detail })
      broadcast({ accountId: account.id, uid: account.uid, index: index + 1, total, ok: true, detail })
    }

    try {
      const raw = account.cookie?.trim()
      if (!raw) {
        throw new Error('No saved cookie for this account')
      }
      step('Injecting Cookies...')
      const { cookies, valid } = validateCookieString(raw)
      if (!valid) {
        accounts.updateAccount(account.id, { live_status: 'Invalid/Incomplete Cookie' })
        failed += 1
        broadcast({ accountId: account.id, uid: account.uid, index: index + 1, total, ok: false, detail: 'Invalid/Incomplete Cookie' })
        return
      }

      // STEP 1: extract c_user from the cookie itself and backfill the
      // account's uid immediately if it doesn't have one on file — this
      // doesn't require the browser to be open at all, so it's resolved
      // before launchContext() rather than after.
      const cUserFromCookie = cookies.find((c) => c.name === 'c_user')?.value
      let resolvedUid = account.uid
      if (!resolvedUid?.trim() && cUserFromCookie) {
        accounts.updateAccount(account.id, { uid: cUserFromCookie })
        resolvedUid = cUserFromCookie
      }

      context = await launchContext({
        headless: false,
        account,
        slotIndex: index,
        rowNumber: rowNumbers?.[account.id],
        // A persistent profile dir can carry a stale, different Facebook
        // identity from an earlier run — left in place, that surfaces
        // Facebook's own account-chooser interstitial ("Continue as X /
        // Use another profile") for the WRONG account before the
        // just-injected cookie's session ever gets a chance to take
        // effect. Clearing first (before injection) means this cookie is
        // the only session Facebook can possibly offer.
        resetProfileBeforeCookieInject: true
      })
      trackContext(key, context)

      const page = context.pages()[0] ?? (await context.newPage())

      // ---- STEP 1: cookie injection (done by launchContext above) + fast load ----
      step('Opening Facebook...')
      // waitUntil 'commit' resolves as soon as the navigation response
      // starts, rather than blocking on 'domcontentloaded' — Facebook's
      // white Meta splash screen can hold DOMContentLoaded for a long time
      // while it hydrates, which is what made cookie login feel hung. The
      // readiness we actually care about is checked below by polling
      // classifyPage(), so waiting for the document event bought nothing.
      await page.goto('https://www.facebook.com/', { timeout: 25000, waitUntil: 'commit' })

      // ---- STEP 2: explicit Live/Die check, BEFORE any scraping ----
      // Poll for a definitive classification instead of a flat sleep: a
      // fast session resolves almost immediately, and only a slow-hydrating
      // one pays the extra wait (capped).
      step('Checking Live Status...')
      let result = await classifyPage(page)
      const settleDeadline = Date.now() + 8000
      while (result.status === 'Unknown' && Date.now() < settleDeadline) {
        await page.waitForTimeout(300)
        result = await classifyPage(page)
      }

      if (result.status !== 'Live') {
        // Checkpoint/suspension classifies as its own status; anything else
        // that isn't Live means the saved cookie no longer authenticates.
        const isCheckpoint = result.status === 'Checkpoint' || result.status === 'Die'
        const detail = isCheckpoint ? result.detail : 'Cookie Expired / Invalid'
        accounts.updateAccount(account.id, {
          ...(isCheckpoint ? { status: result.status, status_detail: result.detail } : {}),
          live_status: detail
        })
        failed += 1
        broadcast({ accountId: account.id, uid: account.uid, index: index + 1, total, ok: false, detail })
        return
      }

      // Step 1: Base Script Parse (Immediate DB commit)
      step('Extracting Profile Info...')
      await page.waitForTimeout(1000)
      const { cookie: liveCookie, token: liveToken } = await extractCookiesAndToken(context)
      const scriptData = await extractFromInlineScripts(page)
      const cUser = liveCookie
        ? liveCookie.split(';').map((p) => p.trim()).find((p) => p.startsWith('c_user='))?.slice('c_user='.length)
        : undefined
      resolvedUid = account.uid?.trim() ? account.uid : (scriptData.userId ?? cUser ?? resolvedUid)
      let dtsgToken = scriptData.dtsg
      const fastName = looksLikeRealName(scriptData.name)
        ? scriptData.name.trim()
        : (await extractProfileName(page, resolvedUid)) || account.name?.trim()

      const step1Update: Partial<Account> = {
        status: 'Live',
        status_detail: 'Cookie Login Success',
        live_status: 'Live — verifying profile...',
        ...(liveCookie ? { cookie: liveCookie } : {}),
        ...(liveToken ? { token: liveToken } : {}),
        ...(resolvedUid ? { uid: resolvedUid } : {}),
        ...(dtsgToken ? { dtsg_token: dtsgToken } : {}),
        ...(fastName ? { name: fastName } : {})
      }
      accounts.updateAccount(account.id, step1Update)
      broadcast({
        accountId: account.id,
        uid: resolvedUid || null,
        index: index + 1,
        total,
        ok: true,
        detail: 'Live — verifying profile...'
      })

      if (fastName) {
        await applyWindowTitle(
          context,
          buildWindowTitle({ ...account, name: fastName, uid: resolvedUid }, rowNumbers?.[account.id])
        )
      }

      const isFastMode = getAppSettings().metadataExtractionMode === 'fast'

      if (!isFastMode) {
        // Step 2: Friends & Followers Extraction (via /me?sk=friends)
        try {
          step('Extracting Friends & Followers...')
          const ff = await extractFriendsAndFollowers(page, resolvedUid)
          const step2Update: Partial<Account> = {
            ...(ff.friendsCount != null ? { friends_count: ff.friendsCount } : {}),
            ...(ff.followers ? { followers: ff.followers } : {}),
            ...(ff.following ? { following: ff.following } : {}),
            ...(ff.friendsList ? { friends_list: JSON.stringify(ff.friendsList) } : {})
          }
          if (!dtsgToken) {
            const extra = await extractFromInlineScripts(page)
            if (extra.dtsg) {
              dtsgToken = extra.dtsg
              step2Update.dtsg_token = dtsgToken
            }
          }
          if (Object.keys(step2Update).length > 0) {
            accounts.updateAccount(account.id, step2Update)
            broadcast({
              accountId: account.id,
              uid: resolvedUid || null,
              index: index + 1,
              total,
              ok: true,
              detail: 'Extracting Friends & Followers...'
            })
          }
        } catch (err) {
          console.warn('[CookieLogin] Step 2 friends/followers error:', err)
        }

        // Step 3: Created Date Extraction (via /me/allactivity)
        try {
          step('Extracting Created Date...')
          const createdDate = await extractCreatedDateFromActivityLog(page)
          const step3Update: Partial<Account> = {}
          if (createdDate) step3Update.created_date = createdDate
          if (!dtsgToken) {
            const extra = await extractFromInlineScripts(page)
            if (extra.dtsg) {
              dtsgToken = extra.dtsg
              step3Update.dtsg_token = dtsgToken
            }
          }
          if (Object.keys(step3Update).length > 0) {
            accounts.updateAccount(account.id, step3Update)
            broadcast({
              accountId: account.id,
              uid: resolvedUid || null,
              index: index + 1,
              total,
              ok: true,
              detail: 'Extracting Created Date...'
            })
          }
        } catch (err) {
          console.warn('[CookieLogin] Step 3 created date error:', err)
        }

        // Step 4: Location Extractions
        try {
          step('Extracting Locations...')
          const primaryLoc = await extractPrimaryLocation(page)
          const currentLoc = await extractCurrentDeviceLocation(page)
          const step4Update: Partial<Account> = {
            ...(primaryLoc ? { location: primaryLoc } : {}),
            ...(currentLoc ? { current_location: currentLoc } : {})
          }
          if (Object.keys(step4Update).length > 0) {
            accounts.updateAccount(account.id, step4Update)
            broadcast({
              accountId: account.id,
              uid: resolvedUid || null,
              index: index + 1,
              total,
              ok: true,
              detail: 'Extracting Locations...'
            })
          }
        } catch (err) {
          console.warn('[CookieLogin] Step 4 location error:', err)
        }

        // Step 5: Groups & Pages Extractions
        try {
          step('Extracting Groups & Pages...')
          const groupsCount = await extractGroupsCount(page)
          const pagesResult = await extractPagesCount(page)
          const step5Update: Partial<Account> = {
            ...(groupsCount != null ? { groups_count: groupsCount } : {}),
            ...(pagesResult != null
              ? {
                  pages_count: pagesResult.count,
                  pages_data: JSON.stringify(pagesResult.pages)
                }
              : {})
          }
          if (Object.keys(step5Update).length > 0) {
            accounts.updateAccount(account.id, step5Update)
            broadcast({
              accountId: account.id,
              uid: resolvedUid || null,
              index: index + 1,
              total,
              ok: true,
              detail: 'Extracting Groups & Pages...'
            })
          }
        } catch (err) {
          console.warn('[CookieLogin] Step 5 groups/pages error:', err)
        }
      }

      // Step 6: completion
      accounts.updateAccount(account.id, {
        status: 'Live',
        status_detail: 'Cookie Login Success',
        live_status: 'Cookie Login Success',
        last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
      })
      succeeded += 1
      broadcast({
        accountId: account.id,
        uid: resolvedUid || null,
        index: index + 1,
        total,
        ok: true,
        detail: 'Cookie Login Success'
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      accounts.updateAccount(account.id, { live_status: `Cookie login failed: ${message}` })
      failed += 1
      broadcast({ accountId: account.id, uid: account.uid, index: index + 1, total, ok: false, detail: message })
    } finally {
      untrackContext(key)
      await context?.close().catch(() => void 0)
    }
  })

  return { total, succeeded, failed }
}
