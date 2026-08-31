// ---------------------------------------------------------------------------
// autoLogin.ts  — full Facebook auto-login lifecycle:
//   session check → credential fill → 2FA (TOTP) / email-OTP / checkpoint /
//   wrong-password detection → cookie + status persistence.
//
// Designed to run standalone (single account, headed) or from queueRunner.ts
// (headless, concurrent, abortable).
// ---------------------------------------------------------------------------
import type { BrowserContext, Page } from 'playwright'
import type { Account, ManagedPage } from '../../types/account'
import { launchContext, trackContext, untrackContext, hasRequiredSessionCookies } from './browserContext'
import { fetchFacebookOtp } from './imapWorker'
import { generateTOTP } from './totp'
import { getAppSettings } from '../db/settingsRepo'

export type LoginStatus = 'Live' | 'Checkpoint' | 'Die' | 'Session Expired' | 'Changed Pass' | 'Unknown'

export interface AutoLoginResult {
  success: boolean
  status: LoginStatus
  detail: string
  cookie?: string
  token?: string
  /** Profile display name scraped from the nav bar once Live. */
  name?: string
  /** Profile picture URL scraped from the nav bar once Live (best-effort). */
  avatar?: string
  /** Friends count scraped from the profile page once Live (best-effort). */
  friendsCount?: number
  /** Joined groups count scraped from /groups/joins once Live (best-effort). */
  groupsCount?: number
  /** Primary location (city / country) scraped from profile Intro/About (best-effort). */
  location?: string
  /** Account creation / joined date scraped from transparency info (best-effort). */
  createdDate?: string
  // Full-mode-only enrichment (see ScrapedProfileData).
  uid?: string
  dtsgToken?: string
  followers?: string
  following?: string
  currentLocation?: string
  pagesCount?: number
  friendsList?: string[]
  /** Set when 2FA resolution failed/timed out — persisted to accounts.notes. */
  notes?: string
}

/** Fired at each meaningful step so the UI can show live progress. */
export type ProgressStage =
  | 'Queued'
  | 'Opening Chrome...'
  | 'Checking session...'
  | 'Logging in...'
  | 'Entering 2FA...'
  | 'Fetching Mail OTP...'
  | 'Verifying...'
  | 'Warm-up' // scenario running post-login; free-text label goes in `detail`
  | 'Live'
  | 'Checkpoint'
  | 'Die'
  | 'Session Expired'
  | 'Changed Pass'
  | 'Unknown'
  | 'Cancelled'
  | 'Error'

export type ProgressFn = (stage: ProgressStage, detail?: string) => void

export interface AutoLoginOptions {
  headless?: boolean
  /** Worker/thread slot (0, 1, 2...) for MaxCare-style window tiling when headed. */
  slotIndex?: number
  /** Abort the whole flow at the next safe checkpoint (cooperative). */
  signal?: AbortSignal
  /** Called on every stage transition (for queue/UI progress). */
  onProgress?: ProgressFn
  /** Prefer the lightweight mbasic UI (smaller footprint, simpler DOM). */
  useMbasic?: boolean
  /**
   * Called once the account is confirmed Live, before the context is closed
   * (or returned to the caller) — lets the queue runner chain warm-up
   * scenario steps into the same authenticated session. Errors thrown here
   * are caught and reported as a login-flow error.
   */
  onLoggedIn?: (page: Page) => Promise<void>
}

const FACEBOOK_URLS = {
  // web.facebook.com is Facebook's own canonical redirect target for the
  // modern desktop UI (www.facebook.com/login 302s here anyway) — going
  // there directly avoids one redirect hop and matches the DOM this module's
  // selectors were captured against.
  full: 'https://web.facebook.com/',
  mobile: 'https://m.facebook.com/login',
  mbasic: 'https://mbasic.facebook.com/login'
}

// ---------------------------------------------------------------------------
// Polymorphic selectors — Facebook's login DOM varies by locale/region/A-B
// test, so every interactive target is tried as an ordered list of fallbacks
// rather than a single hardcoded selector.
// ---------------------------------------------------------------------------

/** Cookie-consent / language / bottom-sheet dismiss buttons, most specific first. */
const CONSENT_SELECTORS = [
  'button[data-cookiebanner="accept_button"]',
  '[aria-label="Decline optional cookies"]',
  'button:has-text("Allow")',
  'button:has-text("Allow all cookies")',
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("Chấp nhận tất cả")',
  'button:has-text("Only essential")',
  'button:has-text("Only allow essential cookies")'
]

// Semantic/attribute selectors are tried first — they're stable across page
// loads. React's auto-generated `useId()` ids (e.g. "_r_2_") are NOT stable:
// the same value depends on how many other useId() calls happened earlier in
// that render pass, so it can (and does) differ between page loads, A/B
// buckets, and locales. They're kept only as an absolute last resort, after
// every semantic selector has already failed, on the off chance a given
// build happens to reuse the same id.
const EMAIL_SELECTORS = [
  'input#email',
  'input[name="email"]',
  'input[name="login"]',
  'input[type="text"][autocomplete="username"]',
  'input[data-testid="royal_email"]',
  'input[type="text"]:visible',
  'xpath=//*[@id="_r_2_"]'
]

const PASSWORD_SELECTORS = [
  'input#pass',
  'input[name="pass"]',
  'input[type="password"]',
  'input[data-testid="royal_pass"]',
  'xpath=//*[@id="_r_5_"]'
]

const LOGIN_BUTTON_SELECTORS = [
  'button[name="login"]',
  'button[type="submit"]',
  'button:has-text("Log In")',
  'button:has-text("Đăng nhập")',
  '#loginbutton',
  'xpath=//*[@id="login_form"]//span[1]/span[1]'
]

// ---------------------------------------------------------------------------
// 2FA state-machine selectors (see resolve2FA() below). Facebook renders the
// "choose a method" step as a dialog overlay, so several of these are scoped
// to `div[role="dialog"]` to avoid matching identical text elsewhere on the
// (still-visible-behind-the-dialog) page.
// ---------------------------------------------------------------------------

// STRICT code-input selectors — these must ONLY ever match a genuine 2FA/
// approvals-code box, NEVER the login form. A previous catch-all
// `input[type="text"]` matched `input#email` on the login page and typed the
// TOTP into the "Email or mobile number" field.
//
// The modern React 2FA screen renders the code box as a *bare*
// `<input type="text">` with no name/placeholder/aria-label — so a strict
// attribute selector can't find it. We resolve that safely in
// findCodeInput() below by only allowing the bare text input once we've
// confirmed (a) the login form is absent and (b) we're on the 2FA URL, and
// by excluding the email/pass fields explicitly.
const CODE_INPUT_SELECTORS = [
  'input[name="approvals_code"]',
  'input#approvals_code',
  'input[autocomplete="one-time-code"]',
  'input[type="tel"]',
  'input[placeholder*="Code" i]',
  'input[aria-label*="Code" i]',
  'input[inputmode="numeric"][maxlength="6"]',
  'input[inputmode="numeric"][maxlength="8"]',
  // Last-resort: React useId() ids observed on some builds. Not stable across
  // loads — kept only as a final fallback after every semantic match fails.
  'xpath=//*[@id="_r_3_"]',
  'xpath=//*[@id="_r_a_"]'
]

/**
 * A text input that is definitively NOT a login field — used as a
 * last-resort match for the bare `<input type="text">` 2FA code box. Only
 * ever applied after isLoginPage() has returned false and we're on the 2FA
 * URL, so it can never touch the email/password fields.
 */
const BARE_TEXT_INPUT_SELECTOR =
  'input[type="text"]:not([name="email"]):not([name="pass"]):not([autocomplete="username"]):not([autocomplete~="username"])'

/**
 * Find the 2FA code input, tolerant of the modern React screen where the box
 * is a bare `<input type="text">`. Strict selectors first; the bare fallback
 * is only allowed once we've confirmed we're NOT on the login page.
 */
async function findCodeInput(
  page: Page,
  timeoutMs = 4000
): Promise<ReturnType<Page['locator']> | null> {
  // CODE_INPUT_SELECTORS has 10 entries — findFirstVisible's per-selector
  // timeout would let this burn up to 10x `timeoutMs` in the worst case
  // (none match) or a large multiple of it (a late-list selector matches
  // only after every earlier one times out first). Bounded to `timeoutMs`
  // TOTAL instead, since this runs inside the 2FA state machine's fixed 45s
  // budget — the same multiplicative-timeout bug confirmed live in
  // actWaitingApproval's TRY_ANOTHER_WAY_SELECTORS probe.
  const strict = await findFirstVisibleBounded(page, CODE_INPUT_SELECTORS, timeoutMs)
  if (strict) return strict
  // Only fall back to the bare text input when the login form is gone — this
  // is the exact guard that prevents typing the code into #email.
  if (await isLoginPage(page)) return null
  const bare = page.locator(BARE_TEXT_INPUT_SELECTOR).first()
  const visible = await bare
    .waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true)
    .catch(() => false)
  return visible ? bare : null
}

/**
 * Selectors that mean "this is the LOGIN page, not a 2FA page." If any is
 * present/visible we must never run 2FA logic — the classic failure was
 * typing a TOTP into `input#email`.
 */
const LOGIN_FORM_SELECTORS = ['input#email', 'input#pass', 'input[name="email"]', 'input[name="pass"]']

const CODE_SUBMIT_SELECTORS = [
  'button[type="submit"]',
  '#checkpointSubmitButton',
  'button[name="submit[Continue]"]',
  'button:has-text("Continue")',
  '[role="button"]:has-text("Continue")',
  'button:has-text("Submit")',
  'button:has-text("Tiếp tục")',
  'xpath=//*[contains(@id, "mount_0_0_")]//div[3]//span[1]/span[1]'
]

/** "Try another way" link/button shown on the "waiting for approval" screen. */
const TRY_ANOTHER_WAY_SELECTORS = [
  'button:has-text("Try another way")',
  '[role="button"]:has-text("Try another way")',
  'button:has-text("Thử cách khác")',
  '[role="button"]:has-text("Thử cách khác")',
  'text=/Try another way/i',
  'xpath=//*[contains(@id, "mount_0_0_")]//div[4]//span[1]/span[1]'
]

/** The "Choose a way to confirm it's you" modal shown by State 1. */
const METHOD_DIALOG_SELECTOR = 'div[role="dialog"]'

/** The "Authentication app" option inside the method-chooser dialog. */
const AUTH_APP_OPTION_SELECTORS = [
  `${METHOD_DIALOG_SELECTOR} div:has-text("Authentication app")`,
  `${METHOD_DIALOG_SELECTOR} label:has-text("Authentication app")`,
  `${METHOD_DIALOG_SELECTOR} div:has-text("App xác thực")`,
  `${METHOD_DIALOG_SELECTOR} label:has-text("App xác thực")`,
  `${METHOD_DIALOG_SELECTOR} input[type="radio"]:nth-of-type(1)`,
  'xpath=//*[contains(@id, "mount_0_0_")]//label[2]//input[1]'
]

/** The [Continue] button inside the method-chooser dialog specifically. */
const DIALOG_CONTINUE_SELECTORS = [
  `${METHOD_DIALOG_SELECTOR} button:has-text("Continue")`,
  `${METHOD_DIALOG_SELECTOR} [role="button"]:has-text("Continue")`,
  `${METHOD_DIALOG_SELECTOR} button:has-text("Tiếp tục")`,
  'xpath=//*[contains(@id, "mount_0_0_")]//div[role="dialog"]//button[contains(., "Continue")]'
]

