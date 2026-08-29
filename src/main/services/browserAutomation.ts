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
import { launchContext, trackContext, untrackContext, validateCookieString } from '../automation/browserContext'
import { classifyPage, extractAllMetadata } from '../automation/autoLogin'
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

/**
 * Extracts a display name from an already-logged-in feed page via three
 * fallbacks, tried in order, specifically for accounts that arrived with no
 * saved UID (so the UID-scoped selector extractAllMetadata's own name
 * extraction relies on can't be used):
 *   1. The composer placeholder — "What's on your mind, {Name}?" — reading
 *      the text after the comma.
 *   2. The top nav bar's own profile link/icon aria-label or link text.
 *   3. A raw NAME field inside one of the page's inline hydration script
 *      payloads (Facebook embeds the viewer's own name in its initial JSON
 *      state under a "NAME" key on most page variants).
 * Best-effort throughout — a missing/changed selector just means no name.
 */
async function extractNameFromLiveFeed(page: Page): Promise<string | undefined> {
  const composerText = await page
    .locator(
      'div[role="main"] span:has-text("What\'s on your mind"), div[role="region"] span:has-text("What\'s on your mind")'
    )
    .first()
    .textContent()
    .catch(() => null)
  const composerMatch = composerText?.match(/,\s*([^,?]+)\?/)
  if (looksLikeRealName(composerMatch?.[1])) return composerMatch[1].trim()

  const navProfile = page.locator(
    'svg[aria-label="Your profile"], div[role="navigation"] a[href*="/me/"], a[aria-label="Your profile"]'
  ).first()
  const navRaw = await navProfile
    .getAttribute('aria-label')
    .catch(() => null)
    .then((v) => v ?? navProfile.textContent().catch(() => null))
  if (looksLikeRealName(navRaw)) return navRaw.trim()

  const scriptName = await page
    .evaluate(() => {
      const w = window as unknown as { __fb_currentUser?: { NAME?: string; name?: string } }
      if (w.__fb_currentUser?.NAME) return w.__fb_currentUser.NAME
      if (w.__fb_currentUser?.name) return w.__fb_currentUser.name
      const scripts = Array.from(document.querySelectorAll('script'))
      for (const script of scripts) {
        const match = script.textContent?.match(/"NAME":"([^"]+)"/)
        if (match) return match[1]
      }
      return null
    })
    .catch(() => null)
  if (looksLikeRealName(scriptName)) return scriptName.trim()

  return undefined
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
export async function loginWithCookieBatch(accountIds: number[], concurrency: number): Promise<CookieLoginSummary> {
  const rows = accounts.getAccountsByIds(accountIds)
  const total = rows.length
  let succeeded = 0
  let failed = 0

  await runWithConcurrency(rows, concurrency, async (account, index) => {
    const key = `cookie-login:${account.uid ?? account.id}`
    let context: Awaited<ReturnType<typeof launchContext>> | null = null
    try {
      const raw = account.cookie?.trim()
      if (!raw) {
        throw new Error('No saved cookie for this account')
      }
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
      await page.goto('https://www.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1500)
      const result = await classifyPage(page)

      if (result.status !== 'Live') {
        accounts.updateAccount(account.id, { live_status: 'Invalid/Incomplete Cookie' })
        failed += 1
        broadcast({ accountId: account.id, uid: account.uid, index: index + 1, total, ok: false, detail: 'Invalid/Incomplete Cookie' })
        return
      }

      // Metadata Extraction Mode (General Settings) governs how much
      // post-login enrichment runs here too, same as a full credential
      // login — 'fast' skips location/created-date, 'full' runs everything.
      // extractAllMetadata always re-extracts the live cookie jar as its
      // first step, so the DB's saved cookie gets refreshed to whatever
      // Facebook currently has (rotated tokens, newly-set cookies) rather
      // than staying pinned to the value that was there before this login.
      const metadata = await extractAllMetadata(page, context, resolvedUid, undefined)

      // STEP 2: extractAllMetadata's own name extraction is scoped to a
      // profile.php?id={uid} link when a uid is available — for an account
      // that just got its uid backfilled from c_user (above) that link may
      // not resolve on the first try, so a name-less result here falls back
      // to the composer/nav/script extraction tailored for exactly this
      // "no reliable uid yet" case. Only used to fill in a currently-empty
      // name, never to overwrite one already on file.
      let resolvedName = metadata.name
      if (!resolvedName && !account.name?.trim()) {
        resolvedName = await extractNameFromLiveFeed(page)
      }

      accounts.updateAccount(account.id, {
        status: 'Live',
        status_detail: 'Cookie Login Success',
        live_status: 'Cookie Login Success',
        ...(metadata.cookie ? { cookie: metadata.cookie } : {}),
        ...(metadata.token ? { token: metadata.token } : {}),
        ...(!account.name?.trim() && resolvedName ? { name: resolvedName } : {}),
        ...(metadata.friendsCount != null ? { friends_count: metadata.friendsCount } : {}),
        ...(metadata.groupsCount != null ? { groups_count: metadata.groupsCount } : {}),
        ...(metadata.location ? { location: metadata.location } : {}),
        ...(metadata.createdDate ? { created_date: metadata.createdDate } : {}),
        last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
      })
      succeeded += 1
      // uid may have just been backfilled above — broadcast the resolved
      // value so the UI table's live patch reflects it immediately rather
      // than the stale (empty) uid captured at the top of this closure.
      broadcast({ accountId: account.id, uid: resolvedUid, index: index + 1, total, ok: true, detail: 'Cookie Login Success' })
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
