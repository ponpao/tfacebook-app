// ---------------------------------------------------------------------------
// unlock282.ts  — dedicated engine for walking an account through Facebook's
// Checkpoint 282 (identity/liveness verification) flow using only material
// the account already has on file: its existing local avatar photo (never a
// generated/synthetic one) and a 2Captcha-solved answer for any image
// captcha shown. If no local avatar file exists, this aborts immediately
// rather than fabricating a photo to submit as the account holder's likeness.
// ---------------------------------------------------------------------------
import type { BrowserContext, Page } from 'playwright'
import type { Account } from '../../types/account'
import type { AppSettings } from '../../types/settings'
import { launchContext, trackContext, untrackContext, findLocalAvatarFile } from './browserContext'
import { solveImageCaptcha } from './twoCaptchaService'

export type Unlock282Status = 'Live' | 'Checkpoint'

export interface UnlockResult {
  success: boolean
  status: Unlock282Status
  notes: string
}

export type Unlock282ProgressFn = (detail: string) => void

const CHECKPOINT_URLS = [
  'https://web.facebook.com/checkpoint/',
  'https://m.facebook.com/checkpoint/'
]

async function findFirstVisible(
  page: Page,
  selectors: string[],
  timeoutMs = 3000
): Promise<ReturnType<Page['locator']> | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first()
    const visible = await loc
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false)
    if (visible) return loc
  }
  return null
}

function isOnCheckpointUrl(url: string): boolean {
  return url.includes('/checkpoint/')
}

/** Detects a captcha image on the current page, if present. */
async function findCaptchaImage(page: Page): Promise<ReturnType<Page['locator']> | null> {
  return findFirstVisible(
    page,
    ['img[src*="captcha" i]', 'img[alt*="captcha" i]', '.captcha img', '#captcha_wrapper img'],
    2500
  )
}

const CAPTCHA_INPUT_SELECTORS = [
  'input[name*="captcha" i]',
  'input[id*="captcha" i]',
  'input[type="text"]'
]

const CONTINUE_SELECTORS = [
  // Live-tested against a real Checkpoint 282 screen (scripts/test-unlock-
  // live.ts) — the actual Continue button on Facebook's checkpoint UI is a
  // div[role="button"], not a real <button>, so that must be tried first.
  'div[role="button"]:has-text("Continue")',
  'button:has-text("Continue")',
  '[aria-label="Continue"]',
  '[role="button"]:has-text("Continue")',
  'button:has-text("Submit")',
  '[role="button"]:has-text("Submit")',
  'button:has-text("Send")',
  '[role="button"]:has-text("Send")',
  'button[type="submit"]',
  'div[role="main"] div[role="button"]'
]

const REVIEW_SCREEN_PATTERNS = [
  'we received your information',
  'review in progress',
  'thanks for confirming',
  "we're reviewing"
]

/**
 * Facebook's actual liveness step for this checkpoint variant is a live
 * camera capture ("Confirm you're a real person with a video selfie" /
 * "Start video selfie") — confirmed via a live test run against a real
 * account (scripts/test-unlock-live.ts). There is no <input type="file">
 * at this step; it requires a real camera feed, so it cannot be satisfied
 * by attaching a static photo. This app does not attempt to fake a camera
 * feed — that step is reported and left for the account holder.
 */
const VIDEO_SELFIE_PATTERNS = ['video selfie', "confirm you're a real person"]

async function isVideoSelfieScreen(page: Page): Promise<boolean> {
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase()
  return VIDEO_SELFIE_PATTERNS.some((p) => body.includes(p))
}

/**
 * Solve and submit a captcha image if one is present on the current page.
 * No-op (returns true) if no captcha is showing — this step is conditional
 * per the spec, not every checkpoint flow shows one.
 */
async function resolveCaptchaIfPresent(
  page: Page,
  apiKey: string,
  progress: Unlock282ProgressFn
): Promise<{ ok: boolean; reason?: string }> {
  const captchaImg = await findCaptchaImage(page)
  if (!captchaImg) return { ok: true }

  if (!apiKey?.trim()) {
    return { ok: false, reason: 'Captcha shown but no 2Captcha API key is configured' }
  }

  progress('Solving 2Captcha...')

  const screenshot = await captchaImg.screenshot().catch(() => null)
  if (!screenshot) return { ok: false, reason: 'Failed to capture captcha image' }
  const base64 = screenshot.toString('base64')

  let solved: string
  try {
    solved = await solveImageCaptcha(apiKey, base64)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `2Captcha failed: ${message}` }
  }

  const input = await findFirstVisible(page, CAPTCHA_INPUT_SELECTORS, 3000)
  if (!input) return { ok: false, reason: 'Captcha input field not found' }
  await input.fill(solved).catch(() => void 0)

  const continueBtn = await findFirstVisible(page, CONTINUE_SELECTORS, 3000)
  if (continueBtn) {
    await continueBtn.click({ timeout: 5000 }).catch(() => void 0)
  }

  await page.waitForTimeout(4000)
  return { ok: true }
}

/**
 * Attach the account's existing local avatar to a file-upload step if one
 * is present. No-op (returns true) if no file input is showing.
 */