/** "Save browser?" prompt shown after a successful 2FA — prefer "Don't save" to avoid trusting this device. */
const DONT_SAVE_BROWSER_SELECTORS = [
  'label:has-text("Don\'t save")',
  'label:has-text("Don\'t Save")',
  'button:has-text("Don\'t Save")',
  'button:has-text("Don\'t save")',
  '[role="button"]:has-text("Don\'t Save")',
  'label:has-text("Không lưu")',
  'button:has-text("Không lưu")'
]
const SAVE_BROWSER_SELECTORS = [
  'label:has-text("Save")',
  'button:has-text("Save Browser")',
  'button:has-text("Save browser")',
  '[role="button"]:has-text("Save Browser")',
  'label:has-text("Lưu")',
  'button:has-text("Lưu trình duyệt")'
]
const SAVE_BROWSER_SUBMIT_SELECTORS = [
  'button:has-text("Continue")',
  '[role="button"]:has-text("Continue")',
  'button:has-text("Submit")',
  '[role="button"]:has-text("Submit")',
  'button:has-text("Tiếp tục")'
]

/**
 * Newer standalone variant of the same prompt: "You're logged in. Trust this
 * device?" with two direct action buttons (no checkbox + separate submit) —
 * "Trust this device" and "Always confirm it's me". Tried before the
 * checkbox-style DONT_SAVE_BROWSER_SELECTORS/SAVE_BROWSER_SELECTORS pair
 * since this screen has no separate submit step; clicking either button
 * itself dismisses the interstitial and continues the flow.
 */
const TRUST_DEVICE_SELECTORS = [
  'button:has-text("Trust this device")',
  '[role="button"]:has-text("Trust this device")',
  'div[aria-label="Trust this device"]',
  'xpath=//div[@role="button" or self::button][.//text()[contains(., "Trust this device")]]'
]

/** Fallback buttons on the same screen if "Trust this device" itself can't be found/clicked. */
const TRUST_DEVICE_FALLBACK_SELECTORS = [
  'button:has-text("Always confirm it\'s me")',
  '[role="button"]:has-text("Always confirm it\'s me")',
  'button:has-text("Continue")',
  '[role="button"]:has-text("Continue")'
]

/**
 * A "Save your login info?" / "Remember Password" prompt can appear right
 * after the trust-device screen resolves. Dismissed (not saved) — the app
 * already persists credentials in its own DB, so trusting Chrome's own save-
 * password manager on top of that just adds another place secrets live.
 */
const REMEMBER_PASSWORD_DISMISS_SELECTORS = [
  'button:has-text("Not Now")',
  '[role="button"]:has-text("Not Now")',
  'button:has-text("Not now")',
  'button:has-text("OK")',
  '[role="button"]:has-text("OK")',
  '[aria-label="Close"]'
]

/** Shared cancellation signal — also used by scenarios.ts so a scenario-step
 *  abort is recognized as a clean cancellation, not a login error. */
export class AbortedError extends Error {
  constructor() {
    super('Aborted by user')
    this.name = 'AbortedError'
  }
}

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError()
}

/**
 * Race a Playwright call against the abort signal so a long internal wait
 * (e.g. a locator timeout) can't block cancellation — Stop takes effect
 * immediately instead of waiting out the operation's own timeout.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortedError())
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * Lowercased VISIBLE text of the page — never raw HTML. `page.content()`
 * returns the full serialized document including <script> tags and
 * Facebook's hydration JSON, which routinely embeds strings for components
 * that are pre-loaded but not yet rendered (e.g. the "Trust this device"
 * checkbox's translation string ships in the page bundle well before that
 * screen ever appears). Matching against that raw HTML causes false
 * positives — a heading/prompt "found" via .includes() when it isn't
 * actually on screen. innerText() reflects only what's actually rendered.
 */
async function visibleText(page: Page): Promise<string> {
  return (await page.locator('body').innerText().catch(() => '')).toLowerCase()
}

/**
 * Try each selector in order and return the locator for the first one that
 * is actually visible on the page (not just present in the DOM — Facebook
 * often renders multiple hidden variants). Returns null if none match within
 * the short per-selector probe timeout.
 */
async function findFirstVisible(
  page: Page,
  selectors: string[],
  probeTimeoutMs = 2500
): Promise<ReturnType<Page['locator']> | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first()
    const visible = await loc
      .waitFor({ state: 'visible', timeout: probeTimeoutMs })
      .then(() => true)
      .catch(() => false)
    if (visible) return loc
  }
  return null
}

/**
 * Same probing logic as findFirstVisible, but `probeTimeoutMs` is a TOTAL
 * budget split evenly across every selector in the list, not a per-selector
 * timeout — for callers running inside a fixed overall time budget (the 2FA
 * state machine's 45s), where a naive per-selector wait multiplies badly
 * with list length. Confirmed live: TRY_ANOTHER_WAY_SELECTORS has 6 entries;
 * at the old per-item 4000ms default, a single actWaitingApproval() call on
 * an account variant with no "Try another way" button burned 24s, and two
 * such calls (48s) already exceeded the entire 45s budget before the state
 * machine's own elapsed-time check ever got a chance to run — the browser
 * stayed open for minutes instead of failing cleanly. This keeps the worst
 * case for one call bounded to `probeTimeoutMs` regardless of list length.
 */
async function findFirstVisibleBounded(
  page: Page,
  selectors: string[],
  totalTimeoutMs: number
): Promise<ReturnType<Page['locator']> | null> {
  const perSelectorMs = Math.max(300, Math.floor(totalTimeoutMs / Math.max(1, selectors.length)))
  for (const sel of selectors) {
    const loc = page.locator(sel).first()
    const visible = await loc
      .waitFor({ state: 'visible', timeout: perSelectorMs })
      .then(() => true)
      .catch(() => false)
    if (visible) return loc
  }
  return null
}

/** Same probing logic as findFirstVisible, but over pre-built locators (e.g. getByText) instead of selector strings. */
async function findFirstVisibleLocator(
  locators: ReturnType<Page['locator']>[],
  probeTimeoutMs = 2500
): Promise<ReturnType<Page['locator']> | null> {
  for (const loc of locators) {
    const visible = await loc
      .waitFor({ state: 'visible', timeout: probeTimeoutMs })
      .then(() => true)
      .catch(() => false)
    if (visible) return loc
  }
  return null
}

/**
 * Detect and dismiss cookie-consent / language / bottom-sheet overlays that
 * would otherwise block the login form. Best-effort — never throws.
 */
