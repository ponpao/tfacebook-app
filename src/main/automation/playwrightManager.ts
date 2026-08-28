// ---------------------------------------------------------------------------
// playwrightManager.ts  — headed/headless Chromium automation for accounts.
//   * openProfile: launch a headed browser and leave it open for the user
//   * checkLiveDie: headless session check via the persisted profile cookie
//   * closeAllBrowsers: close every tracked context (headed + queue runs)
// Login automation itself lives in autoLogin.ts; browser launching is shared
// via browserContext.ts.
// ---------------------------------------------------------------------------
import type { Account } from '../../types/account'
import { launchContext, trackContext, closeAllTrackedContexts } from './browserContext'
import {
  runAutoLogin,
  classifyPage,
  extractCookiesAndToken,
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

export type { AutoLoginResult }

/**
 * openProfile — launch a HEADED browser with the account's persistent profile,
 * navigate to Facebook, and leave it open. Tracked so closeAllBrowsers() can
 * shut it down. `slotIndex` positions the window in the tiling grid (see
 * browserContext.ts's tilePosition()) — pass an incrementing index when
 * opening several profiles in a batch so their windows don't stack on top of
 * each other at the same default position.
 */
export async function openProfile(
  account: Account,
  slotIndex?: number
): Promise<{ ok: boolean; detail: string }> {
  const key = `profile:${account.uid ?? account.id}`
  const context = await launchContext({ headless: false, account, slotIndex })
  trackContext(key, context)

  const page = context.pages()[0] ?? (await context.newPage())
  await page
    .goto('https://www.facebook.com', { timeout: 45000, waitUntil: 'domcontentloaded' })
    .catch(() => void 0)

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
    await page.goto('https://www.facebook.com/me', {
      timeout: 45000,
      waitUntil: 'domcontentloaded'
    })
    await page.waitForTimeout(1500)
    const result = await classifyPage(page)
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

/** Single-account auto-login, headed by default (kept open for the user to see). */
export async function autoLogin(
  account: Account,
  { headless = false }: { headless?: boolean } = {}
): Promise<AutoLoginResult> {
  return runAutoLogin(account, { headless })
}

/** Close every tracked browser context (headed profiles + in-flight runs). */
export async function closeAllBrowsers(): Promise<number> {
  return closeAllTrackedContexts()
}
