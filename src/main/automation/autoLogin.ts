// ---------------------------------------------------------------------------
// autoLogin.ts  — full Facebook auto-login lifecycle:
//   session check → credential fill → 2FA (TOTP) / email-OTP / checkpoint /
//   wrong-password detection → cookie + status persistence.
//
// Designed to run standalone (single account, headed) or from queueRunner.ts
// (headless, concurrent, abortable).
// ---------------------------------------------------------------------------
import type { BrowserContext, Page } from 'playwright'
import { writeFile } from 'fs/promises'
import sharp from 'sharp'
import type { Account } from '../../types/account'
import { launchContext, trackContext, untrackContext, avatarFilePath } from './browserContext'
import { fetchFacebookOtp } from './imapWorker'
import { generateTOTP } from './totp'
import { getAppSettings } from '../db/settingsRepo'

export type LoginStatus = 'Live' | 'Checkpoint' | 'Die' | 'Changed Pass' | 'Unknown'

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
  /** Primary location (city / country) scraped from profile Intro/About (best-effort). */
  location?: string
  /** Account creation / joined date scraped from transparency info (best-effort). */
  createdDate?: string
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

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError()
}

/**
 * Race a Playwright call against the abort signal so a long internal wait
 * (e.g. a locator timeout) can't block cancellation — Stop takes effect
 * immediately instead of waiting out the operation's own timeout.
 */
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
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