async function dismissConsentOverlays(page: Page, signal?: AbortSignal): Promise<void> {
  for (const sel of CONSENT_SELECTORS) {
    checkAborted(signal)
    const btn = page.locator(sel).first()
    const visible = await btn
      .waitFor({ state: 'visible', timeout: 1200 })
      .then(() => true)
      .catch(() => false)
    if (!visible) continue
    await raceAbort(btn.click({ timeout: 3000 }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(1000), signal)
    return // one dialog is normally enough; re-checked by the caller if needed
  }
}

/**
 * Facebook's "Account Chooser" / one-click-login interstitial — a saved
 * browser profile (from a previous session on this machine/persistent
 * profile dir) shows an avatar + name with "Continue" / "Use another
 * profile" / "Create new account" instead of the normal email/password
 * form. Left unhandled, this either gets misread as an already-logged-in
 * session (it isn't — "Continue" hasn't been clicked) or the automation
 * simply can't find #email/#pass and reports a false "page layout
 * changed" error, since neither field is present on this screen at all.
 */
const USE_ANOTHER_PROFILE_SELECTORS = [
  'div[role="button"]:has-text("Use another profile")',
  'button:has-text("Use another profile")',
  '[aria-label="Use another profile"]'
]

export async function isAccountSwitcherScreen(page: Page): Promise<boolean> {
  for (const sel of USE_ANOTHER_PROFILE_SELECTORS) {
    const visible = await page
      .locator(sel)
      .first()
      .isVisible()
      .catch(() => false)
    if (visible) return true
  }
  return false
}

/**
 * Resolve the account-switcher screen so the standard email/password form
 * actually appears, in two stages:
 *   1. Click "Use another profile" — Facebook's own way of returning to a
 *      normal fresh-login form without disturbing anything else.
 *   2. If the standard fields still aren't visible afterward (a layout
 *      variant, or the click didn't register), fall back to a harder reset:
 *      clear the context's cookies and the page's local/session storage,
 *      then navigate directly to the login page.
 * Best-effort throughout — never throws; the caller's own
 * "email field not found" handling is the final safety net either way.
 */
export async function resolveAccountSwitcherScreen(
  page: Page,
  context: BrowserContext,
  signal?: AbortSignal
): Promise<void> {
  for (const sel of USE_ANOTHER_PROFILE_SELECTORS) {
    const btn = page.locator(sel).first()
    const visible = await btn.isVisible().catch(() => false)
    if (!visible) continue
    await raceAbort(btn.click({ timeout: 5000 }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(1500), signal)
    break
  }

  const fieldsVisible = await findFirstVisible(page, LOGIN_FORM_SELECTORS, 3000)
  if (fieldsVisible) return

  // Harder reset: "Use another profile" either wasn't found or didn't
  // actually produce the standard form — clear everything Facebook could
  // be using to remember this browser profile's identity, then load the
  // login page directly rather than the redirect-prone root URL.
  await context.clearCookies().catch(() => void 0)
  await page
    .evaluate(() => {
      try {
        localStorage.clear()
        sessionStorage.clear()
      } catch {
        /* ignore — some pages restrict storage access */
      }
    })
    .catch(() => void 0)
  await raceAbort(
    page.goto('https://www.facebook.com/login.php', { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => void 0),
    signal
  )
}

/** Click with a small randomized offset inside the target's bounding box — mimics natural mouse imprecision. */
async function clickWithJitter(
  page: Page,
  locator: ReturnType<Page['locator']>,
  signal?: AbortSignal
): Promise<void> {
  const box = await locator.boundingBox().catch(() => null)
  if (box) {
    const x = box.x + box.width * (0.3 + Math.random() * 0.4)
    const y = box.y + box.height * (0.3 + Math.random() * 0.4)
    await raceAbort(
      page.mouse.move(x, y, { steps: 2 + Math.floor(Math.random() * 3) }),
      signal
    )
    await raceAbort(page.mouse.click(x, y), signal)
  } else {
    await raceAbort(locator.click({ timeout: 10000 }).catch(() => void 0), signal)
  }
}

/**
 * Human-like typing on an already-resolved locator: focus (with jitter
 * click), clear any pre-existing/autofilled value, then type at 40–120ms/char.
 */
async function typeHumanOn(
  page: Page,
  locator: ReturnType<Page['locator']>,
  text: string,
  signal?: AbortSignal
): Promise<void> {
  await clickWithJitter(page, locator, signal)
  await raceAbort(locator.fill('').catch(() => void 0), signal)
  for (const ch of text) {
    checkAborted(signal)
    await raceAbort(locator.type(ch, { delay: 40 + Math.random() * 80 }), signal)
  }
}

/** Wrong-password error text, exactly as shown under the password field. */
const WRONG_PASSWORD_PATTERNS = [
  'the password you entered is incorrect',
  "the password that you've entered is incorrect",
  'mật khẩu bạn đã nhập không chính xác',
  'mật khẩu không chính xác',
  'wrong credentials',
  'incorrect password'
]

/**
 * Genuine account-lock/suspension text — distinct from a mere "checkpoint"
 * step in a normal flow. Deliberately broad: Facebook varies this copy
 * (interpolating the account's own name, "N days left to appeal", etc.), so
 * this list exists purely as a secondary confirmation signal, NOT the sole
 * gate — see the /checkpoint/ URL check below, which is unconditional and
 * doesn't depend on matching any of these exactly.
 */
const ACCOUNT_LOCKED_PATTERNS = [
  'your account has been locked',
  'we suspended your account',
  "we've suspended",
  'suspended your account',
  'suspended for violating',
  'account has been disabled',
  'your account has been disabled',
  'days left to appeal',
  'day left to appeal',
  'appeal this decision',
  'your account is disabled',
  'you can no longer request a review',
  "couldn't create multiple sessions",
  'could not create multiple sessions',
  'we removed some content or messages',
  'we removed some posts',
  'account status'
]

/**
 * Checkpoint 282 specifically — Facebook's identity/liveness verification
 * gate ("Confirm you're human to use your account", usually paired with a
 * photo-upload or captcha step). This app never attempts to resolve it
 * automatically; a normal login run only needs to recognize and report it.
 */
const CHECKPOINT_282_PATTERNS = ["confirm you're human to use your account", 'confirm you are human']

function is282LockText(body: string): boolean {
  return CHECKPOINT_282_PATTERNS.some((p) => body.includes(p))
}

/**
 * Classify the current page: already-live session, checkpoint/lock, disabled,
 * wrong password, or still-on-login-page.
 *
 * Ordering matters: wrong-password is checked first so a bad-credentials
 * response (which Facebook sometimes serves from a URL containing
 * "checkpoint") is never misreported as a real account Checkpoint.
 */
export async function classifyPage(page: Page): Promise<{ status: LoginStatus; detail: string }> {
  const url = page.url()
  const body = (await visibleText(page)) || ''
  const lowerBody = body.toLowerCase()

  // ---- Case D: wrong password ----
  if (WRONG_PASSWORD_PATTERNS.some((p) => lowerBody.includes(p.toLowerCase()))) {
    return { status: 'Changed Pass', detail: 'Wrong Password' }
  }

  // ---- Case C: locked / disabled / suspended / review restricted ----
  if (
    ACCOUNT_LOCKED_PATTERNS.some((p) => lowerBody.includes(p.toLowerCase())) ||
    url.includes('/disabled') ||
    url.includes('/restriction') ||
    lowerBody.includes('you can no longer request a review') ||
    lowerBody.includes("couldn't create multiple sessions")
  ) {
    return { status: 'Die', detail: 'Account Disabled / Suspended' }
  }

  // ---- Real checkpoint: the /checkpoint/ URL PATH ITSELF is the unconditional signal ----
  if (url.includes('/checkpoint/')) {
    if (is282LockText(body)) {
      return { status: 'Checkpoint', detail: 'Checkpoint 282' }
    }
    const lockCodeMatch = body.match(/\b(956|282)\b/)
    const lockedText = ACCOUNT_LOCKED_PATTERNS.some((p) => lowerBody.includes(p.toLowerCase()))
    return {
      status: 'Checkpoint',
      detail: lockCodeMatch
        ? `Checkpoint ${lockCodeMatch[1]}`
        : lockedText
          ? 'Checkpoint (locked)'
          : 'Checkpoint'
    }
  }

  // ---- Trust-device interstitial ----
  if (await isTrustDeviceScreen(page)) {
    return { status: 'Unknown', detail: 'Trust this device prompt not yet resolved' }
  }

  // ---- Logged Out / Profile Chooser ("Continue as...") / Session Expired / Login Page ----
  const hasLoginForm = await page
    .locator('input#email, input#pass, input[name="email"], input[name="pass"], button[name="login"], #loginbutton, input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false)

  const isLoggedOut =
    url.includes('facebook.com/login') ||
    url.endsWith('/login') ||
    url.includes('/recover') ||
    url.includes('/login.php') ||
    url.includes('/login/reauth.php') ||
    lowerBody.includes('log in to facebook') ||
    lowerBody.includes('log into facebook') ||
    lowerBody.includes('session expired') ||
    lowerBody.includes('please log in again') ||
    lowerBody.includes('recent logins') ||
    lowerBody.includes('choose an account') ||
    lowerBody.includes('continue as') ||
    lowerBody.includes('log in as') ||
    lowerBody.includes('log into another account') ||
    lowerBody.includes('not you?') ||
    (lowerBody.includes('continue') && (lowerBody.includes('password') || lowerBody.includes('profile') || lowerBody.includes('account'))) ||
    hasLoginForm ||
    (await isLoginPage(page))

  if (isLoggedOut) {
    return { status: 'Session Expired', detail: 'Cookie Expired / Logged Out' }
  }

  // ---- Check for genuine LIVE navigation / feed / profile elements ----
  const hasLiveNav = await page
    .locator(
      'div[role="navigation"], div[aria-label="Your profile"], svg[aria-label="Your profile"], a[href*="/me"], a[href*="/profile.php"], div[role="feed"], div[role="main"], div[aria-label="Account controls and settings"], div[aria-label="Facebook"]'
    )
    .first()
    .isVisible()
    .catch(() => false)

  if (hasLiveNav) {
    return { status: 'Live', detail: 'Session active' }
  }

  // Page still loading or empty React container
  return { status: 'Unknown', detail: 'Page still loading...' }
}

/**
 * True if the page is still the LOGIN page — the email/password form is
 * present, or the URL is the login page itself. When true, 2FA logic must be
 * completely skipped (see strict isolation in requirement 1).
 */
async function isLoginPage(page: Page): Promise<boolean> {
  const url = page.url()
  if (url.includes('facebook.com/login') || url.endsWith('/login') || url.includes('/login/')) {
    return true
  }
  for (const sel of LOGIN_FORM_SELECTORS) {
    const present = await page
      .locator(sel)
      .first()
      .isVisible()
      .catch(() => false)
    if (present) return true
  }
  return false
}

// Comma-joining a list of selectors into one Playwright locator only works
// for the CSS engine — an `xpath=...` entry spliced into that join breaks it.
// Selector lists that mix CSS and XPath fallbacks must be queried per-entry
// (see countAnyMatch) rather than joined.
async function countAnyMatch(page: Page, selectors: string[]): Promise<number> {
  let total = 0
  for (const sel of selectors) {
    total += await page
      .locator(sel)
      .count()
      .catch(() => 0)
  }
  return total
}

/** True if the page shows a 2FA / approvals-code input (STRICT — never the login form). */
async function has2FAField(page: Page): Promise<boolean> {
  // Guard: if the login form is on screen, any "code-like" match would be a
  // false positive on an email/username box — bail out.
  if (await isLoginPage(page)) return false
  const strictCount = await countAnyMatch(page, CODE_INPUT_SELECTORS)
  if (strictCount > 0) return true
  // Fallback: the modern bare-text-input code box, but only on the 2FA URL so
  // an unrelated text field elsewhere can't be mistaken for a code box.
  if (!page.url().includes('/two_step_verification/')) return false
  return page
    .locator(BARE_TEXT_INPUT_SELECTOR)
    .count()
    .then((c) => c > 0)
    .catch(() => false)
}

/** True if the page is showing the "waiting for approval on another device" screen. */
async function isWaitingForApprovalScreen(page: Page): Promise<boolean> {
  const body = await visibleText(page)
  return (
    body.includes('check your notifications on another device') ||
    body.includes('waiting for approval')
  )
}

/**
 * True if the page is a genuine 2FA / two-step-verification screen.
 *
 * Strict per requirement 1: 2FA is triggered ONLY when the URL is the
 * two-step / checkpoint flow AND a recognized 2FA heading is present — AND we
 * are not still on the login form. A bare "authentication app" substring on
 * the login page (e.g. a marketing footer) must never trigger 2FA.
 */
async function is2FAScreen(page: Page): Promise<boolean> {
  if (await isLoginPage(page)) return false

  // The /two_step_verification/ path is exclusively Facebook's 2FA flow — no
  // other content is ever served there. Trusting the URL alone (rather than
  // requiring a heading/field match too) matters because page.url() updates
  // before page.content() reflects the new document during navigation: a
  // poll tick landing in that gap would see the new URL but the PREVIOUS
  // page's stale DOM, so a heading/field check could transiently miss a real
  // 2FA screen and fall through to a false "live" classification.
  if (page.url().includes('/two_step_verification/')) return true

  const url = page.url()
  if (!url.includes('/checkpoint/')) return false

  const body = await visibleText(page)
  const hasHeading =
    body.includes('go to your authentication app') ||
    body.includes('check your notifications on another device') ||
    body.includes('enter the 6-digit code') ||
    body.includes("choose a way to confirm it's you") ||
    body.includes('enter the code')
  return hasHeading || (await has2FAField(page))
}

// ---------------------------------------------------------------------------
// 2FA resolution state machine (resolve2FAStateMachine)
//
// Facebook's 2FA flow bounces between a handful of screens depending on the
// account's configured methods and A/B bucket, and importantly the SAME
// screen can reappear mid-flow (e.g. the method-chooser dialog after
// "Try another way"). A one-shot if/else chain can't express "keep re-
// evaluating the DOM and react to whatever is currently showing," so this is
// modeled as an explicit state machine: each iteration inspects the live DOM,
// classifies it into exactly one of five named states, performs that state's
// action, and loops — until a terminal state (Live / fatal) is reached or the
// overall time budget (45s, polled every 800ms) runs out.
// ---------------------------------------------------------------------------

type TwoFAState =
  | 'method-dialog' // State 1: "Choose a way to confirm it's you"
  | 'code-input' // State 2: "Go to your authentication app" / code screen
  | 'waiting-approval' // State 3: "Check your notifications on another device"
  | 'save-browser' // State 4: "Save browser?" / "Remember browser"
  | 'resolved' // State 5: navigated away from the 2FA flow entirely
  | 'unknown' // DOM doesn't match any known state (treated as "still loading")

/** True if a "Choose a way to confirm it's you" dialog is currently open. */
async function isMethodDialogOpen(page: Page): Promise<boolean> {
  const dialog = page.locator(METHOD_DIALOG_SELECTOR).first()
  const visible = await dialog
    .waitFor({ state: 'visible', timeout: 500 })
    .then(() => true)
    .catch(() => false)
  if (!visible) return false
  const text = (await dialog.innerText().catch(() => '')).toLowerCase()
  return (
    text.includes("choose a way to confirm it's you") ||
    text.includes('available confirmation methods') ||
    text.includes('authentication app')
  )
}

/**
 * True if the "Save browser?" / "Remember browser" prompt is showing.
 * MUST check visible text, not page.content(): Facebook's hydration payload
 * ships the "Trust this device and skip this step from now on" checkbox
 * label (and similar strings) inside a <script> JSON blob well before that
 * screen is ever rendered, so a raw-HTML .includes() check matches on every
 * 2FA screen from the very first one and hijacks classify2FAState into this
 * branch permanently.
 */
async function isSaveBrowserPrompt(page: Page): Promise<boolean> {
  const body = await visibleText(page)
  return (
    body.includes('save browser') ||
    body.includes('trust this device') ||
    body.includes('remember browser')
  )
}

/** Classify the current DOM into exactly one 2FA state for this iteration of the loop. */
async function classify2FAState(page: Page): Promise<TwoFAState> {
  // Hard guard: if we're back on the login form, the 2FA flow is over (either
  // it errored back to login or never really started). Treat as resolved so
  // the loop stops and the caller re-classifies the page — crucially this
  // prevents any code-typing action from firing against the login form.
  if (await isLoginPage(page)) return 'resolved'

  // Order matters: a dialog can float on top of a page that would otherwise
  // match code-input/waiting-approval, so it's checked first. The save-
  // browser prompt is checked before "resolved" since it can appear on a URL
  // that's already left /two_step_verification/.
  if (await isMethodDialogOpen(page)) return 'method-dialog'

  const url = page.url()
  const body = await visibleText(page)
  const onTwoStepUrl = url.includes('/two_step_verification/')

  if (await isSaveBrowserPrompt(page)) return 'save-browser'

  const looksLikeCodeScreen =
    body.includes('go to your authentication app') ||
    body.includes('enter the 6-digit code') ||
    body.includes('enter the code')
  const hasCodeField = await has2FAField(page)
  if (hasCodeField || looksLikeCodeScreen) return 'code-input'

  if (
    body.includes('check your notifications on another device') ||
    body.includes('waiting for approval')
  ) {
    return 'waiting-approval'
  }

  // Genuinely off the 2FA flow: no dialog, no code field, no known 2FA text,
  // and the URL no longer points at the two-step-verification screen.
  if (!onTwoStepUrl && !body.includes('two-factor') && !body.includes('authentication app')) {
    return 'resolved'
  }

  return 'unknown'
}

/** State 1 action: pick "Authentication app" in the method dialog and confirm. */
async function actMethodDialog(page: Page, signal?: AbortSignal): Promise<string | null> {
  const dialog = page.locator(METHOD_DIALOG_SELECTOR).first()
  const alreadySelected = await dialog
    .locator('input[type="radio"]:checked')
    .first()
    .evaluate((el) => {
      const label = el.closest('label')?.textContent ?? el.parentElement?.textContent ?? ''
      return /authentication app|app xác thực/i.test(label)
    })
    .catch(() => false)

  if (!alreadySelected) {
    const authAppOption = await findFirstVisibleBounded(page, AUTH_APP_OPTION_SELECTORS, 4000)
    if (!authAppOption) return 'Failed to find "Authentication app" option in method dialog'
    await raceAbort(authAppOption.click({ timeout: 5000 }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(400), signal)
  }

  const continueBtn = await findFirstVisibleBounded(page, DIALOG_CONTINUE_SELECTORS, 3000)
  if (!continueBtn) return 'Modal Continue click failed — button not found'
  const clicked = await continueBtn
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  if (!clicked) return 'Modal Continue click failed'

  await raceAbort(page.waitForTimeout(1500), signal)
  return null
}

/**
 * State 2 action: resolve the 6-digit code and submit it.
 * Prefers TOTP generated from account.two_fa; falls back to fetching an
 * emailed confirmation code when no authenticator secret is on file but
 * mailbox credentials are available.
 */
async function actCodeInput(
  page: Page,
  account: Account,
  progress: ProgressFn,
  signal?: AbortSignal
): Promise<string | null> {
  // Absolute safety net: never type a code while the login form is present.
  // The state machine already guards against this, but re-check right at the
  // point of typing since this is the exact bug we're fixing.
  if (await isLoginPage(page)) {
    return 'Refused to enter 2FA code — still on the login page (would type into email/password field)'
  }

  let code: string | null = null

  if (account.two_fa) {
    code = generateTOTP(account.two_fa)
    if (!code) return 'TOTP rejected — invalid 2FA secret format'
  } else if (account.email && account.email_pass) {
    progress('Fetching Mail OTP...')
    const otp = await fetchFacebookOtp(account.email, account.email_pass, {
      mailServer: account.mail_server ?? undefined,
      withinMinutes: 10
    })
    checkAborted(signal)
    if (!otp.success || !otp.code) return otp.error ?? 'Mail OTP not found'
    code = otp.code
  } else {
    return 'Code input shown but account has no 2FA secret or mailbox credentials on file'
  }

  const codeInput = await findCodeInput(page, 4000)
  if (!codeInput) return 'Failed to find Code input'

  const focused = await codeInput
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  if (!focused) return 'Failed to focus Code input'

  const filled = await codeInput
    .fill(code)
    .then(() => true)
    .catch(() => false)
  if (!filled) {
    // Some Facebook variants render a non-standard editable div that rejects
    // .fill() — fall back to human-paced typing on the same locator.
    await typeHumanOn(page, codeInput, code, signal).catch(() => void 0)
  }

  progress('Entering 2FA...', 'Submitting code')

  // Submission Method 1: press Enter directly on the input (most reliable —
  // works even when the Continue button is a non-standard div).
  await raceAbort(codeInput.press('Enter').catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1200), signal)

  // Submission Method 2: if a code screen is still showing, click the
  // explicit Continue / Submit button.
  if (await has2FAField(page)) {
    const submitBtn = await findFirstVisibleBounded(page, CODE_SUBMIT_SELECTORS, 3000)
    if (submitBtn) {
      await raceAbort(submitBtn.click({ timeout: 10000 }).catch(() => void 0), signal)
    }
  }

  await raceAbort(page.waitForTimeout(2000), signal)
  return null
}

/** State 3 action: click "Try another way" to surface the method-chooser dialog (State 1). */
async function actWaitingApproval(page: Page, signal?: AbortSignal): Promise<string | null> {
  const tryAnotherWay = await findFirstVisibleBounded(page, TRY_ANOTHER_WAY_SELECTORS, 4000)
  if (!tryAnotherWay) return 'Failed to find "Try another way" button'
  const clicked = await tryAnotherWay
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  if (!clicked) return '"Try another way" click failed'
  await raceAbort(page.waitForTimeout(1200), signal)
  return null
}

/**
 * True if the post-login "You're logged in. Trust this device?" interstitial
 * is showing — checked by URL (two_factor / two_step_verification) or by its
 * distinctive text, since `c_user` is already set on this screen (the user IS
 * logged in) so cookie-based checks alone can't distinguish it from the real
 * feed. Any caller that treats "cookie present" as "safe to extract profile
 * data" must check this first or it'll silently scrape a blank interstitial.
 */
async function isTrustDeviceScreen(page: Page): Promise<boolean> {
  const url = page.url()
  if (url.includes('/two_factor/') || url.includes('two_step_verification')) {
    const body = await visibleText(page)
    if (
      body.includes("trust this device") ||
      body.includes("you're logged in") ||
      body.includes('chrome on windows')
    ) {
      return true
    }
  }
  const body = await visibleText(page)
  return body.includes('trust this device') || body.includes("you're logged in. trust this device")
}

/**
 * Resolve the "Trust this device?" interstitial: scroll down (this screen
 * renders inside its own scrollable panel, not the browser window), click
 * "Trust this device" (or its fallback buttons if that one can't be found),
 * then wait for the real post-click state — either the c_user cookie appears
 * or the URL leaves the two-factor/verification flow entirely.
 */
async function resolveTrustDeviceScreen(
  page: Page,
  context: BrowserContext,
  progress: ProgressFn,
  signal?: AbortSignal
): Promise<string | null> {
  progress('Entering 2FA...', "Resolving 'Trust this device' prompt...")

  await raceAbort(
    page
      .evaluate(() => window.scrollTo(0, document.body.scrollHeight))
      .catch(() => void 0),
    signal
  )
  await raceAbort(page.waitForTimeout(300), signal)

  let target = await findFirstVisibleBounded(page, TRUST_DEVICE_SELECTORS, 2500)
  if (!target) {
    target = await findFirstVisibleBounded(page, TRUST_DEVICE_FALLBACK_SELECTORS, 2000)
  }
  if (!target) return 'Failed to find "Trust this device" button'

  await raceAbort(target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => void 0), signal)
  await raceAbort(page.mouse.wheel(0, 400).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(300), signal)

  const clicked = await target
    .click({ timeout: 5000, force: true })
    .then(() => true)
    .catch(() => false)
  if (!clicked) return 'Failed to click "Trust this device" button'

  // Wait up to 10s for the interstitial to actually resolve — either c_user
  // materializes (first login through this screen) or the URL leaves the
  // two-factor flow (already-logged-in case, cookie was set before this
  // screen ever rendered).
  const start = Date.now()
  let resolved = false
  for (;;) {
    checkAborted(signal)
    const cookies = await context.cookies().catch(() => [])
    const hasCookie = cookies.some((c) => c.name === 'c_user' && c.value)
    const stillOnScreen = await isTrustDeviceScreen(page).catch(() => false)
    if (hasCookie && !stillOnScreen) {
      resolved = true
      break
    }
    if (Date.now() - start >= 10000) break
    await raceAbort(page.waitForTimeout(500), signal)
  }
  if (!resolved) return null

  // Chrome/Facebook may follow up with its own "Save your login info?" /
  // "Remember Password" prompt — dismiss it (Not Now / OK / Close) rather
  // than let it sit on top of the feed and confuse the extraction steps
  // that run right after this.
  const dismissBtn = await findFirstVisibleBounded(page, REMEMBER_PASSWORD_DISMISS_SELECTORS, 2000)
  if (dismissBtn) {
    await raceAbort(dismissBtn.click({ timeout: 3000, force: true }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(500), signal)
  }

  // Force a clean landing on the feed — strips any leftover
  // ?checkpoint_src=... / two_factor query params so every extraction step
  // that follows starts from a known-good URL instead of a stale one.
  await raceAbort(
    page
      .goto('https://web.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 15000 })
      .catch(() => void 0),
    signal
  )

  return null
}

/** State 4 action: choose Don't Save (preferred) / Save, then confirm. */
async function actSaveBrowser(
  page: Page,
  context: BrowserContext,
  progress: ProgressFn,
  signal?: AbortSignal
): Promise<string | null> {
  // Standalone "Trust this device?" variant, checked first since it has no
  // separate submit step (the button click itself dismisses the screen).
  if (await isTrustDeviceScreen(page)) {
    return resolveTrustDeviceScreen(page, context, progress, signal)
  }

  const dontSave = await findFirstVisibleBounded(page, DONT_SAVE_BROWSER_SELECTORS, 2500)
  const chosen = dontSave ?? (await findFirstVisibleBounded(page, SAVE_BROWSER_SELECTORS, 1500))
  if (chosen) {
    await raceAbort(chosen.click({ timeout: 5000 }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(600), signal)
  }

  const submitBtn = await findFirstVisibleBounded(page, SAVE_BROWSER_SUBMIT_SELECTORS, 3000)
  if (submitBtn) {
    await raceAbort(submitBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
  }
  await raceAbort(page.waitForTimeout(1000), signal)
  return null
}

export interface TwoFAResolution {
  /** True once the flow has genuinely left the 2FA screens (success or otherwise). */
  resolved: boolean
  /** Set only on failure/timeout — the exact step that failed, per requirement 2. */
  failureStep?: string
}

/**
 * Active state-machine loop: polls the DOM every 800ms for up to `timeoutMs`
 * (default 45s), classifying the current screen into one of the five 2FA
 * states on each pass and performing that state's action before re-
 * classifying. Returns as soon as the flow resolves (leaves the 2FA screens)
 * — it does NOT itself decide Live/Checkpoint/etc.; the caller re-runs
 * classifyPage()/detectPostSubmitState() afterward for that.
 */
async function resolve2FAStateMachine(
  page: Page,
  context: BrowserContext,
  account: Account,
  progress: ProgressFn,
  signal?: AbortSignal,
  timeoutMs = 45000
): Promise<TwoFAResolution> {
  const pollIntervalMs = 800
  const start = Date.now()
  let lastState: TwoFAState = 'unknown'

  for (;;) {
    checkAborted(signal)

    const state = await classify2FAState(page)
    lastState = state

    if (state === 'resolved') {
      return { resolved: true }
    }

    let failureStep: string | null = null
    switch (state) {
      case 'method-dialog':
        progress('Entering 2FA...', 'Selecting Authentication app')
        failureStep = await actMethodDialog(page, signal)
        break
      case 'code-input':
        progress('Entering 2FA...', 'Typing 2FA TOTP Code...')
        failureStep = await actCodeInput(page, account, progress, signal)
        break
      case 'waiting-approval':
        progress('Entering 2FA...', 'Waiting for 2FA / Approval...')
        failureStep = await actWaitingApproval(page, signal)
        break
      case 'save-browser':
        progress('Entering 2FA...', 'Resolving "Save browser?" prompt')
        failureStep = await actSaveBrowser(page, context, progress, signal)
        break
      case 'unknown':
        // Still loading/transitioning — no action this pass, just wait and
        // re-classify. Not itself a failure unless we get stuck here.
        break
    }

    checkAborted(signal)

    // A state whose action reported a concrete failure (e.g. a selector that
    // no longer matches Facebook's current DOM) is fatal immediately — do
    // not burn the rest of the time budget retrying the same broken step.
    if (failureStep) {
      return { resolved: false, failureStep }
    }

    // If we've been stuck in the exact same non-resolved state for the
    // entire remaining budget's worth of time without progress, bail with a
    // descriptive timeout rather than silently looping to the outer deadline.
    const elapsed = Date.now() - start
    if (elapsed >= timeoutMs) {
      return {
        resolved: false,
        failureStep: `2FA timed out after ${Math.round(timeoutMs / 1000)}s (stuck on: ${lastState})`
      }
    }

    await raceAbort(page.waitForTimeout(pollIntervalMs), signal)
  }
}

/**
 * One of the four definitive post-submit states the polling loop below waits
 * for. `pending` means none of them have appeared yet (still loading/spinner).
 */
type PostSubmitState =
  | { kind: 'twoFactor' }
  | { kind: 'live' }
  | { kind: 'wrongPassword' }
  | { kind: 'checkpoint' }
  | { kind: 'trustDevice' }
  | { kind: 'pending' }

/** Single-pass check of the current page against all definitive states. */
async function detectPostSubmitState(page: Page): Promise<PostSubmitState> {
  const url = page.url()
  const body = await visibleText(page)

  // State 3: wrong password — checked first, same reasoning as classifyPage.
  if (WRONG_PASSWORD_PATTERNS.some((p) => body.includes(p))) {
    return { kind: 'wrongPassword' }
  }

  // State 4: checkpoint / suspended — the /checkpoint/ URL path alone is
  // the unconditional signal here too (see classifyPage's matching comment
  // for why body-text confirmation must never gate this) — a suspension
  // screen whose copy doesn't match any hardcoded pattern must still be
  // reported as checkpoint, not silently fall through toward 'live'.
  if (url.includes('/checkpoint/')) {
    return { kind: 'checkpoint' }
  }

  // State 5: "You're logged in. Trust this device?" — c_user is already set
  // here, so this must be checked before the generic "live" fallback below
  // or the interstitial gets misclassified as a successful landing on the
  // feed and every extraction step afterward scrapes a blank screen.
  if (await isTrustDeviceScreen(page)) return { kind: 'trustDevice' }

  // State 1: 2FA required.
  if (await is2FAScreen(page)) return { kind: 'twoFactor' }

  // State 2: login success — home feed, nav bar, or c_user cookie. Checked by
  // DOM presence of the login form (isLoginPage), not a URL substring:
  // web.facebook.com stays at the bare "/" path even when a failed/rejected
  // submit re-renders the login form, so a URL-only check would misclassify
  // "still on login form" as Live.
  if (!url.includes('/checkpoint/') && !(await isLoginPage(page))) {
    return { kind: 'live' }
  }

  return { kind: 'pending' }
}

/**
 * Fix for the premature-closure bug: right after submitting the login form,
 * Facebook shows a brief loading/spinner state before redirecting to one of
 * the four definitive outcomes. Evaluating the page immediately (a single
 * fixed wait) can catch that transient state and misclassify it. Poll every
 * ~1s for up to `timeoutMs` until a definitive state appears.
 *
 * The "trust this device" interstitial is not itself a definitive outcome —
 * it's resolved inline (click through it) and polling continues underneath,
 * so callers only ever see the four real outcomes (or 'pending' on timeout).
 */
async function waitForPostSubmitState(
  page: Page,
  context: BrowserContext,
  progress: ProgressFn,
  signal?: AbortSignal,
  timeoutMs = 40000
): Promise<PostSubmitState> {
  const start = Date.now()
  for (;;) {
    checkAborted(signal)
    const state = await detectPostSubmitState(page)
    if (state.kind === 'trustDevice') {
      await resolveTrustDeviceScreen(page, context, progress, signal)
      checkAborted(signal)
    } else if (state.kind !== 'pending') {
      return state
    }
    if (Date.now() - start >= timeoutMs) return { kind: 'pending' }
    await raceAbort(page.waitForTimeout(1000), signal)
  }
}

/**
 * Exported for reuse by checkLiveDie (playwrightManager.ts), which also
 * needs to refresh a session's saved cookie/token after a successful
 * headless liveness check — not just after a full login run.
 *
 * Pulls the FULL cookie jar via context.cookies() (the real CDP-backed set
 * Facebook actually issued — c_user, xs, datr, sb, fr, and whatever else it
 * set), not a hand-picked subset, so nothing the site relies on is silently
 * dropped from what gets saved to the DB. hasRequiredSessionCookies flags
 * (console.warn only — this must never block a login that otherwise
 * succeeded) a jar missing c_user or xs, since those two are the ones
 * Facebook itself requires to treat a browser as logged in; datr/sb/fr are
 * real cookies Facebook does set here too, but are supplementary/tracking
 * cookies, not go/no-go session identifiers.
 */
export async function extractCookiesAndToken(
  context: BrowserContext
): Promise<{ cookie?: string; token?: string }> {
  try {
    const cookies = await context.cookies()
    if (!hasRequiredSessionCookies(cookies)) {
      console.warn(
        `[autoLogin] extracted cookie jar is missing c_user/xs (got: ${cookies.map((c) => c.name).join(', ') || '(empty)'})`
      )
    }
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
    const token = cookies.find((c) => c.name === 'c_user')?.value
    return { cookie, token }
  } catch {
    return {}
  }
}

/**
 * Fallback profile-name selectors, tried only when the UID-scoped link (see
 * extractProfileName) isn't available. NOTE: `[aria-label="Your profile"]`
 * is NOT included here — its aria-label is the literal string "Your
 * profile", not the account's name, and was previously misread as one.
 */
const PROFILE_NAME_SELECTORS = [
  'div[role="banner"] a[href*="/me"] span',
  'h1',
  // Least specific — "any span right after an icon" also matches nav icon
  // labels like Home/Watch/Marketplace, filtered by NON_NAME_HINTS above.
  'div[role="navigation"] svg + span'
]

/** Words that indicate a title/heading/label is an interstitial or generic UI text, not the profile name. */
const NON_NAME_HINTS = [
  'facebook',
  'log in',
  'review',
  'help us',
  'confirm',
  'security',
  'checkpoint',
  'two-factor',
  'authentication',
  'your profile',
  'notifications',
  // Top-nav icon labels — `div[role="navigation"] svg + span` (a generic
  // "span right after an icon" selector, not name-specific) can match these
  // instead of the account name, e.g. the Home icon's own adjacent label.
  'home',
  'watch',
  'marketplace',
  'groups',
  'gaming',
  'menu',
  'មិនទាន់',
  'មិនទាន់មានឈ្មោះ',
  'មិនទាន់ទាញឈ្មោះ',
  'unnamed',
  'unknown'
]

function looksLikeRealName(s: string | null | undefined): s is string {
  if (!s) return false
  const name = s.trim()
  if (name.length < 2 || name.length > 60) return false
  if (/^\d+\s*[-–—]\s*/.test(name)) return false
  const lower = name.toLowerCase()
  return !NON_NAME_HINTS.some((h) => lower.includes(h))
}

/**
 * Dismiss any blocking overlays like "You're in sleep mode" or general dialogs.
 */
export async function dismissFacebookDialogs(page: Page): Promise<void> {
  try {
    await page.keyboard.press('Escape').catch(() => void 0)
    const closeBtn = page
      .locator(
        'div[role="dialog"] div[aria-label="Close"], div[role="dialog"] button[aria-label="Close"], div[aria-label="Close"], button[aria-label="Close"], div[role="dialog"] [aria-label*="Close" i], div[role="dialog"] [aria-label*="Not now" i], div[role="dialog"] [aria-label*="Dismiss" i], div[role="dialog"] [aria-label*="Skip" i]'
      )
      .first()
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 1000, force: true }).catch(() => void 0)
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Best-effort extraction of the account's display name.
 *
 * 1. Checks feed composer text (e.g. "What's on your mind, Instalaciones?")
 * 2. Nav bar's link to the account's OWN profile — `a[href*="profile.php?id={uid}"]`
 * 3. Generic semantic selectors
 */
export async function extractProfileName(page: Page, uid?: string | null): Promise<string | undefined> {
  // 1. From composer greeting on the home feed
  try {
    const composer = page
      .locator(
        'span:has-text("What\'s on your mind"), span:has-text("Bạn đang nghĩ gì"), span:has-text("តើអ្នកកំពុងគិតអ្វី")'
      )
      .first()
    const composerText = await composer.textContent({ timeout: 1500 }).catch(() => null)
    if (composerText) {
      const m = composerText.match(
        /(?:What's on your mind|Bạn đang nghĩ gì|តើអ្នកកំពុងគិតអ្វី)[,\s]+([^?]+)\?/i
      )
      if (m && looksLikeRealName(m[1])) return m[1].trim()
    }
  } catch {
    /* ignore */
  }

  // 2. From UID-scoped profile link
  if (uid) {
    const ownProfileLink = page.locator(`a[href*="profile.php?id=${uid}"]`).first()
    const raw = await ownProfileLink.textContent({ timeout: 1500 }).catch(() => null)
    if (looksLikeRealName(raw)) return raw.trim()
  }

  // 3. Fallback semantic selectors
  for (const sel of PROFILE_NAME_SELECTORS) {
    const loc = page.locator(sel).first()
    const raw = await loc
      .getAttribute('aria-label', { timeout: 1000 })
      .catch(() => null)
      .then((v) => v ?? loc.textContent({ timeout: 1000 }).catch(() => null))
    if (looksLikeRealName(raw)) return raw.trim()
  }
  return undefined
}




export interface ScrapedProfileData {
  cookie?: string
  token?: string
  name?: string
  avatar?: string
  friendsCount?: number
  groupsCount?: number
  location?: string
  createdDate?: string
  uid?: string
  dtsgToken?: string
  followers?: string
  following?: string
  currentLocation?: string
  pagesCount?: number
  pagesData?: string
  friendsList?: string[]
}

/**
 * Step 1: Base Script Parse
 * Single synchronous DOM read of the current page's inline scripts for USER_ID, NAME, and DTSG token.
 */
export async function extractFromInlineScripts(
  page: Page
): Promise<{ userId?: string; name?: string; dtsg?: string }> {
  return (
    (await Promise.race([
      page.evaluate(() => {
        let name: string | null = null
        let userId: string | null = null
        let dtsg: string | null = null
        const scripts = Array.from(document.querySelectorAll('script'))
        for (const s of scripts) {
          const content = s.textContent || ''
          if (!dtsg) {
            const m =
              content.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
              content.match(/"dtsg":\{"token":"([^"]+)"/) ||
              content.match(/"async_get_token":"([^"]+)"/) ||
              content.match(/name="fb_dtsg"\s+value="([^"]+)"/) ||
              content.match(/\["DTSGInitData",\[\],\{"token":"([^"]+)"/) ||
              content.match(/"token":"(NAf[^"]+)"/) ||
              content.match(/DTSGInitialData.*?token":"([^"]+)"/)
            if (m) dtsg = m[1]
          }
          if (!userId) {
            const m =
              content.match(/"USER_ID":"(\d+)"/) ||
              content.match(/"actorID":"(\d+)"/) ||
              content.match(/"ACCOUNT_ID":"(\d+)"/) ||
              content.match(/"current_user_id":"(\d+)"/)
            if (m && m[1] !== '0') userId = m[1]
          }
          if (!name) {
            const m = content.match(/"NAME":"([^"]+)"/) || content.match(/"user":\{"name":"([^"]+)"/)
            if (m) name = m[1]
          }
        }
        if (!dtsg) {
          const inputEl = document.querySelector('input[name="fb_dtsg"]') as HTMLInputElement | null
          if (inputEl?.value) dtsg = inputEl.value
        }
        return { userId: userId ?? undefined, name: name ?? undefined, dtsg: dtsg ?? undefined }
      }),
      new Promise<any>((resolve) => setTimeout(() => resolve({}), 3000))
    ]).catch(() => ({}))) || {}
  )
}

/**
 * Step 2: Friends & Followers Extraction (via /me?sk=friends)
 */
export async function extractFriendsAndFollowers(
  page: Page,
  myUserId: string | null | undefined,
  signal?: AbortSignal
): Promise<{ friendsCount?: number; friendsList?: string[]; followers?: string; following?: string }> {
  try {
    checkAborted(signal)
    await dismissFacebookDialogs(page)
    const base = page.url().includes('web.facebook.com') ? 'https://web.facebook.com' : 'https://www.facebook.com'
    const targetUrl = myUserId
      ? `${base}/profile.php?id=${myUserId}&sk=friends`
      : `${base}/me?sk=friends`
    await raceAbort(
      page
        .goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 6000
        })
        .catch(() => null),
      signal
    )
    if (page.url().includes('_rdc=1') || page.url().endsWith('.facebook.com/')) {
      // If direct friends link bounced to feed, go directly to profile /me
      await raceAbort(
        page.goto(`${base}/me`, { waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => null),
        signal
      )
    }
    await raceAbort(
      page.waitForSelector('div[role="main"], a[role="link"]', { timeout: 3000 }).catch(() => void 0),
      signal
    )
    await raceAbort(page.waitForTimeout(800), signal)
    const info = await raceAbort(
      Promise.race([
        page.evaluate((myId: string) => {
          const main = document.querySelector('div[role="main"]') || document.body
          const pageText = ((main as HTMLElement).innerText || '').replace(/\u00a0/g, ' ')
          const followerMatch = pageText.match(/(\d[\d,.]*\s*(?:followers?|អ្នកតាមដាន))/i)
          const followingMatch = pageText.match(/(\d[\d,.]*\s*(?:following|កំពុងតាមដាន))/i)
          const friendMatch =
            pageText.match(/Friends\s*·?\s*(\d[\d,.]*)/i) ||
            pageText.match(/(\d[\d,.]*)\s*(?:friends?|មិត្តភក្តិ)/i) ||
            pageText.match(/(?:friends?|មិត្តភក្តិ)\s*·?\s*(\d[\d,.]*)/i)
          const NON_NAMES = [
            'Friends', 'Find Friends', 'Friend requests', 'Recently Added', 'Followers',
            'Following', 'More', 'All', 'About', 'Reels', 'Photos', 'Check-ins', 'Edit', 'Dashboard'
          ]
          const friendList: string[] = []
          const seen = new Set<string>()
          for (const a of Array.from(main.querySelectorAll('a[role="link"]'))) {
            const href = (a as HTMLAnchorElement).href || ''
            const text = ((a as HTMLElement).innerText || '').trim()
            const isNotSelf = myId ? !href.includes(myId) && !href.includes('/me') : !href.includes('/me')
            const isProfile =
              href.includes('profile.php?id=') ||
              (!href.includes('/groups/') && !href.includes('/pages/') && !href.includes('/messages/'))
            if (isNotSelf && isProfile && !NON_NAMES.includes(text) && text.length > 1 && !text.includes('\n')) {
              if (!seen.has(href)) {
                seen.add(href)
                friendList.push(text)
              }
            }
          }
          const parseNum = (s: string | undefined): number | undefined => {
            if (!s) return undefined
            const m = s.match(/\d[\d,.]*/)
            if (!m) return undefined
            const n = parseInt(m[0].replace(/[,.]/g, ''), 10)
            return Number.isFinite(n) ? n : undefined
          }
          return {
            friendsCount: parseNum(friendMatch?.[1]) ?? (friendList.length > 0 ? friendList.length : undefined),
            friendsList: friendList.length ? friendList : undefined,
            followers: followerMatch ? followerMatch[1].trim() : undefined,
            following: followingMatch ? followingMatch[1].trim() : undefined
          }
        }, myUserId ?? ''),
        new Promise<any>((resolve) => setTimeout(() => resolve({}), 4000))
      ]),
      signal
    )
    return info || {}
  } catch (err) {
    if (signal?.aborted || err instanceof AbortedError) throw err
    return {}
  }
}

/**
 * Step 3: Created Date Extraction (via /me/allactivity)
 */
export async function extractCreatedDateFromActivityLog(
  page: Page,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    checkAborted(signal)
    // Quick check on current page first before navigating
    const quickDate = await raceAbort(
      Promise.race([
        page.evaluate(() => {
          const bodyText = document.body.innerText || ''
          const m = bodyText.match(/(?:Joined|បានចូលរួម)\s*([A-Za-z]+\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4})/i)
          return m ? m[1] : null
        }),
        new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 1000))
      ]),
      signal
    ).catch(() => null)
    if (quickDate) return quickDate

    await dismissFacebookDialogs(page)
    const base = page.url().includes('web.facebook.com') ? 'https://web.facebook.com' : 'https://www.facebook.com'
    await raceAbort(
      page
        .goto(`${base}/me/allactivity`, {
          waitUntil: 'domcontentloaded',
          timeout: 6000
        })
        .catch(() => null),
      signal
    )
    await raceAbort(
      page.waitForSelector('div[role="main"], div[role="feed"]', { timeout: 3000 }).catch(() => void 0),
      signal
    )
    await raceAbort(page.waitForTimeout(800), signal)
    const date = await raceAbort(
      Promise.race([
        page.evaluate(() => {
          const main = document.querySelector('div[role="main"]') || document.body
          const lines = (main as HTMLElement).innerText.split('\n').map((l) => l.trim()).filter(Boolean)
          const dateRegex =
            /^(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/i
          const dates = lines.filter((l) => dateRegex.test(l))
          if (dates.length > 0) return dates[dates.length - 1]
          const joinedMatch =
            (main as HTMLElement).innerText.match(/Joined\s+([A-Za-z]+\s+\d{4})/i) ||
            document.body.innerText.match(/(?:Joined|បានចូលរួម)\s*([A-Za-z0-9\s,]+)/i)
          if (joinedMatch) return joinedMatch[1]
          return null
        }),
        new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 4000))
      ]),
      signal
    )
    return date ?? undefined
  } catch (err) {
    if (signal?.aborted || err instanceof AbortedError) throw err
    return undefined
  }
}

/**
 * Step 4A: Primary Location (via /primary_location/info)
 */
export async function extractPrimaryLocation(
  page: Page,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    checkAborted(signal)
    await dismissFacebookDialogs(page)
    const base = page.url().includes('web.facebook.com') ? 'https://web.facebook.com' : 'https://www.facebook.com'
    await raceAbort(
      page
        .goto(`${base}/primary_location/info`, {
          waitUntil: 'domcontentloaded',
          timeout: 6000
        })
        .catch(() => null),
      signal
    )
    await raceAbort(
      page.waitForSelector('div[role="main"], body', { timeout: 3000 }).catch(() => void 0),
      signal
    )
    await raceAbort(page.waitForTimeout(800), signal)
    const location = await raceAbort(
      Promise.race([
        page.evaluate(() => {
          const bodyText = (document.body.innerText || '').replace(/\u00a0/g, ' ')
          const match =
            bodyText.match(/Your primary location is near:\s*([^\n\r]+)/i) ||
            bodyText.match(/Your primary location:\s*([^\n\r]+)/i) ||
            bodyText.match(/ទីតាំងចម្បងរបស់អ្នកគឺនៅជិត:\s*([^\n\r]+)/i) ||
            bodyText.match(/ទីតាំងចម្បង:\s*([^\n\r]+)/i)
          return match ? match[1].trim().replace(/\s+/g, ' ') : null
        }),
        new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 4000))
      ]),
      signal
    )
    return location ?? undefined
  } catch (err) {
    if (signal?.aborted || err instanceof AbortedError) throw err
    return undefined
  }
}

