// ---------------------------------------------------------------------------
// browserContext.ts  — shared Playwright context launching for all automation
// modules (openProfile, checkLiveDie, autoLogin, queueRunner).
//   * per-UID persistent profiles under userData/profiles/{uid}
//   * proxy support (http / socks5, with auth)
//   * stealth launch args + randomized viewport/UA
//   * a registry of tracked contexts so "Close Browsers" / Stop can close them
// ---------------------------------------------------------------------------
import { app, screen } from 'electron'
import { join, resolve } from 'path'
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { chromium, type BrowserContext, type Cookie } from 'playwright'
import type { Account } from '../../types/account'
import { getAppSettings } from '../db/settingsRepo'
import { buildStealthScript } from './stealthEngine'

/**
 * Parses this app's saved cookie value into Playwright cookie objects
 * addCookies() accepts, targeting Facebook's cookie domain. Accepts either
 * shape a saved cookie may be in:
 *   - a JSON array of {name, value, ...} objects (e.g. exported from a
 *     browser extension), OR
 *   - the plain "name=value; name2=value2; ..." string this app has
 *     historically stored (see extractCookiesAndToken() in autoLogin.ts)
 * Every required Facebook-session attribute is enforced explicitly
 * regardless of what the source data did or didn't specify, so an
 * incomplete/loosely-typed import can't silently produce a cookie the
 * browser refuses to send back on the next request.
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
  const pairs: { name: string; value: string }[] = []

  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as Array<{ name?: unknown; value?: unknown }>
      for (const entry of parsed) {
        const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
        const value = typeof entry?.value === 'string' ? entry.value.trim() : ''
        if (name && value) pairs.push({ name, value })
      }
    } catch {
      /* not valid JSON despite the leading "[" — fall through to empty result */
    }
  } else {
    for (const part of trimmed.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      const name = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim()
      if (name && value) pairs.push({ name, value })
    }
  }

  // Facebook's real cookies are a mix of session and long-lived (xs/c_user/
  // datr survive well past a year) — expires: -1 marks this a session
  // cookie in Playwright's API, but since Facebook's own Set-Cookie
  // response on any subsequent request will re-issue proper expiries
  // anyway, matching that exactly here isn't worth the complexity of
  // parsing per-cookie attributes this app never stored in the first place.
  // domain/path/secure/sameSite are force-set on every cookie regardless of
  // source, rather than trusting whatever (if anything) a JSON import
  // supplied for them — a cookie missing `secure` or scoped to the wrong
  // domain/path is silently dropped by the browser instead of sent back.
  return pairs.map(({ name, value }) => ({
    name,
    value,
    domain: '.facebook.com',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: true,
    sameSite: 'Lax' as const
  }))
}

/** True if a parsed cookie set has both session-identifying cookies Facebook requires to consider a browser logged in. */
export function hasRequiredSessionCookies(cookies: Cookie[]): boolean {
  const names = new Set(cookies.map((c) => c.name))
  return names.has('c_user') && names.has('xs')
}

/**
 * Parses `raw` (JSON array or "name=value;" string) and reports whether it
 * contains the two cookies Facebook actually requires to treat a browser as
 * logged in (c_user, xs) — used by callers that must distinguish a real,
 * usable session from a saved value that only has incidental cookies like
 * _GRECAPTCHA or datr, which alone never produce a logged-in session no
 * matter how well-formed the string otherwise is.
 */
export function validateCookieString(raw: string): { cookies: Cookie[]; valid: boolean } {
  const cookies = parseCookieString(raw)
  return { cookies, valid: hasRequiredSessionCookies(cookies) }
}

/**
 * Injects the account's saved cookie string into a freshly-launched
 * context, before any navigation — restoring a cross-machine session that
 * Chromium's own DPAPI-encrypted profile storage cannot. Best-effort: a
 * malformed cookie string should never prevent the browser from opening.
 * Returns whether the injected set actually included both required
 * session cookies (c_user, xs) — callers that need to report a real
 * pass/fail (e.g. Login with Cookie) should check this rather than assume
 * success just because addCookies() didn't throw.
 */
