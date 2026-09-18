// ---------------------------------------------------------------------------
// windowManager.ts — bring a single tracked browser window to the front, for
// the Browser Windows panel's "Focus" action. UI/window-placement logic
// only, same scope note as windowArranger.ts: never touches login, cookie,
// stealth-injection, or DB code.
// ---------------------------------------------------------------------------
import { getTrackedContext, listTrackedWindows } from './browserContext'

/**
 * The tracked window's page viewport in CSS pixels — the coordinate space
 * both the CDP screencast frames and Input.dispatch* calls operate in. An
 * App Mode tile fetches this once (when it starts streaming) so it can
 * scale a click's position within its rendered <img> back up to real page
 * coordinates. null if the page has no viewport (shouldn't happen for a
 * tracked window, since every launchContext() call sets one — see
 * browserContext.ts) or the window has already closed.
 */
export function getViewportSize(key: string): { width: number; height: number } | null {
  const context = getTrackedContext(key)
  const page = context?.pages()[0]
  return page?.viewportSize() ?? null
}

/**
 * Brings the tracked window's first page to the front (both within its own
 * Chromium process and, on Windows, its OS-level window). Unlike
 * windowArranger.ts's bounds-setting, this has a direct Playwright API
 * (Page.bringToFront()) — no CDP session needed.
 */
export async function focusTrackedWindow(key: string): Promise<boolean> {
  const context = getTrackedContext(key)
  const page = context?.pages()[0]
  if (!page) return false
  try {
    await page.bringToFront()
    return true
  } catch {
    return false
  }
}

/**
 * Reloads a tracked window's current page — the Browser Windows panel's
 * per-tile Reload button (both App Mode and Browser View tiles), and also
 * used internally by screencast.ts as a stuck-first-frame recovery (a fresh
 * navigation always repaints, guaranteeing the CDP screencast gets at least
 * one frame to send).
 */
export async function reloadTrackedWindow(key: string): Promise<boolean> {
  const context = getTrackedContext(key)
  const page = context?.pages()[0]
  if (!page) return false
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 })
    return true
  } catch {
    return false
  }
}

/**
 * Browser back-navigation for a tracked window's page — the Browser Windows
 * panel's per-tile Back button.
 */
export async function goBackTrackedWindow(key: string): Promise<boolean> {
  const context = getTrackedContext(key)
  const page = context?.pages()[0]
  if (!page) return false
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 })
    return true
  } catch {
    return false
  }
}

/**
 * Navigates a tracked window's page back to the Facebook feed — the Browser
 * Windows panel's per-tile Home button. web.facebook.com is this app's own
 * canonical landing page (see playwrightManager.ts's openProfile() and
 * autoLogin.ts's FACEBOOK_URLS.full) for every launch, App Mode included —
 * Facebook's own server handles the mobile-UA redirect from there.
 */
export async function goHomeTrackedWindow(key: string): Promise<boolean> {
  const context = getTrackedContext(key)
  const page = context?.pages()[0]
  if (!page) return false
  try {
    await page.goto('https://web.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 })
    return true
  } catch {
    return false
  }
}

export interface WindowSnapshot {
  /** Low-quality JPEG data URL of the page's current content. */
  dataUrl: string
  /** The page's current URL, e.g. "https://web.facebook.com/..." — shown in the tile's fake Chrome-App-Mode address bar. */
  url: string
}

/**
 * Captures one tracked window's current page as a low-quality JPEG data URL
 * plus its current URL, for the Browser Windows panel's phone-tile
 * thumbnails. Low quality keeps each capture small since this runs
 * repeatedly on a poll interval — a glance at login/checkpoint state doesn't
 * need a lossless image. A short timeout keeps one slow/busy page from
 * blocking the rest of a batch. page.url() is synchronous/cheap (no
 * navigation or wait involved), so it's bundled into the same capture
 * rather than a separate call.
 */
export async function screenshotTrackedWindow(key: string): Promise<WindowSnapshot | null> {
  const context = getTrackedContext(key)
  const page = context?.pages()[0]
  if (!page) return null
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 40, timeout: 3000 })
    return { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, url: page.url() }
  } catch {
    return null
  }
}

/**
 * Screenshots every currently-tracked window in one batch — a single IPC
 * round-trip per poll tick instead of one per open window. Keys whose
 * capture failed (closed mid-batch, no page yet) are simply omitted rather
 * than included with a null value, so callers can treat a missing key the
 * same as "no snapshot yet" without a separate null check.
 */
export async function screenshotAllTrackedWindows(): Promise<Record<string, WindowSnapshot>> {
  const keys = listTrackedWindows().map((w) => w.key)
  const results = await Promise.all(
    keys.map(async (key) => [key, await screenshotTrackedWindow(key)] as const)
  )
  return Object.fromEntries(
    results.filter((entry): entry is [string, WindowSnapshot] => entry[1] !== null)
  )
}