/**
 * Step 4B: Current Location (via accountscenter login activity)
 */
export async function extractCurrentDeviceLocation(
  page: Page,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    checkAborted(signal)
    await dismissFacebookDialogs(page)
    await raceAbort(
      page
        .goto('https://accountscenter.facebook.com/password_and_security/login_activity', {
          waitUntil: 'domcontentloaded',
          timeout: 7000
        })
        .catch(() => null),
      signal
    )
    await raceAbort(
      page.waitForSelector('div[role="main"], body', { timeout: 3000 }).catch(() => void 0),
      signal
    )
    await raceAbort(page.waitForTimeout(800), signal)

    // Click the account row to expand device login activity
    try {
      await raceAbort(
        Promise.race([
          page.evaluate(() => {
            const clickables = Array.from(document.querySelectorAll('div[role="button"], a[role="link"]'))
            const target = clickables.find((el) => {
              const txt = (el as HTMLElement).innerText || ''
              const label = el.getAttribute('aria-label') || ''
              return (
                /more|Facebook|This device|Active now/i.test(txt) &&
                !/Learn more|Preferences|Back|Close|Settings|Password|Two-factor|Saved|Passkey|Security/i.test(txt + label)
              )
            })
            if (target) (target as HTMLElement).click()
          }),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]),
        signal
      )
      await raceAbort(page.waitForTimeout(800), signal)
    } catch {
      /* best-effort row click */
    }

    const loc = await raceAbort(
      Promise.race([
        page.evaluate(() => {
          const lines = document.body.innerText.split('\n').map((l) => l.trim()).filter(Boolean)
          for (let i = 0; i < lines.length; i++) {
            if (/this device/i.test(lines[i]) && i > 0) return lines[i - 1]
          }
          return null
        }),
        new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 3000))
      ]),
      signal
    )
    return loc ?? undefined
  } catch (err) {
    if (signal?.aborted || err instanceof AbortedError) throw err
    return undefined
  }
}