async function injectSavedCookies(context: BrowserContext, account: Account): Promise<boolean> {
  const raw = account.cookie?.trim()
  if (!raw) return false
  try {
    const { cookies, valid } = validateCookieString(raw)
    if (cookies.length > 0) await context.addCookies(cookies)
    return valid
  } catch {
    /* malformed cookie string — proceed with whatever the on-disk profile already has */
    return false
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

/**
 * Root directory for downloaded avatar images, one .jpg per account UID.
 * Uses the configured "Avatar Download Directory" (General Settings) when
 * set, falling back to the default {userData}/avatars otherwise — same
 * pattern as profilesRoot()'s Custom Profile Directory override. Read fresh
 * each call (not cached) so a settings change takes effect immediately.
 *
 * resolve()d rather than used as-is: the settings field is a plain text
 * input, not Browse-only, so a user can type a relative path (e.g.
 * "Pictures/Profile", exactly the kind of value this was found broken
 * against). A relative path resolves against process.cwd(), which for a
 * packaged Electron app's main process is NOT guaranteed to be stable or
 * even the same directory across separate calls — the avatar-download path
 * and the avatar:// protocol-serve path could each independently resolve
 * the identical setting string to two different real directories, making
 * the avatar disappear from the UI (protocol handler 404s) despite having
 * downloaded successfully moments earlier. Anchoring every relative path to
 * userData (a fixed, known-stable directory) instead of leaving it to
 * whatever cwd() happens to be eliminates that.
 */
function avatarsRoot(): string {
  const configured = getAppSettings().avatarStoragePath?.trim()
  const root = configured
    ? resolve(app.getPath('userData'), configured)
    : join(app.getPath('userData'), 'avatars')
  mkdirSync(root, { recursive: true })
  return root
}

/** Exported for avatarService.ts (the direct-HTTP batch downloader) — same directory profileDir()-style helpers here already resolve avatars into. */
export function resolveAvatarsRoot(): string {
  return avatarsRoot()
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
 * Accepts every proxy string format actually seen in the wild across
 * providers (Webshare, static residential ISPs, generic SOCKS5 resellers),
 * not just the plain host:port / scheme://user:pass@host:port shapes the
 * old version handled — those two alone left out the equally common
 * "host:port:user:pass" (Webshare's own default export format) and any
 * "socks5://host:port:user:pass" variant, both of which used to get
 * mis-split or silently downgraded to http:// and fail to authenticate,
 * surfacing as Chromium's ERR_TUNNEL_CONNECTION_FAILED at launch:
 *   1. host:port:user:pass       (Webshare / static residential default)
 *   2. user:pass@host:port       (no scheme)
 *   3. http(s)://user:pass@host:port
 *   4. socks5://user:pass@host:port
 *   5. socks5://host:port:user:pass
 *   6. host:port                 (unauthenticated / IP-whitelisted)
 * Deliberately does NOT use `new URL()` — it throws on shapes 1 and 5
 * (a "port" of "8080:user:pass" isn't valid), which is what caused the old
 * scheme-prefixed branch to fall through to raw colon-splitting on a
 * string that still had its "socks5://" prefix attached, and then hardcode
 * `http://` regardless of the real scheme.
 */
export function parseProxy(
  raw: string | null | undefined
): { server: string; username?: string; password?: string } | undefined {
  if (!raw || typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  // Strip and remember an explicit scheme prefix — http, https, or socks5 —
  // defaulting to http when none is given, same as Chromium's own default
  // proxy scheme. Every later branch reuses `protocol`, so a socks5:// or
  // https:// prefix always survives into the final server string instead
  // of one branch (the old colon-split fallback) silently discarding it.
  let protocol = 'http'
  let rest = trimmed
  const schemeMatch = trimmed.match(/^(https?|socks5):\/\/(.*)$/i)
  if (schemeMatch) {
    protocol = schemeMatch[1].toLowerCase()
    rest = schemeMatch[2]
  }

  const buildServer = (host: string, port: string): string => `${protocol}://${host.trim()}:${port.trim()}`

  // Format: user:pass@host:port (with or without a scheme prefix already
  // stripped above) — split on the LAST '@' so a password that itself
  // contains '@' doesn't truncate the host/port half.
  const atIndex = rest.lastIndexOf('@')
  if (atIndex !== -1) {
    const authPart = rest.slice(0, atIndex)
    const hostPart = rest.slice(atIndex + 1)
    const colonIndex = authPart.indexOf(':')
    const username = colonIndex === -1 ? authPart : authPart.slice(0, colonIndex)
    const password = colonIndex === -1 ? '' : authPart.slice(colonIndex + 1)
    const [host, port] = hostPart.split(':')
    if (host && port) {
      return {
        server: buildServer(host, port),
        username: username ? decodeURIComponent(username.trim()) : undefined,
        password: password ? decodeURIComponent(password.trim()) : undefined
      }
    }
  }

  // Format: host:port:user:pass  |  host:port  (scheme already stripped,
  // if one was present — covers both plain and socks5://host:port:user:pass).
  const parts = rest.split(':')
  if (parts.length >= 4) {
    const [host, port, user, ...passParts] = parts
    // A password containing ':' (rare, but not impossible) would otherwise
    // be silently truncated at the first colon — rejoin anything past the
    // third colon back into the password instead of dropping it.
    const pass = passParts.join(':')
    if (host && port) {
      return { server: buildServer(host, port), username: user.trim(), password: pass.trim() }
    }
  } else if (parts.length === 2) {
    const [host, port] = parts
    if (host && port) return { server: buildServer(host, port) }
  }

  return undefined
}

/** Extracts the bare host (IP or hostname, no port/credentials) out of a raw proxy string, reusing parseProxy's already-robust format handling rather than a naive split. */
function extractProxyHost(rawProxy: string): string | undefined {
  const parsed = parseProxy(rawProxy)
  if (!parsed) return undefined
  // parsed.server is "protocol://host:port" — strip both ends.
  const withoutScheme = parsed.server.replace(/^[a-z0-9]+:\/\//i, '')
  const host = withoutScheme.split(':')[0]
  return host || undefined
}

export interface ProxyGeoData {
  timezone: string
  lat: number
  lon: number
  countryCode: string
}

// Keyed by proxy host — a rotating-gateway proxy string maps to the same
// cache entry across every launch using it, so this is a reasonable
// approximation (the lookup reflects the gateway's own IP, not necessarily
// whatever IP the gateway rotates to per-connection) rather than a perfect
// per-session geo match. Process-lifetime cache: cleared on app restart,
// which is fine since a proxy's geolocation is effectively static day-to-day.
const proxyGeoCache = new Map<string, ProxyGeoData | null>()

/**
 * Looks up a proxy host's approximate physical location via ip-api.com's
 * free endpoint (no API key required, generous rate limit for this app's
 * usage pattern) — timezone, coordinates, and country code. Used to make
 * the launched browser's reported timezone/geolocation/locale consistent
 * with the proxy's exit IP instead of the host machine's real location,
 * which is itself a fingerprinting/bot-detection signal (a New York
 * residential IP paired with a browser reporting Asia/Phnom_Penh as its
 * timezone is an obvious tell). Best-effort: returns null on any failure
 * (network error, malformed response, non-IP hostname ip-api.com can't
 * resolve) rather than throwing — a failed lookup just means the launched
 * context falls back to sensible hardcoded US defaults, never blocks
 * launching the browser itself.
 */
export async function getProxyGeoData(host: string): Promise<ProxyGeoData | null> {
  // Only a successful lookup is cached — a transient network failure or a
  // momentary ip-api.com hiccup shouldn't permanently disable geo-matching
  // for that proxy for the rest of the app's process lifetime; retrying on
  // the next launch is cheap and correct.
  const cached = proxyGeoCache.get(host)
  if (cached) return cached

  try {
    const response = await fetch(`http://ip-api.com/json/${encodeURIComponent(host)}?fields=status,countryCode,timezone,lat,lon`, {
      signal: AbortSignal.timeout(8000)
    })
    const data = (await response.json()) as {
      status?: string
      countryCode?: string
      timezone?: string
      lat?: number
      lon?: number
    }

    if (data.status === 'success') {
      const geo: ProxyGeoData = {
        timezone: data.timezone || 'America/New_York',
        lat: typeof data.lat === 'number' ? data.lat : 40.7128,
        lon: typeof data.lon === 'number' ? data.lon : -74.006,
        countryCode: data.countryCode || 'US'
      }
      proxyGeoCache.set(host, geo)
      return geo
    }
    return null
  } catch (err) {
    console.warn(`[ProxyGeo] Failed to fetch geo info for ${host}:`, err instanceof Error ? err.message : err)
    return null
  }
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
  /**
   * Clear the persistent profile's existing cookies/storage BEFORE
   * injecting the account's saved cookie — used only by Login with Cookie
   * (browserAutomation.ts). That flow's whole point is "use exactly this
   * saved cookie's session," but the profile dir can carry a DIFFERENT,
   * stale identity from an earlier run (Facebook's own account-chooser
   * cookie), which surfaces the "Continue as X / Use another profile"
   * interstitial for the WRONG account before the just-injected cookie's
   * session ever gets a chance to take effect. Clearing first means the
   * injected cookie is the only session Facebook can possibly offer.
   * Every other caller (openProfile, checkLiveDie, runAutoLogin) omits
   * this — those rely on the persistent profile's own real session
   * surviving across runs, which this would otherwise destroy.
   */
  resetProfileBeforeCookieInject?: boolean
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
  slotIndex,
  resetProfileBeforeCookieInject
}: LaunchOpts): Promise<BrowserContext> {
  const settings = getAppSettings()
  const viewport = pick(VIEWPORTS)
  // A user-assigned UA (via Import Useragent) wins; otherwise pick a random one.
  const userAgent = account.user_agent?.trim() || pick(USER_AGENTS)
  const proxy = parseProxy(account.proxy)
  const resolvedHeadless = headless ?? settings.browserMode === 'headless'

  // Match the launched context's reported timezone/geolocation/locale to
  // the assigned proxy's actual exit location — a proxy IP geolocating to
  // New York while the browser reports (say) Asia/Phnom_Penh as its
  // timezone is itself a strong bot-detection signal, independent of
  // anything else this app already does to look like a real device.
  // Best-effort: a failed/unavailable lookup (no proxy configured, network
  // error, non-resolvable host) falls back to sensible US defaults rather
  // than ever blocking the browser from launching.
  const proxyHost = account.proxy ? extractProxyHost(account.proxy) : undefined
  const proxyGeo = proxyHost ? await getProxyGeoData(proxyHost) : null
  const timezoneId = proxyGeo?.timezone ?? 'America/New_York'
  const geolocation = proxyGeo ? { latitude: proxyGeo.lat, longitude: proxyGeo.lon, accuracy: 100 } : undefined
  const permissions = proxyGeo ? ['geolocation'] : []
  const locale = !proxyGeo || proxyGeo.countryCode === 'US' ? 'en-US' : `en-${proxyGeo.countryCode}`
  const executablePath =
    settings.customChromiumPath.trim() && existsSync(settings.customChromiumPath.trim())
      ? settings.customChromiumPath.trim()
      : undefined

  const dir = profileDir(account.uid ?? 'unknown')
  disablePasswordManagerPrefs(dir)

  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--disable-save-password-bubble',
    '--disable-features=PasswordManager,PasswordManagerUI,OptimizationGuideModelDownloading',
    '--no-default-browser-check'
  ]

  // Hardware Running Mode (General Settings) — 'auto' adds nothing, letting
  // Chromium's own default hybrid GPU/software behavior apply.
  if (settings.hardwareMode === 'cpu') {
    args.push('--disable-gpu', '--disable-software-rasterizer')
  } else if (settings.hardwareMode === 'gpu') {
    args.push('--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-webgl')
  }

  // MaxCare-style compact tiling — only meaningful for headed windows; a
  // headless context has no on-screen window to position. Headless still
  // gets an explicit --window-size: Chromium's headless default viewport
  // is a smaller, distinctive size some bot-detection heuristics key off
  // of, so a normal-looking 1280x800 is worth setting even with nothing
  // to visually show.
  if (!resolvedHeadless) {
    const { x, y } = tilePosition(slotIndex ?? 0)
    args.push(`--window-size=${TILE_WIDTH},${TILE_HEIGHT}`, `--window-position=${x},${y}`)
  } else {
    args.push('--window-size=1280,800')
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
    args,
    // Playwright appends --enable-automation to Chromium's launch args by
    // default, which shows the "Chrome is being controlled by automated
    // test software" infobar and sets navigator.webdriver at the CDP level
    // — a signal some detection scripts check independently of the
    // --disable-blink-features=AutomationControlled flag above (which only
    // addresses the JS-visible blink feature, not this CLI flag or its
    // downstream effects). Suppressing it here removes that flag entirely
    // instead of leaving it to be patched over client-side.
    ignoreDefaultArgs: ['--enable-automation'],
    // Proxy-geolocation matching (see getProxyGeoData above) — timezoneId
    // and locale always get a value (US defaults when no proxy/lookup
    // succeeded); geolocation/permissions are only set when a real lookup
    // succeeded, since granting a 'geolocation' permission the browser then
    // has no coordinates to answer with would be worse than not
    // granting it at all.
    timezoneId,
    locale,
    ...(geolocation ? { geolocation, permissions } : {})
  })

  // Login with Cookie only — see resetProfileBeforeCookieInject's doc
  // comment on LaunchOpts. Must happen BEFORE injectSavedCookies() below,
  // not after: clearing afterward would wipe the very cookie just injected.
  if (resetProfileBeforeCookieInject) {
    await context.clearCookies().catch(() => void 0)
  }

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
      // Matches the context's own `locale` option above — a browser whose
      // reported navigator.languages disagrees with its Accept-Language
      // header (locale) and its geolocation/timezone is a mismatch a
      // fingerprinting script can flag just as easily as a wrong timezone.
      languages: [locale, locale.split('-')[0]],
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
