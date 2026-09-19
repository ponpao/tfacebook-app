// ---------------------------------------------------------------------------
// playwrightManager.ts  — headed/headless Chromium automation for accounts.
//   * openProfile: launch a headed browser and leave it open for the user
//   * checkLiveDie: headless session check via the persisted profile cookie
//   * closeAllBrowsers: close every tracked context (headed + queue runs)
// Login automation itself lives in autoLogin.ts; browser launching is shared
// via browserContext.ts.
// ---------------------------------------------------------------------------
import type { Account } from '../../types/account'
import { launchContext, trackContext, closeAllTrackedContexts, pickContextPage } from './browserContext'
import { getAppSettings } from '../db/settingsRepo'
import {
  runAutoLogin,
  classifyPage,
  extractCookiesAndToken,
  ensureFacebookPageReady,
  type AutoLoginResult,
  type LoginStatus
} from './autoLogin'

export interface LiveDieResult {
  status: LoginStatus
  detail: string
  /** Only set when status is 'Live' — a freshly re-extracted cookie/token so callers can keep the DB's session data current (e.g. for the next Cloud Sync push) rather than only refreshing it during a full login run. */
  cookie?: string
  token?: string
}

import * as accountsRepo from '../db/accountsRepo'

export type { AutoLoginResult }

/**
 * openProfile — launch the account's persistent profile and leave it open.
 * Headed vs headless follows General Settings Browser Mode. App View only
 * changes the device fingerprint (phone-sized window when headed, screencast
 * tile when headless). Tracked so closeAllBrowsers() can shut it down.
 * `slotIndex` tiles headed windows; ignored when headless.
 */
export async function openProfile(
  account: Account,
  slotIndex?: number,
  rowNumber?: number,
  /** Overrides the default https://web.facebook.com landing URL — used by the row context menu's "🚀 Open Browser with URL" action, and by openProfile() itself falling back to account.target_url when the caller doesn't pass one explicitly. Session/cookie handling (launchContext, cookie sync below) is entirely unaffected — only the initial page.goto() destination changes. */
  targetUrl?: string
): Promise<{ ok: boolean; detail: string }> {
  const key = `profile:${account.uid ?? account.id}`
  // Headless (Browser Mode) hides the OS window — App View then only appears
  // as a Browser Windows screencast tile. Headed + App View must still open
  // a real phone-sized window; View Mode only picks the device fingerprint.
  const settings = getAppSettings()
  const context = await launchContext({
    headless: settings.browserMode === 'headless',
    account,
    slotIndex,
    rowNumber
  })
  trackContext(key, context, {
    accountName: account.name?.trim() || account.uid || 'Unknown',
    rowNumber,
    uid: account.uid ?? undefined,
    viewMode: settings.viewMode
  })

  // Auto-sync cookies: whenever the user logs in or browses, automatically
  // extract and save the fresh session cookie to the database so it never goes stale.
  const syncCookiesIfLoggedIn = async (): Promise<void> => {
    try {
      const cookies = await context.cookies()
      const cUser = cookies.find((c) => c.name === 'c_user')?.value
      const xs = cookies.find((c) => c.name === 'xs')?.value
      if (cUser && xs) {
        const freshCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        const current = accountsRepo.getAccount(account.id)
        if (current && current.cookie !== freshCookie) {
          accountsRepo.updateAccount(account.id, {
            cookie: freshCookie,
            status: 'Live',
            status_detail: 'Cookie Synced from Browser',
            live_status: 'Live',
            last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
          })
        }
      }
    } catch {
      /* ignore context closing errors */
    }
  }

  const syncTimer = setInterval(() => void syncCookiesIfLoggedIn(), 2500)
  context.on('close', () => {
    clearInterval(syncTimer)
    void syncCookiesIfLoggedIn()
  })

  const page = pickContextPage(context) ?? context.pages()[0] ?? (await context.newPage())
  page.on('load', () => void syncCookiesIfLoggedIn())
  context.on('page', (p) => p.on('load', () => void syncCookiesIfLoggedIn()))

  // Explicit targetUrl param wins; otherwise fall back to the account's own
  // saved target_url (set via the row context menu's "Assign Target URL"),
  // and only default to the plain Facebook feed if neither is set.
  const destination =
    targetUrl?.trim() ||
    account.target_url?.trim() ||
    (settings.viewMode === 'app' ? 'https://m.facebook.com' : 'https://web.facebook.com')
  await ensureFacebookPageReady(page, account, destination)

  return { ok: true, detail: 'Browser Active' }
}

/**
 * checkLiveDie — HEADLESS check of the account's session.
 * Reuses the persistent profile so an already-authenticated cookie is used
 * (restored via injectSavedCookies() in browserContext.ts if the on-disk
 * profile's own encrypted cookie store can't be read, e.g. after arriving
 * via Backup/Restore or Cloud Sync from a different machine). On a
 * confirmed-Live result, also re-extracts the current cookie/token so the
 * caller can refresh the DB — Facebook rotates/reissues session cookies
 * over time, so the value saved at last login can go stale even while the
 * session itself is still perfectly valid.
 */
export async function checkLiveDie(account: Account): Promise<LiveDieResult> {
  const context = await launchContext({ headless: true, account })
  try {
    const page = await context.newPage()

    // Speed: a liveness check only needs the page's URL and text, never its
    // visual assets. Blocking images/media/fonts/stylesheets cuts the bulk
    // of the bytes and round trips out of every check. Deliberately does NOT
    // block scripts — Facebook renders the feed/checkpoint DOM client-side,
    // so classifyPage() would see an empty shell without them.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType()
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') {
        return route.abort()
      }
      return route.continue()
    })

    await page.goto('https://www.facebook.com/me', {
      timeout: 20000,
      waitUntil: 'domcontentloaded'
    })

    // Poll for a definitive answer instead of always paying a flat wait:
    // most sessions classify on the first pass (~0ms extra), and only a
    // still-hydrating page costs additional time — capped well under the
    // old unconditional 1.5s + 45s navigation budget.
    let result = await classifyPage(page)
    const settleDeadline = Date.now() + 2500
    while (result.status === 'Unknown' && Date.now() < settleDeadline) {
      await page.waitForTimeout(250)
      result = await classifyPage(page)
    }
    if (result.status === 'Live') {
      const { cookie, token } = await extractCookiesAndToken(context)
      return { ...result, cookie, token }
    }
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'Unknown', detail: `Check failed: ${message}` }
  } finally {
    await context.close().catch(() => void 0)
  }
}

/**
 * Single-account auto-login (the row context menu's "Run Auto Login").
 * Follows General Settings Browser Mode (headed vs headless). View Mode
 * only changes the device fingerprint — App View + Headed is a visible
 * phone-sized window. An explicit `headless` argument still wins.
 */
export async function autoLogin(
  account: Account,
  { headless }: { headless?: boolean } = {}
): Promise<AutoLoginResult> {
  const resolvedHeadless = headless ?? getAppSettings().browserMode === 'headless'
  return runAutoLogin(account, { headless: resolvedHeadless })
}

/** Close every tracked browser context (headed profiles + in-flight runs). */
export async function closeAllBrowsers(): Promise<number> {
  return closeAllTrackedContexts()
}