/**
 * Step 5A: Groups Count (via /groups/joins)
 */
export async function extractGroupsCount(page: Page, signal?: AbortSignal): Promise<number | undefined> {
  try {
    checkAborted(signal)
    await dismissFacebookDialogs(page)
    const base = page.url().includes('web.facebook.com') ? 'https://web.facebook.com' : 'https://www.facebook.com'
    await raceAbort(
      page
        .goto(`${base}/groups/joins/?nav_source=tab`, {
          waitUntil: 'domcontentloaded',
          timeout: 6000
        })
        .catch(() => null),
      signal
    )
    await raceAbort(
      page.waitForSelector('div[role="main"], a[href*="/groups/"]', { timeout: 3000 }).catch(() => void 0),
      signal
    )
    await raceAbort(page.waitForTimeout(800), signal)
    const count = await raceAbort(
      Promise.race([
        page.evaluate(() => {
          const main = document.querySelector('div[role="main"]') || document.body
          const bodyText = (document.body.innerText || '').replace(/\u00a0/g, ' ')
          const mainText = ((main as HTMLElement).innerText || '').replace(/\u00a0/g, ' ')

          // 1. Check heading number in parentheses: "All groups you've joined (2)"
          const headingMatch =
            bodyText.match(/all groups you.ve joined\s*\((\d+)\)/i) ||
            mainText.match(/all groups you.ve joined\s*\((\d+)\)/i) ||
            bodyText.match(/ក្រុមទាំងអស់ដែលអ្នកបានចូលរួម\s*\((\d+)\)/i) ||
            bodyText.match(/(\d+)\s*groups? you.ve joined/i) ||
            bodyText.match(/(\d+)\s*ក្រុម/i)
          if (headingMatch) {
            const n = parseInt(headingMatch[1], 10)
            if (Number.isFinite(n)) return n
          }

          // 2. Count distinct group IDs inside main container only
          const uniqueGroupIds = new Set<string>()
          for (const a of Array.from(main.querySelectorAll('a[href*="/groups/"]'))) {
            const href = a.getAttribute('href') || ''
            const m = href.match(/\/groups\/(\d+|[a-zA-Z0-9._-]+)\/?/)
            if (m && !['joins', 'feed', 'discover', 'categories', 'create', 'user'].includes(m[1])) {
              uniqueGroupIds.add(m[1])
            }
          }
          return uniqueGroupIds.size
        }),
        new Promise<number>((resolve) => setTimeout(() => resolve(0), 4000))
      ]),
      signal
    )
    return typeof count === 'number' && Number.isFinite(count) ? count : 0
  } catch (err) {
    if (signal?.aborted || err instanceof AbortedError) throw err
    return undefined
  }
}

