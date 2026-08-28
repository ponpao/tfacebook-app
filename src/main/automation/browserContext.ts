// ---------------------------------------------------------------------------
// browserContext.ts  — shared Playwright context launching for all automation
// modules (openProfile, checkLiveDie, autoLogin, queueRunner).
//   * per-UID persistent profiles under userData/profiles/{uid}
//   * proxy support (http / socks5, with auth)
//   * stealth launch args + randomized viewport/UA
//   * a registry of tracked contexts so "Close Browsers" / Stop can close them
// ---------------------------------------------------------------------------
import { app, screen } from 'electron'
import { join } from 'path'
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { chromium, type BrowserContext, type Cookie } from 'playwright'
import type { Account } from '../../types/account'
import { getAppSettings } from '../db/settingsRepo'
import { buildStealthScript } from './stealthEngine'

/**
 * Parses a "name=value; name2=value2; ..." cookie string (this app's stored
 * format — see extractCookiesAndToken() in autoLogin.ts) into Playwright
 * cookie objects addCookies() accepts, targeting Facebook's cookie domain.
 *
 * This exists because Chrome/Chromium encrypts a profile's on-disk Cookies
 * SQLite file with Windows DPAPI, keyed to the specific Windows user account
 * (and, in practice, the specific machine) that created it — a profile
 * folder copied to a different PC (via Backup/Restore or Cloud Sync) still
 * has the encrypted bytes on disk, but Chromium on the new machine cannot
 * decrypt them and the account effectively looks logged out there, even
 * though the DB's `cookie` column has the real session values in plain
 * text. Injecting them via the CDP-backed addCookies() bypasses that
 * on-disk encrypted store entirely — it writes straight into the running
 * browser's in-memory cookie jar, which Facebook accepts the same as any
 * other cookie regardless of which machine set it.
 */
function parseCookieString(raw: string): Cookie[] {
  const cookies: Cookie[] = []
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name || !value) continue
    cookies.push({
      name,
      value,
      domain: '.facebook.com',
      path: '/',
      // Facebook's real cookies are a mix of session and long-lived
      // (xs/c_user/datr survive well past a year) — expires: -1 marks this
      // a session cookie in Playwright's API, but since Facebook's own
      // Set-Cookie response on any subsequent request will re-issue proper
      // expiries anyway, matching that exactly here isn't worth the
      // complexity of parsing per-cookie attributes this app never stored
      // in the first place (the DB only ever kept name=value pairs).
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'None'
    })
  }
  return cookies
}

/**
 * Injects the account's saved cookie string into a freshly-launched
 * context, before any navigation — restoring a cross-machine session that
 * Chromium's own DPAPI-encrypted profile storage cannot. A quick sanity
 * check (session-identifying cookie names) avoids wasting a CDP round trip
 * or polluting the cookie jar with garbage on a blank/never-logged-in
 * account's empty cookie field. Best-effort: a malformed cookie string
 * should never prevent the browser from opening.
 */
async function injectSavedCookies(context: BrowserContext, account: Account): Promise<void> {
  const raw = account.cookie?.trim()
  if (!raw) return
  if (!/\bc_user=|\bxs=|\bdatr=/.test(raw)) return
  try {
    const cookies = parseCookieString(raw)
    if (cookies.length > 0) await context.addCookies(cookies)
  } catch {
    /* malformed cookie string — proceed with whatever the on-disk profile already has */
  }
}

// MaxCare-style compact tiled window: small enough that many can be seen at
// once in a grid across the screen, keyed by worker slot index (0, 1, 2...).
const TILE_WIDTH = 420
const TILE_HEIGHT = 620
const TILE_GAP_X = 5 // 425px pitch leaves a 5px gutter between windows
const TILE_GAP_Y = 5 // 625px pitch