/** Genuine account-lock text — distinct from a mere "checkpoint" step in a normal flow. */
const ACCOUNT_LOCKED_PATTERNS = [
  'your account has been locked',
  'we suspended your account',
  'account has been disabled',
  'your account has been disabled'
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
  const body = await visibleText(page)

  // ---- Case D: wrong password (checked first — takes priority over any
  // superficial "checkpoint" wording/URL on the same error response) ----
  if (WRONG_PASSWORD_PATTERNS.some((p) => body.includes(p))) {
    return { status: 'Changed Pass', detail: 'Wrong Password' }
  }

  // ---- Case C: locked / disabled / suspended ----
  if (ACCOUNT_LOCKED_PATTERNS.some((p) => body.includes(p)) || url.includes('/disabled')) {
    return { status: 'Die', detail: 'Account Disabled / Suspended' }
  }

  // ---- Real checkpoint: requires BOTH the /checkpoint/ URL AND an actual
  // lock-screen indicator — a bare "checkpoint" substring in unrelated page
  // text (or a 2FA step that will resolve normally) must not trip this.
  // Checkpoint 282 (identity/liveness verification) is checked first since
  // it can appear without the literal "282" digits on-page. ----
  if (url.includes('/checkpoint/')) {
    if (is282LockText(body)) {
      return { status: 'Checkpoint', detail: 'Checkpoint 282' }
    }
    const lockCodeMatch = body.match(/\b(956|282)\b/)
    const lockedText = ACCOUNT_LOCKED_PATTERNS.some((p) => body.includes(p))
    if (lockCodeMatch || lockedText) {
      return {
        status: 'Checkpoint',
        detail: `Checkpoint${lockCodeMatch ? ` ${lockCodeMatch[1]}` : ' (locked)'}`
      }
    }
  }

  // ---- Still on a login page — checked by URL, body text, AND DOM presence
  // of the login form (isLoginPage), since web.facebook.com stays at the bare
  // "/" path (no "login" substring) even when the login form is showing. ----
  if (
    url.includes('login') ||
    body.includes('log in to facebook') ||
    body.includes('log into facebook') ||
    (await isLoginPage(page))
  ) {
    return { status: 'Unknown', detail: 'Not logged in (login page)' }
  }

  // ---- Trust-device interstitial: c_user is already set here (the page
  // literally says "You're logged in"), so without this check it would fall
  // through to Live below and every extraction step afterward would scrape
  // this blank screen instead of the real feed. Callers should resolve it
  // (resolveTrustDeviceScreen) before calling classifyPage, but this is kept
  // as a defensive check in case that ever changes. ----
  if (await isTrustDeviceScreen(page)) {
    return { status: 'Unknown', detail: 'Trust this device prompt not yet resolved' }
  }

  // ---- Live: home feed / profile reachable ----
  return { status: 'Live', detail: 'Session active' }
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

  // State 4: checkpoint / suspended — URL + an actual lock indicator.
  if (url.includes('/checkpoint/')) {
    if (is282LockText(body)) return { kind: 'checkpoint' }
    const lockCodeMatch = body.match(/\b(956|282)\b/)
    const lockedText = ACCOUNT_LOCKED_PATTERNS.some((p) => body.includes(p))
    if (lockCodeMatch || lockedText) return { kind: 'checkpoint' }
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

/** Exported for reuse by checkLiveDie (playwrightManager.ts), which also needs to refresh a session's saved cookie/token after a successful headless liveness check — not just after a full login run. */
export async function extractCookiesAndToken(
  context: BrowserContext
): Promise<{ cookie?: string; token?: string }> {
  try {
    const cookies = await context.cookies()
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
  'menu'
]

function looksLikeRealName(s: string | null | undefined): s is string {
  if (!s) return false
  const name = s.trim()
  if (name.length < 2 || name.length > 60) return false
  const lower = name.toLowerCase()
  return !NON_NAME_HINTS.some((h) => lower.includes(h))
}

/**
 * Best-effort extraction of the account's display name.
 *
 * The single most reliable source is the nav bar's link to the account's OWN
 * profile — `a[href*="profile.php?id={uid}"]` — whose text content is
 * exactly the display name Facebook shows for that account. This is scoped
 * to the account's own UID specifically so it can never pick up a friend's
 * name from an unrelated profile link elsewhere on the feed. Falls back to
 * the document title, then generic nav-bar selectors, if the UID link isn't
 * present (e.g. a vanity-username account with no numeric UID on file).
 */
async function extractProfileName(page: Page, uid?: string | null): Promise<string | undefined> {
  if (uid) {
    const ownProfileLink = page.locator(`a[href*="profile.php?id=${uid}"]`).first()
    const raw = await ownProfileLink.textContent().catch(() => null)
    if (looksLikeRealName(raw)) return raw.trim()
  }

  // Title form: "Saniyah Lopez • Facebook" or "Saniyah Lopez | Facebook".
  const title = await page.title().catch(() => '')
  const titleName = title.split(/[•|]/)[0]?.trim()
  if (looksLikeRealName(titleName)) return titleName

  for (const sel of PROFILE_NAME_SELECTORS) {
    const loc = page.locator(sel).first()
    const raw = await loc
      .getAttribute('aria-label')
      .catch(() => null)
      .then((v) => v ?? loc.textContent().catch(() => null))
    if (looksLikeRealName(raw)) return raw.trim()
  }
  return undefined
}

/**
 * The profile picture in the top nav bar. Facebook renders it either as a
 * plain `<img>` (mobile/lite UI, alt text mentioning "profile") or as an
 * `<image>` inside an inline `<svg>` (the "Your profile" nav icon on the
 * desktop UI, referenced via xlink:href/href rather than src).
 */
const AVATAR_IMG_SELECTORS = [
  '[aria-label="Your profile"] image',
  'div[role="banner"] svg image',
  'img[alt*="profile" i]',
  'div[role="navigation"] image'
]

/**
 * Best-effort extraction of the account's avatar URL from the top nav bar.
 * Reads `src` for a plain `<img>`, or `href`/`xlink:href` for an inline `<svg
 * image>` (Facebook's desktop nav renders the profile picture this way, not
 * as a real `<img>`). Never throws — a missing/changed selector just means no
 * avatar update.
 */
async function extractAvatarUrl(page: Page): Promise<string | undefined> {
  for (const sel of AVATAR_IMG_SELECTORS) {
    const loc = page.locator(sel).first()
    const url = await loc
      .getAttribute('src')
      .catch(() => null)
      .then((v) => v ?? loc.getAttribute('href').catch(() => null))
      .then((v) => v ?? loc.getAttribute('xlink:href').catch(() => null))
    if (url && /^https?:\/\//i.test(url)) return url
  }
  return undefined
}

/**
 * Download the avatar image from Facebook's CDN, re-encode it to a real JPEG
 * (Facebook serves some avatars as PNG — a mislabeled .jpg-named PNG file can
 * fail to open in strict viewers), and save it locally as `{uid}.jpg` under
 * userData/avatars. Uses the page's own request context (not a bare
 * main-process fetch) so the download goes through the same proxy the
 * account's browser session uses. Returns the local file path on success, or
 * undefined on any failure — never throws.
 */
async function downloadAvatarToFile(
  page: Page,
  uid: string | null | undefined,
  avatarUrl: string | undefined
): Promise<string | undefined> {
  if (!avatarUrl) return undefined
  try {
    const response = await page.context().request.get(avatarUrl, { timeout: 20000 })
    if (!response.ok()) return undefined
    const bytes = await response.body()
    const jpegBytes = await sharp(bytes).jpeg({ quality: 90 }).toBuffer()
    const filePath = avatarFilePath(uid)
    await writeFile(filePath, jpegBytes)
    return filePath
  } catch {
    return undefined
  }
}

export interface ProfileInfo {
  friendsCount?: number
}

/**
 * Best-effort extraction of friends count from the logged-in profile.
 * Navigates to /me and reads the counters. Never throws — leaves the field
 * undefined so the DB keeps its imported value. Always returns to the feed
 * so a subsequent warm-up scenario starts from a normal page.
 */
async function extractProfileInfo(page: Page, signal?: AbortSignal): Promise<ProfileInfo> {
  const info: ProfileInfo = {}
  try {
    await raceAbort(
      page.goto('https://www.facebook.com/me', { timeout: 20000, waitUntil: 'domcontentloaded' }),
      signal
    )
    await raceAbort(page.waitForTimeout(2500), signal)

    // If /me bounced to a review/checkpoint interstitial rather than the real
    // profile, skip friends scraping (the numbers there are noise).
    const url = page.url()
    const onProfile = !url.includes('/checkpoint/') && !url.includes('/confirm')
    const bodyText = (await page.locator('body').innerText().catch(() => '')) || ''

    if (onProfile) {
      // Friends count: require the number to actually contain a digit and sit
      // immediately before the word "friends" (avoids matching a stray ".").
      const friendsMatch = bodyText.match(/(\d[\d.,]*)\s*(?:friends|bạn bè)\b/i)
      if (friendsMatch) {
        const n = parseInt(friendsMatch[1].replace(/[.,]/g, ''), 10)
        if (Number.isFinite(n)) info.friendsCount = n
      }
    }
  } catch {
    /* best-effort — leave partial info */
  } finally {
    await page
      .goto('https://www.facebook.com/', { timeout: 20000, waitUntil: 'domcontentloaded' })
      .catch(() => void 0)
  }
  return info
}

/**
 * Extract the account's Primary Location from Facebook's own transparency
 * page (Settings > Your Information > Off-Facebook data has a sibling page
 * at /primary_location/info showing "Your primary location is near: <place>").
 * Confirmed working via live testing — this page reliably renders that exact
 * heading text for a logged-in session. Returns null gracefully on any
 * failure (blocked, redirected, or the text isn't present) rather than
 * throwing, since this is a best-effort enrichment, not a login requirement.
 */
async function extractPrimaryLocation(page: Page, signal?: AbortSignal): Promise<string | null> {
  try {
    await raceAbort(
      page.goto('https://web.facebook.com/primary_location/info', {
        timeout: 10000,
        waitUntil: 'domcontentloaded'
      }),
      signal
    )
    await raceAbort(
      page
        .locator('body')
        .getByText('Your primary location', { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .catch(() => void 0),
      signal
    )

    const bodyText = (await page.locator('body').innerText().catch(() => '')) || ''
    const match = bodyText.match(/Your primary location is near:\s*([^\n\r]+)/i)
    if (!match) return null

    const location = match[1].trim().replace(/\s+/g, ' ')
    return location || null
  } catch {
    return null
  } finally {
    await page
      .goto('https://web.facebook.com/', { timeout: 20000, waitUntil: 'domcontentloaded' })
      .catch(() => void 0)
  }
}

/**
 * Selectors for the account's own profile-name heading, tried in order.
 * `h1`/`div[role="main"] h1` are kept for accounts where Facebook does render
 * the name as a heading; the name-text span is the fallback that matches
 * this app's own live-tested DOM. The final xpath entry is UNVERIFIED against
 * this app's test accounts (the mount_0_0_* id it was captured from is a
 * React useId() value that is not stable across sessions — see the
 * "Last-resort" comments elsewhere in this file) and is kept only as a
 * best-effort attempt in case a different account/session renders it.
 */
function profileNameSelectors(
  page: Page,
  name: string | null | undefined
): ReturnType<Page['locator']>[] {
  const locators: ReturnType<Page['locator']>[] = []

  if (name) {
    // Exact-text match first — this is the one confirmed, via live testing
    // across multiple real accounts, to reliably hit the actual clickable
    // name element and open the dialog. getByText(exact: true) only matches
    // an element whose OWN normalized text equals the name exactly — unlike
    // :has-text(), which matches any ancestor whose text content merely
    // CONTAINS the name as a substring (a wrapping nav/sidebar container can
    // easily contain the name buried inside it, and :has-text() + .first()
    // would silently click that wrong element instead).
    locators.push(page.getByText(name, { exact: true }).first())
  }

  // Structural fallbacks — used when `name` is missing/wrong, or didn't
  // match anything. UNVERIFIED against a live account (Facebook's real page
  // has been observed rendering the visible name as a plain span, not an
  // h1 — the page's only actual <h1> was a hidden a11y "Notifications"
  // heading) — kept only as a best-effort attempt for layouts that do use a
  // real heading element, filtered so that decoy can never match.
  locators.push(
    page.locator('[data-pagelet="ProfileHeader"] h1').first(),
    page.locator('h1 span, [data-pagelet="ProfileHeader"] h1').first(),
    page.locator('div[role="main"] h1, h1').filter({ hasNotText: /^Notifications$/i }).first(),
    page.getByRole('heading', { level: 1 }).filter({ hasNotText: /^Notifications$/i }).first()
  )

  if (name) {
    const escaped = name.replace(/"/g, '\\"')
    locators.push(page.locator(`div[role="main"] span:has-text("${escaped}")`).first())
  }

  // Unverified last-resort fallback (mount id is a non-deterministic
  // React useId() value — kept only in case a different session renders it).
  locators.push(
    page
      .locator(
        'xpath=//*[contains(@id, "mount_0_0_")]/div[1]/div[1]/div[1]/div[3]/div[1]/div[1]/div[2]/div[1]/div[1]/div[1]/div[1]/div[2]/div[1]/div[1]/div[1]/div[2]/div[1]/div[1]/div[1]/div[1]/div[1]/div[1]/div[1]/div[1]/div[1]/div[1]/span[1]/div[1]'
      )
      .first()
  )

  return locators
}

/**
 * Extract the account's Facebook join/creation date by clicking the profile
 * name to open the "About this profile" transparency dialog, which shows a
 * "Joined Facebook: <date>" row. Confirmed working live: clicking the
 * visible name text (not the page's hidden a11y <h1>) opens a dialog titled
 * with the account name, containing "Joined Facebook: March 13, 2026" plus
 * unrelated rows below it (e.g. "Profile updated: N weeks ago") — the date
 * regex below is deliberately restricted to a single line so it can't run on
 * into those.
 */
async function extractCreatedDate(
  page: Page,
  uid: string | null | undefined,
  name: string | null | undefined,
  signal?: AbortSignal
): Promise<string | null> {
  if (!uid) return null
  try {
    await raceAbort(
      page.goto(`https://web.facebook.com/profile.php?id=${uid}`, {
        timeout: 12000,
        waitUntil: 'domcontentloaded'
      }),
      signal
    )
    await raceAbort(page.waitForTimeout(2000), signal)

    // Structural selectors (h1 / heading role / ProfileHeader) are tried
    // first regardless of `name` — this must keep working even when name
    // extraction itself failed or returned the wrong text, since bulk runs
    // can't assume a correct name is always available by this point.
    const nameHeading = await findFirstVisibleLocator(profileNameSelectors(page, name), 4000)
    if (!nameHeading) return null

    await raceAbort(nameHeading.click({ force: true, timeout: 5000 }).catch(() => void 0), signal)

    const dialog = page.locator('div[role="dialog"]').first()
    const dialogVisible = await dialog
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    if (!dialogVisible) return null

    // The dialog can render its frame before "Joined Facebook" itself has
    // hydrated in — wait for that specific text, not just the dialog shell,
    // so innerText() below isn't read too early and returns a false null.
    const joinedTextReady = await raceAbort(
      page
        .waitForSelector('div[role="dialog"] :text("Joined Facebook")', { timeout: 6000 })
        .then(() => true)
        .catch(() => false),
      signal
    )
    if (!joinedTextReady) {
      await raceAbort(page.keyboard.press('Escape').catch(() => void 0), signal)
      return null
    }

    const dialogText = (await dialog.innerText().catch(() => '')) || ''
    let match = dialogText.match(/Joined Facebook:\s*([^\n\r]+)/i)

    // Fallback: read the "Joined Facebook: <date>" row's own text node
    // directly rather than the whole dialog's innerText(). Kept as a second
    // attempt (not the primary path) since the xpath below is captured from
    // one real account's DOM snapshot and, like the other xpath fallback in
    // profileNameSelectors, isn't guaranteed stable across sessions/layouts.
    if (!match) {
      const rowText = await page
        .locator(
          'xpath=//*[contains(@id, "mount_0_0_")]/div[1]/div[1]/div[1]/div[4]/div[1]/div[1]/div[1]/div[1]/div[2]/div[1]/div[1]/div[1]/div[1]/div[1]/div[1]/div[2]/div[2]/div[1]/div[1]/div[2]/div[1]/div[1]/div[2]/div[1]/div[1]/div[1]/span[1]/span[1]'
        )
        .first()
        .innerText()
        .catch(() => null)
      if (rowText) match = rowText.match(/Joined Facebook:\s*([^\n\r]+)/i)
    }

    const result = match ? match[1].trim().replace(/\s+/g, ' ') : null

    // Close the dialog — Escape first, falling back to its own Close button.
    await raceAbort(page.keyboard.press('Escape').catch(() => void 0), signal)
    const stillOpen = await dialog.isVisible().catch(() => false)
    if (stillOpen) {
      const closeBtn = page.locator('div[role="dialog"] [aria-label="Close"]').first()
      await raceAbort(closeBtn.click({ timeout: 3000 }).catch(() => void 0), signal)
    }

    return result
  } catch {
    return null
  } finally {
    await page
      .goto('https://web.facebook.com/', { timeout: 20000, waitUntil: 'domcontentloaded' })
      .catch(() => void 0)
  }
}

export interface ScrapedProfileData {
  cookie?: string
  token?: string
  name?: string
  avatar?: string
  friendsCount?: number
  location?: string
  createdDate?: string
}

/**
 * Single entry point that runs the complete post-login profile-enrichment
 * sequence (cookies, name, avatar, primary location, created date) against
 * an already-authenticated page. Each step is independently best-effort —
 * one step failing (a selector miss, a slow/blocked page) never blocks or
 * throws past the ones after it, since none of this is required for the
 * login itself to count as successful. Steps that navigate away (location,
 * created date) always return to the feed afterward, so the page is left in
 * a consistent state for whatever runs next (a warm-up scenario, the next
 * account in the queue, etc.).
 */
async function extractAllMetadata(
  page: Page,
  context: BrowserContext,
  uid: string | null | undefined,
  signal?: AbortSignal
): Promise<ScrapedProfileData> {
  // STEP 1: cookies — read first, before any further navigation, so the
  // full set (c_user, xs, datr, fr, ...) reflects the freshly-landed feed.
  const { cookie, token } = await extractCookiesAndToken(context)

  // STEP 2: name — UID-scoped nav link first, falling back to document
  // title and generic nav selectors (see extractProfileName for the order).
  const name = await extractProfileName(page, uid)
  checkAborted(signal)

  // STEP 3: avatar — nav-bar/profile-header image URL, downloaded through
  // the page's own request context and re-encoded to a real JPEG.
  const avatarUrl = await extractAvatarUrl(page)
  const avatar = await downloadAvatarToFile(page, uid, avatarUrl)
  checkAborted(signal)

  const profileInfo = await extractProfileInfo(page, signal)
  checkAborted(signal)

  // Fast Mode (General Settings → Metadata Extraction Mode) skips the two
  // steps that each require a full navigation away from the feed and back —
  // primary_location/info, and clicking the profile heading to open the
  // "Joined Facebook" dialog — since those are the slowest, least essential
  // steps when running large batches and only Name + Cookies are needed.
  const fastMode = getAppSettings().metadataExtractionMode === 'fast'
  if (fastMode) {
    return { cookie, token, name, avatar, friendsCount: profileInfo.friendsCount }
  }

  // STEP 4: primary location — Facebook's own transparency page.
  const location = (await extractPrimaryLocation(page, signal)) ?? undefined
  checkAborted(signal)

  // STEP 5: created date — structural heading selectors so this keeps
  // working even if STEP 2 didn't resolve a name.
  const createdDate = (await extractCreatedDate(page, uid, name, signal)) ?? undefined
  checkAborted(signal)

  return {
    cookie,
    token,
    name,
    avatar,
    friendsCount: profileInfo.friendsCount,
    location,
    createdDate
  }
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
        if (options.onLoggedIn) {
          await options.onLoggedIn(page)
        }
      }

      const { cookie, token } =
        res.status === 'Live' ? metadata : await extractCookiesAndToken(context)
      return {
        success: res.status === 'Live',
        status: res.status,
        detail: res.status === 'Live' ? 'Login Success' : res.detail,
        cookie,
        token,
        avatar: metadata.avatar,
        name: metadata.name,
        friendsCount: metadata.friendsCount,
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
    // login form). Close cleanly with status 'Changed Pass'. ----
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
    // upload), so the account is simply marked and the browser closed. Exit
    // cleanly without touching the 2FA state machine. ----
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
          // step and persist it as a Checkpoint with a descriptive note.
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

    const { cookie, token } =
      result.status === 'Live' ? metadata : await extractCookiesAndToken(context)

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
      avatar: metadata.avatar,
      token,
      name: metadata.name,
      friendsCount: metadata.friendsCount,
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
    untrackContext(trackKey)
    // Always close once a final status has been determined — a lingering
    // browser window per finished account is a zombie-window leak, headed or
    // not. (Single-account "Open Profile" is a separate, deliberately-kept-
    // open flow in playwrightManager.ts and does not go through here.)
    await context?.close().catch(() => void 0)
  }
}