export interface ExtractedPagesResult {
  count: number
  pages: ManagedPage[]
}

/**
 * Step 5B: Pages Count & Managed Pages List (via /pages/?category=your_pages)
 */
export async function extractPagesCount(page: Page, signal?: AbortSignal): Promise<ExtractedPagesResult | undefined> {
  try {
    checkAborted(signal)
    await dismissFacebookDialogs(page)
    const base = page.url().includes('web.facebook.com') ? 'https://web.facebook.com' : 'https://www.facebook.com'
    await raceAbort(
      page
        .goto(`${base}/pages/?category=your_pages`, {
          waitUntil: 'domcontentloaded',
          timeout: 6000
        })
        .catch(() => null),
      signal
    )
    await raceAbort(
      page.waitForSelector('div[role="main"], a', { timeout: 3000 }).catch(() => void 0),
      signal
    )
    await raceAbort(page.waitForTimeout(800), signal)
    const data = await raceAbort(
      Promise.race([
        page.evaluate(() => {
          const main = document.querySelector('div[role="main"]') || document.body
          const text = ((main as HTMLElement).innerText || '').replace(/\u00a0/g, ' ')
          const allLinks = Array.from(main.querySelectorAll('a'))
          const pages: Array<{ pageId: string; name: string; assetId?: string; url?: string }> = []

          // 1. Header count match: "Pages you manage (N)"
          const match = text.match(/Pages you manage\s*\((\d+)\)/i) || document.body.innerText.match(/Pages you manage\s*\((\d+)\)/i)
          const headerCount = match ? parseInt(match[1], 10) : undefined

          const pageLinks = allLinks.filter((a) => {
            const aText = (a.innerText || '').trim()
            const href = a.href || ''
            return (
              aText &&
              !/^(Pages|Create Page|Meta Business Suite|Discover|Followed Pages|Invites|Promote|Notifications|Messages|\d+\s*(Notifications|Messages)|Create post)$/i.test(
                aText
              ) &&
              !href.includes('/inbox/') &&
              !href.includes('/ad_center/') &&
              !href.includes('/settings') &&
              !href.includes('category=')
            )
          })

          // Extract assetId from inbox or ad_center link if available
          const bizLink = allLinks.find((a) => a.href.includes('asset_id=') || a.href.includes('page_id='))
          let defaultAssetId: string | undefined
          if (bizLink) {
            const m = bizLink.href.match(/(?:asset_id|page_id)=(\d+)/)
            if (m) defaultAssetId = m[1]
          }

          for (const a of pageLinks) {
            const name = (a.innerText || '').trim()
            let pageId = ''
            const m = a.href.match(/profile\.php\?id=(\d+)/)
            if (m) {
              pageId = m[1]
            } else {
              const clean = a.href.split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\//, '')
              if (clean) pageId = clean
            }
            if (pageId && !pages.some((p) => p.pageId === pageId)) {
              pages.push({
                pageId,
                name,
                assetId: defaultAssetId || pageId,
                url: a.href.split('&')[0]
              })
            }
          }

          const count = headerCount ?? (pages.length > 0 ? pages.length : 0)
          return { count, pages }
        }),
        new Promise<any>((resolve) => setTimeout(() => resolve(undefined), 4000))
      ]),
      signal
    )

    return data
  } catch (err) {
    if (signal?.aborted || err instanceof AbortedError) throw err
    console.warn('[extractPagesCount] error:', err)
    return undefined
  }
}