/** Compute the (x, y) top-left position for a window at `slotIndex` in a grid that fits the primary display. */
function tilePosition(slotIndex: number): { x: number; y: number } {
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const cols = Math.max(1, Math.floor(workArea.width / (TILE_WIDTH + TILE_GAP_X)))
  const col = slotIndex % cols
  const row = Math.floor(slotIndex / cols)
  return {
    x: col * (TILE_WIDTH + TILE_GAP_X),
    y: row * (TILE_HEIGHT + TILE_GAP_Y)
  }
}

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 }
]

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
]

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Root directory for all persistent browser profiles. Uses the configured
 * "Chrome Profile Storage Path" (General Settings) when set — e.g. to move
 * profiles onto a drive with more free space — falling back to the default
 * {userData}/profiles otherwise. Read fresh each call (not cached) so a
 * settings change takes effect on the very next login without a restart.
 */
function profilesRoot(): string {
  const configured = getAppSettings().customProfileDirectory?.trim()
  const root = configured ? configured : join(app.getPath('userData'), 'profiles')
  mkdirSync(root, { recursive: true })
  return root
}

function profileDir(uid: string): string {
  const dir = join(profilesRoot(), uid || 'unknown')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Root directory for downloaded avatar images, one .jpg per account UID. */
function avatarsRoot(): string {
  const root = join(app.getPath('userData'), 'avatars')
  mkdirSync(root, { recursive: true })
  return root
}

/** Local on-disk path an account's avatar is saved to/read from — always `{uid}.jpg`. */
export function avatarFilePath(uid: string | null | undefined): string {
  return join(avatarsRoot(), `${uid || 'unknown'}.jpg`)
}

/**
 * Dedicated folder for Checkpoint 282 unlock photos — separate from the
 * scraped-avatar cache (avatarsRoot) since a photo submitted for identity
 * verification is a deliberate, curated choice, not whatever the last login
 * happened to scrape. Created on first use; starts empty.
 */
function avatarUnlockRoot(): string {
  const root = join(app.getPath('userData'), 'avatar_unlock')
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * Find an existing local avatar file for Checkpoint 282 unlock, checked in
 * order: {avatar_unlock}/{uid}.jpg, {avatar_unlock}/{uid}.png, any image
 * file in {avatar_unlock} (fallback for a single shared photo), then the
 * app's own scraped-avatar cache as a last resort. Returns null if nothing
 * is found — unlock282.ts must never fabricate a photo, so only a genuinely
 * pre-existing local file is ever eligible to be uploaded.
 */
export function findLocalAvatarFile(uid: string | null | undefined): string | null {
  const unlockDir = avatarUnlockRoot()
  const jpg = join(unlockDir, `${uid || 'unknown'}.jpg`)
  if (existsSync(jpg)) return jpg
  const png = join(unlockDir, `${uid || 'unknown'}.png`)
  if (existsSync(png)) return png

  const anyImage = readdirSync(unlockDir).find((f) => /\.(jpe?g|png)$/i.test(f))
  if (anyImage) return join(unlockDir, anyImage)

  const scrapedJpg = avatarFilePath(uid)
  if (existsSync(scrapedJpg)) return scrapedJpg
  const scrapedPng = join(avatarsRoot(), `${uid || 'unknown'}.png`)
  if (existsSync(scrapedPng)) return scrapedPng

  return null
}

/**
 * Disable Chrome's built-in password manager (save-password bubble + the
 * "check your saved passwords" nags) by pre-seeding the profile's Preferences
 * file — Playwright's launchPersistentContext has no direct API for Chrome
 * prefs, so this is the standard way to set them for a persistent profile.
 * Best-effort: a malformed/locked prefs file must never block a launch.
 */
function disablePasswordManagerPrefs(dir: string): void {
  const prefsPath = join(dir, 'Default', 'Preferences')
  try {
    mkdirSync(join(dir, 'Default'), { recursive: true })
    let prefs: Record<string, unknown> = {}
    try {
      prefs = JSON.parse(readFileSync(prefsPath, 'utf8'))
    } catch {
      prefs = {}
    }
    prefs.credentials_enable_service = false
    const profile = (prefs.profile && typeof prefs.profile === 'object' ? prefs.profile : {}) as Record<
      string,
      unknown
    >
    profile.password_manager_enabled = false
    prefs.profile = profile
    writeFileSync(prefsPath, JSON.stringify(prefs), 'utf8')
  } catch {
    /* best-effort — a missing/locked Preferences file must not block launch */
  }
}

/**
 * Resolve the on-disk persistent-profile path for an account without
 * creating it — used by permanent-delete cleanup so a Recycle Bin purge also
 * removes the account's saved browser profile (cookies, cache, etc.).
 */
export function resolveProfileDir(uid: string | null): string {
  return join(profilesRoot(), uid || 'unknown')
}

/**
 * Parse an account.proxy string into a Playwright proxy config.
 * Accepts:  host:port  |  host:port:user:pass  |  scheme://user:pass@host:port
 */
export function parseProxy(
  raw: string | null | undefined
): { server: string; username?: string; password?: string } | undefined {
  if (!raw || !raw.trim()) return undefined
  const value = raw.trim()

  // scheme://user:pass@host:port
  if (value.includes('://')) {
    try {
      const u = new URL(value)
      const server = `${u.protocol}//${u.hostname}:${u.port || '80'}`
      return u.username
        ? {
            server,
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password)
          }
        : { server }
    } catch {
      /* fall through to colon parsing */
    }
  }

  // host:port[:user:pass]
  const parts = value.split(':')
  if (parts.length >= 2) {
    const [host, port, user, pass] = parts
    const server = `http://${host}:${port}`
    return user ? { server, username: user, password: pass ?? '' } : { server }
  }

  return undefined
}

export interface LaunchOpts {
  /** Explicit override; omit to fall back to the persisted General Settings browser mode. */
  headless?: boolean
  account: Account
  /**
   * Worker/thread slot (0, 1, 2...) used to tile this window in a MaxCare-style
   * grid across the screen instead of stacking every headed window at the
   * same position. Ignored when headless.
   */
  slotIndex?: number
}

/** Randomized delay (ms) using the persisted General Settings delay range. */
export async function settingsDelay(): Promise<void> {
  const { delayMinSeconds, delayMaxSeconds } = getAppSettings()
  const lo = Math.min(delayMinSeconds, delayMaxSeconds)
  const hi = Math.max(delayMinSeconds, delayMaxSeconds)
  const seconds = lo + Math.random() * (hi - lo)
  await new Promise((resolve) => setTimeout(resolve, Math.round(seconds * 1000)))
}

/** Launch a stealth-configured persistent context for an account. */
export async function launchContext({
  headless,
  account,
  slotIndex
}: LaunchOpts): Promise<BrowserContext> {
  const settings = getAppSettings()
  const viewport = pick(VIEWPORTS)
  // A user-assigned UA (via Import Useragent) wins; otherwise pick a random one.
  const userAgent = account.user_agent?.trim() || pick(USER_AGENTS)
  const proxy = parseProxy(account.proxy)
  const resolvedHeadless = headless ?? settings.browserMode === 'headless'
  const executablePath =
    settings.customChromiumPath.trim() && existsSync(settings.customChromiumPath.trim())
      ? settings.customChromiumPath.trim()
      : undefined

  const dir = profileDir(account.uid ?? 'unknown')
  disablePasswordManagerPrefs(dir)

  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--disable-save-password-bubble',
    '--disable-features=PasswordManager,PasswordManagerUI,OptimizationGuideModelDownloading',
    '--no-default-browser-check'
  ]

  // MaxCare-style compact tiling — only meaningful for headed windows; a
  // headless context has no on-screen window to position.
  if (!resolvedHeadless) {
    const { x, y } = tilePosition(slotIndex ?? 0)
    args.push(`--window-size=${TILE_WIDTH},${TILE_HEIGHT}`, `--window-position=${x},${y}`)
  }

  const context = await chromium.launchPersistentContext(dir, {
    headless: resolvedHeadless,
    // Playwright derives the initial window size from viewport when headed;
    // null lets --window-size (above) take effect without Playwright forcing
    // its own dimensions.
    viewport: resolvedHeadless ? viewport : null,
    userAgent,
    proxy,
    executablePath,
    args
  })

  // Restore the saved session cookie before any navigation happens in the
  // caller — see injectSavedCookies()'s doc comment for why this matters
  // specifically for a profile that arrived via Backup/Restore or Cloud
  // Sync from a different machine.
  await injectSavedCookies(context, account)

  // Anti-detect init script — runs before any page script on every document
  // (including iframes) in this context, patching the JS-visible automation
  // signals Facebook's bot-detection checks (navigator.webdriver, missing
  // window.chrome, plugin/language fingerprint, WebGL vendor, permissions
  // API, canvas/audio fingerprint noise, WebRTC IP leak). A macOS UA never
  // pairs with a Direct3D/ANGLE renderer string (that API doesn't exist on
  // macOS Chrome), so the GPU pool is chosen to match. profileSeed is the
  // account's UID so its canvas/audio noise is stable across sessions
  // (looks like one consistent device) but differs from every other account.
  const isMac = userAgent.includes('Macintosh')
  await context.addInitScript(
    buildStealthScript({
      languages: ['en-US', 'en'],
      profileSeed: account.uid ?? undefined,
      ...(isMac
        ? { gpuVendor: 'Google Inc. (Apple)', gpuRenderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)' }
        : {})
    })
  )

  // RAM & Media Optimizer — abort image/media/font requests when enabled in
  // General Settings, except while on a checkpoint page (a captcha image
  // must still render fully so it can be solved/read).
  if (settings.blockMedia) {
    await context.route('**/*', (route) => {
      const type = route.request().resourceType()
      const url = route.request().url()
      if (['image', 'media', 'font'].includes(type) && !url.includes('checkpoint')) {
        return route.abort()
      }
      return route.continue()
    })
  }

  return context
}