async function uploadAvatarIfPresent(
  page: Page,
  avatarPath: string,
  progress: Unlock282ProgressFn
): Promise<{ ok: boolean; reason?: string }> {
  const fileInput = await findFirstVisible(page, ['input[type="file"]'], 3000)
  if (!fileInput) return { ok: true }

  progress('Uploading local avatar image...')

  try {
    await fileInput.setInputFiles(avatarPath)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: `Failed to attach avatar file: ${message}` }
  }

  await page.waitForTimeout(1500)

  const continueBtn = await findFirstVisible(page, CONTINUE_SELECTORS, 3000)
  if (continueBtn) {
    await continueBtn.click({ timeout: 5000 }).catch(() => void 0)
  }

  return { ok: true }
}

/** Poll up to `timeoutMs` for a definitive outcome: back on the feed, or a review-pending screen. */
async function waitForOutcome(
  page: Page,
  timeoutMs = 10000
): Promise<'live' | 'review' | 'pending'> {
  const start = Date.now()
  for (;;) {
    const url = page.url()
    if (!isOnCheckpointUrl(url)) return 'live'

    const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase()
    if (REVIEW_SCREEN_PATTERNS.some((p) => body.includes(p))) return 'review'

    if (Date.now() - start >= timeoutMs) return 'pending'
    await page.waitForTimeout(1000)
  }
}

/**
 * Walk one account through Checkpoint 282 using only its existing local
 * avatar (never generated) and 2Captcha for any image captcha shown. Always
 * returns a result — never throws — so the caller can persist it even on
 * failure. The browser context is always closed before returning.
 */
export async function runUnlock282(
  account: Account,
  settings: AppSettings,
  progress: Unlock282ProgressFn = () => void 0
): Promise<UnlockResult> {
  // ---- STEP 1: verify a local avatar file actually exists. Never generate
  // one — an account with no photo on file simply can't be processed. ----
  const avatarPath = findLocalAvatarFile(account.uid)
  if (!avatarPath) {
    return {
      success: false,
      status: 'Checkpoint',
      notes: 'Unlock Failed: No local avatar found'
    }
  }

  const trackKey = `unlock282:${account.id}`
  let context: BrowserContext | null = null

  try {
    // ---- STEP 2: launch (stealth + proxy are applied automatically inside
    // launchContext) and navigate to the checkpoint flow. ----
    context = await launchContext({ headless: false, account })
    trackContext(trackKey, context)
    const page = context.pages()[0] ?? (await context.newPage())

    let landed = false
    for (const url of CHECKPOINT_URLS) {
      const ok = await page
        .goto(url, { timeout: 20000, waitUntil: 'domcontentloaded' })
        .then(() => true)
        .catch(() => false)
      if (ok) {
        landed = true
        break
      }
    }
    if (!landed) {
      return { success: false, status: 'Checkpoint', notes: 'Unlock Failed: Could not reach checkpoint page' }
    }

    // Redirected straight to the feed with no checkpoint step at all.
    if (!isOnCheckpointUrl(page.url())) {
      return { success: true, status: 'Live', notes: '282 Auto-Resolved' }
    }

    await page.waitForTimeout(2000)

    // The checkpoint landing page shows its own initial "Continue" before
    // the captcha/upload/selfie step is revealed — confirmed via a live test
    // run against a real account. Best-effort: absence isn't fatal, since
    // some sessions land directly on the next step.
    const initialContinue = await findFirstVisible(page, CONTINUE_SELECTORS, 8000)
    if (initialContinue) {
      await initialContinue.scrollIntoViewIfNeeded().catch(() => void 0)
      await page.waitForTimeout(500)
      await initialContinue.click({ force: true }).catch(() => void 0)
      await page.waitForTimeout(3000)
    }

    // ---- STEP 3: solve captcha if one is shown. ----
    const captchaResult = await resolveCaptchaIfPresent(page, settings.twoCaptchaApiKey, progress)
    if (!captchaResult.ok) {
      return { success: false, status: 'Checkpoint', notes: `Unlock Failed: ${captchaResult.reason}` }
    }

    // Facebook's identity step for this checkpoint variant can require a
    // live camera video selfie instead of a static photo upload — no
    // <input type="file"> exists in that case, and this app never attempts
    // to fake a camera feed. Detected and reported honestly rather than
    // silently timing out with a generic message.
    if (await isVideoSelfieScreen(page)) {
      return {
        success: false,
        status: 'Checkpoint',
        notes: 'Unlock Failed: Requires live video selfie (not automatable)'
      }
    }

    // ---- STEP 4: upload the existing local avatar if a file-upload step
    // is showing. ----
    const uploadResult = await uploadAvatarIfPresent(page, avatarPath, progress)
    if (!uploadResult.ok) {
      return { success: false, status: 'Checkpoint', notes: `Unlock Failed: ${uploadResult.reason}` }
    }

    // ---- STEP 5: evaluate the outcome. ----
    const outcome = await waitForOutcome(page, 10000)
    if (outcome === 'live') {
      return { success: true, status: 'Live', notes: '282 Unlocked' }
    }
    if (outcome === 'review') {
      return { success: false, status: 'Checkpoint', notes: '282 In Review' }
    }
    return { success: false, status: 'Checkpoint', notes: 'Unlock Failed: No confirmation within timeout' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, status: 'Checkpoint', notes: `Unlock Failed: ${message}` }
  } finally {
    untrackContext(trackKey)
    await context?.close().catch(() => void 0)
  }
}