/**
 * 5-Step post-login metadata extraction pipeline.
 * Each step is wrapped in its own try/catch and 8000ms timeout so a single
 * missing field never fails or hangs the rest of the pipeline.
 */
export async function extractAllMetadata(
  page: Page,
  context: BrowserContext,
  uid: string | null | undefined,
  signal?: AbortSignal,
  onStepUpdate?: (data: Partial<Account>) => void | Promise<void>
): Promise<ScrapedProfileData> {
  // Step 1: Base script + cookie parse on current page
  const { cookie, token } = await extractCookiesAndToken(context)
  const scriptData = await extractFromInlineScripts(page)
  const cUser = cookie
    ? cookie.split(';').map((p) => p.trim()).find((p) => p.startsWith('c_user='))?.slice('c_user='.length)
    : undefined
  const resolvedUid = uid?.trim() ? uid : (scriptData.userId ?? cUser)
  const dtsgToken = scriptData.dtsg
  const name = looksLikeRealName(scriptData.name)
    ? scriptData.name.trim()
    : await extractProfileName(page, resolvedUid)

  const result: ScrapedProfileData = {
    cookie,
    token,
    name,
    uid: resolvedUid,
    dtsgToken
  }

  await onStepUpdate?.({
    status: 'Live',
    ...(cookie ? { cookie } : {}),
    ...(token ? { token } : {}),
    ...(name ? { name } : {}),
    ...(resolvedUid ? { uid: resolvedUid } : {}),
    ...(dtsgToken ? { dtsg_token: dtsgToken } : {})
  })

  const isFastMode = getAppSettings().metadataExtractionMode === 'fast'
  if (isFastMode) {
    return result
  }

  // Step 2: Friends & Followers (via /me?sk=friends)
  try {
    checkAborted(signal)
    const ff = await extractFriendsAndFollowers(page, resolvedUid, signal)
    result.friendsCount = ff.friendsCount
    result.followers = ff.followers
    result.following = ff.following
    result.friendsList = ff.friendsList
    await onStepUpdate?.({
      ...(ff.friendsCount != null ? { friends_count: ff.friendsCount } : {}),
      ...(ff.followers ? { followers: ff.followers } : {}),
      ...(ff.following ? { following: ff.following } : {}),
      ...(ff.friendsList ? { friends_list: JSON.stringify(ff.friendsList) } : {})
    })
  } catch (err) {
    console.warn('[extractAllMetadata] Step 2 friends/followers error:', err)
  }

  // Step 3: Created Date (via /me/allactivity)
  try {
    checkAborted(signal)
    const createdDate = await extractCreatedDateFromActivityLog(page, signal)
    if (createdDate) {
      result.createdDate = createdDate
      await onStepUpdate?.({ created_date: createdDate })
    }
  } catch (err) {
    console.warn('[extractAllMetadata] Step 3 created date error:', err)
  }

  // Step 4: Locations (Primary: /primary_location/info, Current: login_activity)
  try {
    checkAborted(signal)
    const primaryLocation = await extractPrimaryLocation(page, signal)
    const currentLocation = await extractCurrentDeviceLocation(page, signal)
    result.location = primaryLocation
    result.currentLocation = currentLocation
    await onStepUpdate?.({
      ...(primaryLocation ? { location: primaryLocation } : {}),
      ...(currentLocation ? { current_location: currentLocation } : {})
    })
  } catch (err) {
    console.warn('[extractAllMetadata] Step 4 location error:', err)
  }

  // Step 5: Groups & Pages (Groups: /groups/joins, Pages: /pages/?category=your_pages)
  try {
    checkAborted(signal)
    const groupsCount = await extractGroupsCount(page, signal)
    const pagesResult = await extractPagesCount(page, signal)
    result.groupsCount = groupsCount
    result.pagesCount = pagesResult?.count
    result.pagesData = pagesResult?.pages ? JSON.stringify(pagesResult.pages) : undefined
    await onStepUpdate?.({
      ...(groupsCount != null ? { groups_count: groupsCount } : {}),
      ...(pagesResult?.count != null ? { pages_count: pagesResult.count } : {}),
      ...(pagesResult?.pages ? { pages_data: JSON.stringify(pagesResult.pages) } : {})
    })
  } catch (err) {
    console.warn('[extractAllMetadata] Step 5 groups/pages error:', err)
  }

  return result
}

/**
 * Poll until the session is genuinely logged in — the URL has left the
 * two-step-verification / login flow, OR the c_user cookie is present.
 * Returns true if confirmed logged in within the budget, false on timeout.
 */
async function waitForLoggedIn(
  page: Page,
  context: BrowserContext,
  progress: ProgressFn,
  signal?: AbortSignal,
  timeoutMs = 25000
): Promise<boolean> {
  const start = Date.now()
  for (;;) {
    checkAborted(signal)

    // c_user is already set on the "Trust this device?" interstitial (it
    // reads "You're logged in") — a bare cookie check here would report
    // success while the page is still stuck on that screen, and every
    // extraction step afterward would silently scrape a blank interstitial
    // instead of the feed. Resolve it inline before trusting the cookie.
    if (await isTrustDeviceScreen(page).catch(() => false)) {
      await resolveTrustDeviceScreen(page, context, progress, signal)
      checkAborted(signal)
    }

    const cookies = await context.cookies().catch(() => [])
    if (cookies.some((c) => c.name === 'c_user' && c.value)) return true

    const url = page.url()
    if (!url.includes('/two_step_verification/') && !url.includes('login') && !url.includes('/checkpoint/')) {
      return true
    }

    if (Date.now() - start >= timeoutMs) return false
    await raceAbort(page.waitForTimeout(1000), signal)
  }
}

/**
 * Run the complete auto-login flow for one account. Cooperative-cancels via
 * `options.signal` between steps (Playwright has no native abort, so we check
 * the flag at each safe point and throw AbortedError, caught by the caller).
 */