// ---------------------------------------------------------------------------
// Tracked-context registry — lets "Close Browsers" / Stop close every headed
// or in-flight context regardless of which module opened it.
// ---------------------------------------------------------------------------

const trackedContexts = new Map<string, BrowserContext>()

/** Register a context under a key (usually the account UID). */
export function trackContext(key: string, context: BrowserContext): void {
  trackedContexts.set(key, context)
  context.on('close', () => {
    if (trackedContexts.get(key) === context) trackedContexts.delete(key)
  })
}

export function untrackContext(key: string): void {
  trackedContexts.delete(key)
}

export function isTracked(key: string): boolean {
  return trackedContexts.has(key)
}

/**
 * Close a single tracked context by key (usually an account UID), if one is
 * open. Used before bundling a profile folder for Backup/Cloud Sync — a
 * live Chrome process holds locks on and buffers writes to files like
 * Cookies/Preferences/Network's SQLite databases, so zipping a profile
 * while it's still open can capture a torn/incomplete write or simply fail
 * to read a locked file, silently dropping session state from the bundle.
 * Closing first lets Chromium flush and release everything cleanly.
 */
export async function closeTrackedContext(key: string): Promise<boolean> {
  const ctx = trackedContexts.get(key)
  if (!ctx) return false
  trackedContexts.delete(key)
  await ctx.close().catch(() => void 0)
  return true
}

/** Close every tracked context (headed profiles + in-flight queue runs). */
export async function closeAllTrackedContexts(): Promise<number> {
  const contexts = [...trackedContexts.values()]
  trackedContexts.clear()
  let n = 0
  for (const ctx of contexts) {
    await ctx.close().catch(() => void 0)
    n += 1
  }
  return n
}

/** Alias for closeAllTrackedContexts — forceful "close every browser window now" entry point used by Stop. */
export const closeAll = closeAllTrackedContexts