export async function runAutoLogin(
  account: Account,
  options: AutoLoginOptions = {}
): Promise<AutoLoginResult> {
  const { headless = true, slotIndex, signal, onProgress, useMbasic = false } = options
  const progress: ProgressFn = (stage, detail) => onProgress?.(stage, detail)

  if (!account.uid && !account.email) {
    return { success: false, status: 'Unknown', detail: 'No UID/email to log in with' }
  }
  if (!account.password) {
    return { success: false, status: 'Unknown', detail: 'No password set' }
  }

  const trackKey = `login:${account.id}`
  let context: BrowserContext | null = null

  try {
    checkAborted(signal)
    progress('Opening Chrome...')
    context = await launchContext({ headless, account, slotIndex })
    trackContext(trackKey, context)

    const page = context.pages()[0] ?? (await context.newPage())
    const loginUrl = useMbasic ? FACEBOOK_URLS.mbasic : FACEBOOK_URLS.full

    checkAborted(signal)
    progress('Checking session...')
    await raceAbort(
      page.goto(loginUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }),
      signal
    )

    // Dismiss any cookie-consent / language / bottom-sheet overlay that would
    // otherwise sit on top of the login form and swallow clicks.
    await dismissConsentOverlays(page, signal)

    // Account Chooser interstitial (avatar + name, "Continue" / "Use
    // another profile" / "Create new account") — a saved profile dir can
    // land here instead of the normal login form. Must be resolved BEFORE
    // the isLoginPage() check below: this screen has neither the login form
    // nor a genuinely-authenticated session, so left unhandled it either
    // gets misread as "already logged in" or the credential-entry step
    // below fails to find #email/#pass at all.
    checkAborted(signal)
    if (await isAccountSwitcherScreen(page)) {
      progress('Checking session...', 'Resolving account switcher screen...')
      await resolveAccountSwitcherScreen(page, context, signal)
      checkAborted(signal)
    }

    // Already logged in via a persisted session/cookie? Checked by DOM
    // presence of the login form (isLoginPage), not the URL — web.facebook.com
    // stays at the bare "/" path even while showing the login form for a
    // logged-out session, so a URL-only check would wrongly treat every
    // logged-out account as "already live" and skip credential entry.
    if (!(await isLoginPage(page))) {
      if (await isTrustDeviceScreen(page)) {
        await resolveTrustDeviceScreen(page, context, progress, signal)
        checkAborted(signal)
      }
      const res = await classifyPage(page)
      progress(res.status, res.detail)

      let metadata: ScrapedProfileData = {}
      if (res.status === 'Live') {
        metadata = await extractAllMetadata(page, context, account.uid, signal)
        checkAborted(signal)
        // Direct Warm-up (General Settings, default on): this is the
        // "session was already valid, no credentials were ever entered"
        // fast path — run the queued warm-up scenario right away instead of
        // treating this as just a liveness check. Off skips straight to
        // returning the (still fully refreshed) result below, useful for a
        // pure liveness-check batch that shouldn't also act on every
        // account it finds already logged in.
        if (options.onLoggedIn && getAppSettings().directWarmup) {
          await options.onLoggedIn(page)
        }
      }

      // Cookies are only extracted/saved for a genuinely Live session — see
      // the matching comment further down in the fresh-credential-login
      // branch for why a Checkpoint/suspended/disabled account's cookie
      // must never be persisted.
      const { cookie, token } = res.status === 'Live' ? metadata : { cookie: undefined, token: undefined }
      return {
        success: res.status === 'Live',
        status: res.status,
        detail: res.status === 'Live' ? 'Login Success' : res.detail,
        cookie,
        token,
        name: metadata.name,
        friendsCount: metadata.friendsCount,
        groupsCount: metadata.groupsCount,
        uid: metadata.uid,
        dtsgToken: metadata.dtsgToken,
        followers: metadata.followers,
        following: metadata.following,
        currentLocation: metadata.currentLocation,
        pagesCount: metadata.pagesCount,
        friendsList: metadata.friendsList,
        location: metadata.location,
        createdDate: metadata.createdDate,
        notes:
          res.status === 'Changed Pass' ? 'Wrong Password' : res.status === 'Checkpoint' ? res.detail : undefined
      }
    }

    checkAborted(signal)
    progress('Logging in...')

    const emailField = await findFirstVisible(page, EMAIL_SELECTORS)
    if (!emailField) {
      progress('Error', 'Email/username field not found (page layout changed?)')
      return {
        success: false,
        status: 'Unknown',
        detail: 'Email/username field not found — Facebook may have changed its login page layout'
      }
    }
    await typeHumanOn(page, emailField, account.uid || account.email || '', signal)

    checkAborted(signal)
    const passField = await findFirstVisible(page, PASSWORD_SELECTORS)
    if (!passField) {
      progress('Error', 'Password field not found (page layout changed?)')
      return {
        success: false,
        status: 'Unknown',
        detail: 'Password field not found — Facebook may have changed its login page layout'
      }
    }
    await typeHumanOn(page, passField, account.password, signal)

    progress('Logging in...', 'Submitting Credentials...')
    const loginBtn = await findFirstVisible(page, LOGIN_BUTTON_SELECTORS)
    if (loginBtn) {
      await clickWithJitter(page, loginBtn, signal)
    } else {
      // Last resort: submit via Enter on the password field.
      await raceAbort(passField.press('Enter').catch(() => void 0), signal)
    }

    // ---- Fix for premature closure: the login button shows a brief
    // spinner/loading state before Facebook redirects. Evaluating the page
    // immediately after the click risks catching that transient state and
    // misclassifying (or worse, closing the browser) before the real outcome
    // — 2FA / Live / wrong password / checkpoint — has actually rendered. So
    // instead of one fixed wait, poll every ~1s for up to 35s until one of
    // the four definitive states appears. ----
    progress('Verifying...', 'Waiting for page transition...')
    const postSubmit = await waitForPostSubmitState(page, context, progress, signal, 35000)
    checkAborted(signal)

    // ---- Requirement 1: check WRONG PASSWORD first, before any 2FA logic.
    // A bad-credentials response must stop the flow dead — never fall through
    // into the 2FA state machine (which historically typed the TOTP into the
    // login form). Status is recorded as 'Changed Pass' and the browser
    // closes immediately in the finally block below. ----
    if (postSubmit.kind === 'wrongPassword') {
      progress('Changed Pass', 'Wrong Password')
      return {
        success: false,
        status: 'Changed Pass',
        detail: 'Wrong Password',
        notes: 'Wrong Password'
      }
    }

    // ---- Branch C (direct checkpoint): a 956/282 lock screen reached
    // immediately after credential submission, with no 2FA step in between.
    // Checkpoint 282 (identity/liveness "Confirm you're human" verification)
    // is reported by name rather than the generic "956/282" label — this app
    // never attempts to resolve it automatically (no auto-solve, no photo
    // upload), so the account is simply marked Checkpoint and the browser
    // closed immediately rather than left open — this app doesn't drive any
    // manual-resolution flow from here (that's a separate, explicit action
    // via "Resolve Checkpoint 282 (Manual)" opening its own browser). ----
    if (postSubmit.kind === 'checkpoint') {
      const is282 = is282LockText(await visibleText(page))
      const label = is282 ? 'Checkpoint 282' : 'Checkpoint 956/282'
      progress('Checkpoint', label)
      return {
        success: false,
        status: 'Checkpoint',
        detail: label,
        notes: label
      }
    }

    // ---- 2FA resolution: hand off to the active state-machine loop, which
    // polls the DOM every 800ms for up to 45s and reacts to whichever of the
    // five known 2FA screens is currently showing (including screens that
    // re-appear mid-flow, e.g. the method dialog surfacing again after
    // "Try another way"). See resolve2FAStateMachine() for the full state
    // table; this call site only needs to know whether it succeeded. ----
    if (postSubmit.kind === 'twoFactor') {
      const resolution = await resolve2FAStateMachine(page, context, account, progress, signal, 45000)
      checkAborted(signal)

      if (!resolution.resolved) {
        // The state machine's own classification can lag behind reality right
        // at the boundary — e.g. the code was accepted and the session is
        // already authenticated, but the loop's last poll still read a stale
        // 2FA-ish page and returned unresolved before ever seeing the
        // c_user cookie or the navigated-away URL. Never trust "unresolved"
        // at face value: do the same definitive check waitForLoggedIn uses
        // before giving up, so a login that actually succeeded isn't
        // misreported as a failed Checkpoint.
        const actuallyLoggedIn = await waitForLoggedIn(page, context, progress, signal, 5000)
        if (!actuallyLoggedIn) {
          // Per requirement 2: never swallow a 2FA failure — log the exact
          // step and persist it as a Checkpoint with a descriptive note; the
          // browser closes immediately in the finally block below.
          const failureDetail = resolution.failureStep ?? '2FA resolution failed for an unknown reason'
          progress('Checkpoint', failureDetail)
          return {
            success: false,
            status: 'Checkpoint',
            detail: failureDetail,
            notes: `2FA Failed: ${failureDetail}`
          }
        }
      } else {
        // ---- Post-2FA wait: after submitting the code, poll up to 25s for
        // the session to actually materialize — either the URL leaves the
        // two-step-verification flow, or the c_user cookie appears. ----
        progress('Verifying...', 'Waiting for login to complete...')
        await waitForLoggedIn(page, context, progress, signal, 25000)
        checkAborted(signal)
      }
    }

    progress('Verifying...')
    const result = await classifyPage(page)
    progress(result.status, result.detail)

    let metadata: ScrapedProfileData = {}

    if (result.status === 'Live') {
      // ---- Post-login data extraction — runs BEFORE any warm-up scenario and
      // BEFORE the browser is allowed to close, so the context is guaranteed
      // to still be open while extraction happens. ----
      progress('Verifying...', 'Extracting Profile & Primary Location...')
      metadata = await extractAllMetadata(page, context, account.uid, signal)
      checkAborted(signal)

      if (options.onLoggedIn) {
        await options.onLoggedIn(page)
      }

      progress('Live', 'Login Success')
    }

    // Cookies are only extracted/saved for a genuinely Live session. A
    // Checkpoint/suspended/disabled account's cookie is not a usable
    // session — saving it would let a later "Login with Cookie" or queue
    // run silently treat a suspended account as if it had a working
    // session, and there's nothing to gain from persisting it regardless.
    const { cookie, token } = result.status === 'Live' ? metadata : { cookie: undefined, token: undefined }

    // Use classifyPage's own detail text (e.g. "Checkpoint 282" vs the
    // generic "Checkpoint 956/282") rather than a second hardcoded string,
    // so a checkpoint/wrong-password outcome reached here — e.g. after a 2FA
    // attempt that itself resolved but the account was then checkpointed —
    // is recorded with the same specific label classifyPage determined.
    const notes =
      result.status === 'Changed Pass'
        ? 'Wrong Password'
        : result.status === 'Checkpoint'
          ? result.detail
          : undefined

    return {
      success: result.status === 'Live',
      status: result.status,
      detail: result.status === 'Live' ? 'Login Success' : result.detail,
      cookie,
      token,
      name: metadata.name,
      friendsCount: metadata.friendsCount,
      groupsCount: metadata.groupsCount,
      uid: metadata.uid,
      dtsgToken: metadata.dtsgToken,
      followers: metadata.followers,
      following: metadata.following,
      currentLocation: metadata.currentLocation,
      pagesCount: metadata.pagesCount,
      friendsList: metadata.friendsList,
      location: metadata.location,
      createdDate: metadata.createdDate,
      notes
    }
  } catch (err) {
    if (err instanceof AbortedError) {
      progress('Cancelled')
      return { success: false, status: 'Unknown', detail: 'Cancelled by user' }
    }
    const message = err instanceof Error ? err.message : String(err)
    progress('Error', message)
    return { success: false, status: 'Unknown', detail: `Login error: ${message}` }
  } finally {
    // Always close and untrack once a final status has been determined —
    // Live (with or without a scenario), any failure terminal state (wrong
    // password, checkpoint, failed/stuck 2FA), a headless run, an aborted
    // run, and a hard error (caught above) all close immediately. A
    // finished "No scenario (login only)" run has already updated the
    // account row with its status/cookie/metadata by this point, so there
    // is nothing left for the browser window to show — leaving it open
    // would just clutter the screen once the task is done.
    untrackContext(trackKey)
    await context?.close().catch(() => void 0)
  }
}
