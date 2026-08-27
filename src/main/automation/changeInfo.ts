// ---------------------------------------------------------------------------
// changeInfo.ts  — Batch Change Info: password / bio / avatar / 2FA.
// Each sub-operation is independent and best-effort — a failure in one
// doesn't block the others from running for the same account.
// ---------------------------------------------------------------------------
import { unlinkSync } from 'fs'
import { randomBytes } from 'crypto'
import type { Page } from 'playwright'
import type { Account } from '../../types/account'
import { launchContext, trackContext, untrackContext } from './browserContext'
import { pickRandomUnusedImage } from '../utils/imageFolder'
import { pickSpinText } from '../utils/pickSpinText'
import { generateTOTP } from './totp'

/** One "About" field's pipe-delimited alternatives, e.g. "Washington|New York|Houston". */
export interface AboutFieldOption {
  template: string
}

export interface UpdateAboutOptions {
  bio?: AboutFieldOption
  work?: AboutFieldOption
  currentCity?: AboutFieldOption
  hometown?: AboutFieldOption
  highSchool?: AboutFieldOption
  /** Skip a field entirely if the profile already shows a non-empty value for it. */
  skipIfAlreadySet?: boolean
}

export interface ImagePickOptions {
  folderPath: string
  /** Skip this account entirely if it already has a custom photo (not the default silhouette/no cover). */
  skipIfExists?: boolean
  /** Delete the source file from disk after a confirmed-successful upload. */
  deleteUsedImage?: boolean
}

export interface ChangeInfoOptions {
  changePassword?: { pattern?: string } // pattern e.g. "Aa1!XXXXXXXX"; omitted => fully random
  updateAbout?: UpdateAboutOptions
  changeAvatar?: ImagePickOptions
  changeCover?: ImagePickOptions
  enable2FA?: boolean
  signal?: AbortSignal
  onProgress?: (label: string) => void
}

export interface ChangeInfoResult {
  success: boolean
  detail: string
  newPassword?: string
  newBio?: string
  newWork?: string
  newCurrentCity?: string
  newHometown?: string
  newHighSchool?: string
  newAvatarPath?: string
  newCoverPath?: string
  new2FASecret?: string
  errors: string[]
}

class AbortedError extends Error {
  constructor() {
    super('Aborted by user')
    this.name = 'AbortedError'
  }
}
function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError()
}
function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new AbortedError())
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

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

// ---------------------------------------------------------------------------
// Password generation
// ---------------------------------------------------------------------------

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const DIGITS = '23456789'
const SYMBOLS = '!@#$%&*'

/**
 * Generate a random password. If `pattern` is given, each 'X' in it is
 * replaced with a random alphanumeric+symbol character; otherwise a strong
 * 12-character password is generated from mixed character classes.
 */
export function generatePassword(pattern?: string): string {
  const all = UPPER + LOWER + DIGITS + SYMBOLS
  const randChar = (set: string): string => set[randomBytes(1)[0] % set.length]

  if (pattern && pattern.includes('X')) {
    return pattern.replace(/X/g, () => randChar(all))
  }

  const required = [randChar(UPPER), randChar(LOWER), randChar(DIGITS), randChar(SYMBOLS)]
  const rest = Array.from({ length: 8 }, () => randChar(all))
  const chars = [...required, ...rest]
  // Shuffle so the required classes aren't always in the same position.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

// ---------------------------------------------------------------------------
// Playwright sub-operations (best-effort, polymorphic selectors)
// ---------------------------------------------------------------------------

const ACCOUNT_CENTER_PASSWORD_URL =
  'https://accountscenter.facebook.com/password_and_security/password/change'
const SETTINGS_PASSWORD_URL = 'https://web.facebook.com/settings?tab=security&section=password'

async function changePasswordOnPage(
  page: Page,
  currentPassword: string,
  newPassword: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; detail: string }> {
  // Account Center is Facebook's newer, consolidated settings surface — try
  // it first, falling back to the classic web.facebook.com settings page if
  // this account isn't routed there (Account Center rollout is uneven).
  await raceAbort(
    page.goto(ACCOUNT_CENTER_PASSWORD_URL, { timeout: 45000, waitUntil: 'domcontentloaded' }),
    signal
  )
  await raceAbort(page.waitForTimeout(2000), signal)

  let currentField = await findFirstVisible(
    page,
    ['input[name="password_old"]', 'input[type="password"]'],
    4000
  )
  if (!currentField) {
    await raceAbort(
      page.goto(SETTINGS_PASSWORD_URL, { timeout: 45000, waitUntil: 'domcontentloaded' }),
      signal
    )
    await raceAbort(page.waitForTimeout(2000), signal)
    currentField = await findFirstVisible(
      page,
      ['input[name="password_old"]', 'input[type="password"]'],
      5000
    )
  }
  if (!currentField) return { ok: false, detail: 'Current password field not found' }
  await raceAbort(currentField.fill(currentPassword), signal)

  const newFields = page.locator(
    'input[name="password_new"], input[name="password_confirm"], input[type="password"]'
  )
  const count = await newFields.count().catch(() => 0)
  for (let i = 1; i < count; i++) {
    checkAborted(signal)
    await raceAbort(newFields.nth(i).fill(newPassword).catch(() => void 0), signal)
  }

  const saveBtn = await findFirstVisible(
    page,
    [
      'div[aria-label="Save Changes"][role="button"]',
      'button:has-text("Save Changes")',
      'div[role="button"]:has-text("Save")',
      'button:has-text("Save")',
      'button[type="submit"]'
    ],
    4000
  )
  if (!saveBtn) return { ok: false, detail: 'Save Changes button not found' }
  await raceAbort(saveBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(2000), signal)

  return { ok: true, detail: 'Password updated' }
}

/**
 * One About-page section this app can edit, and the real heading text
 * Facebook renders for it — these are NOT the same as the friendly UI
 * labels ("Current City" is Facebook's own "Lives in" section heading,
 * etc.). Only 'Bio' is confirmed live (scripts/test-changeinfo-live.ts);
 * the others follow the same structural pattern observed for Bio but are
 * unverified against a real account — if a heading text is wrong for a
 * given layout/locale, that field's updateAboutFieldOnPage call simply
 * reports "not found" rather than editing the wrong section.
 */
const ABOUT_SECTION_HEADINGS = {
  bio: 'Bio',
  work: 'Work',
  currentCity: 'Current city',
  hometown: 'Hometown',
  highSchool: 'High school'
} as const

type AboutSection = keyof typeof ABOUT_SECTION_HEADINGS

/**
 * Live-tested against a real account (scripts/test-changeinfo-live.ts) for
 * the Bio section: `/me/about?section=bio` redirects to a bio-less view (no
 * "Bio" section renders at all) — the real editor only appears on the plain
 * `/about` page. There, the edit trigger is an icon-only button (no visible
 * text) whose real aria-label is the lowercase `"Edit bio"` — checked here
 * case-sensitively, since Facebook does not capitalize the field name in
 * this label. The section can ALSO have its own "Edit audience for <bio
 * text>..." button rendered right next to it (once a value + privacy
 * setting are already saved) — confirmed live to break a naive "find any
 * [role="button"] N ancestor-levels up" fallback, since that audience
 * button appears earlier in DOM order and gets picked instead. The fallback
 * below filters explicitly for a button whose aria-label mentions "Edit"
 * without also mentioning "audience", to rule that specific decoy out.
 */
async function findSectionEditButton(
  page: Page,
  headingText: string
): Promise<ReturnType<Page['locator']> | null> {
  const explicit = await findFirstVisible(
    page,
    [
      `div[role="button"][aria-label="Edit ${headingText.toLowerCase()}"]`,
      `div[role="button"][aria-label="Add ${headingText.toLowerCase()}"]`,
      `div[role="button"]:has-text("Add ${headingText}")`,
      `div[role="button"]:has-text("Edit ${headingText}")`
    ],
    2500
  )
  if (explicit) return explicit

  // Fallback: any [role="button"] within the heading's ancestor container
  // whose aria-label contains "Edit" but not "audience" — rules out the
  // privacy/audience-selector button that sits alongside the real edit
  // trigger once a value is already saved.
  const scoped = page
    .locator(
      `xpath=//span[normalize-space(text())="${headingText}"]/ancestor::*[6]//*[@role="button"][contains(translate(@aria-label, "EDIT", "edit"), "edit") and not(contains(translate(@aria-label, "AUDIENCE", "audience"), "audience"))]`
    )
    .first()
  const visible = await scoped
    .waitFor({ state: 'visible', timeout: 2500 })
    .then(() => true)
    .catch(() => false)
  return visible ? scoped : null
}

/** Best-effort read of a section's CURRENT displayed value, for the "skip if already set" check. */
async function readSectionCurrentValue(page: Page, headingText: string): Promise<string> {
  const value = await page
    .locator(`xpath=//span[normalize-space(text())="${headingText}"]/ancestor::*[6]`)
    .first()
    .innerText()
    .catch(() => '')
  // Strip the heading itself and the trailing "Edit" label so what's left is
  // just the field's actual content (empty string if nothing is set).
  return value.replace(headingText, '').replace(/Edit\s*$/i, '').trim()
}

async function updateAboutFieldOnPage(
  page: Page,
  section: AboutSection,
  value: string,
  skipIfAlreadySet: boolean,
  signal?: AbortSignal
): Promise<{ ok: boolean; skipped?: boolean; detail: string }> {
  const headingText = ABOUT_SECTION_HEADINGS[section]

  if (skipIfAlreadySet) {
    const current = await readSectionCurrentValue(page, headingText)
    if (current) return { ok: true, skipped: true, detail: `Skipped — already set to "${current}"` }
  }

  const editBtn = await findSectionEditButton(page, headingText)
  if (!editBtn) return { ok: false, detail: `"${headingText}" edit button not found` }
  await raceAbort(editBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1000), signal)

  const textarea = await findFirstVisible(
    page,
    ['textarea', 'div[role="dialog"] div[contenteditable="true"]', 'div[contenteditable="true"]'],
    4000
  )
  if (!textarea) return { ok: false, detail: `"${headingText}" input field not found` }
  await raceAbort(textarea.click({ timeout: 3000 }).catch(() => void 0), signal)
  // Clear any existing text (select-all + delete) before typing the new
  // value — fill('') alone doesn't reliably clear a contenteditable div the
  // way it does a real <textarea>.
  await raceAbort(page.keyboard.press('Control+A').catch(() => void 0), signal)
  await raceAbort(page.keyboard.press('Delete').catch(() => void 0), signal)
  await raceAbort(page.keyboard.type(value, { delay: 30 }), signal)

  const saveBtn = await findFirstVisible(
    page,
    [
      'button:has-text("Save")',
      'div[role="button"]:has-text("Save")',
      'div[aria-label="Save"][role="button"]'
    ],
    4000
  )
  if (!saveBtn) return { ok: false, detail: `Save button not found after editing "${headingText}"` }
  await raceAbort(saveBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(2000), signal)

  return { ok: true, detail: `${headingText} updated` }
}

/**
 * Dismiss a stray cover-photo edit overlay via its Cancel button, if one is
 * open — a leftover from a previous session/action must not be mistaken for
 * the avatar-change flow this function is about to drive.
 */
async function dismissCoverPhotoOverlayIfPresent(page: Page, signal?: AbortSignal): Promise<void> {
  const cancelBtn = page
    .locator('div[aria-label="Cancel" i], div[role="button"]:has-text("Cancel")')
    .first()
  const present = await cancelBtn
    .waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true)
    .catch(() => false)
  if (present) {
    await raceAbort(cancelBtn.click({ timeout: 3000 }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(500), signal)
  }
}

/**
 * Full avatar-change flow, live-tested end-to-end against a real account
 * (scripts/test-changeinfo-live.ts) with two selector fixes discovered only
 * through that live run — both are DOM-order pitfalls that a plain CSS
 * selector list joined with commas can't avoid:
 *
 * 1. The avatar-actions trigger must be scoped to `div[role="main"]`. The
 *    top nav bar has its OWN unrelated `svg[aria-label="Your profile"]`
 *    icon; an unscoped selector list matches whichever element appears
 *    first in DOM order across the whole page, which was that nav icon —
 *    clicking it opened an unrelated popup with zero menu items.
 * 2. The file input must be scoped to the element whose aria-label ancestor
 *    is "Choose profile picture". The page always has FIVE hidden
 *    `<input type="file">` elements (Stories, feed composer, video upload,
 *    etc.), and `input[type="file"]` with `.first()` silently attaches the
 *    file to the WRONG one — setInputFiles() reports success but no crop
 *    dialog ever opens, because the browsing session was never actually
 *    initiated for that input.
 */
async function changeAvatarOnPage(
  page: Page,
  imagePath: string,
  skipIfExists: boolean,
  signal?: AbortSignal
): Promise<{ ok: boolean; skipped?: boolean; detail: string }> {
  await raceAbort(
    page.goto('https://web.facebook.com/me/', { timeout: 45000, waitUntil: 'domcontentloaded' }),
    signal
  )
  await raceAbort(page.waitForTimeout(3000), signal)

  await dismissCoverPhotoOverlayIfPresent(page, signal)

  const avatarTrigger = await findFirstVisible(
    page,
    [
      'div[role="main"] div[aria-label="Profile picture actions"]',
      'div[aria-label="Actions for your profile photo" i]',
      'div[aria-label="Open profile photo actions" i]',
      'div[role="main"] div[aria-label*="profile picture" i]',
      'div[aria-label="Update profile picture" i]'
    ],
    8000
  )
  if (!avatarTrigger) return { ok: false, detail: 'Avatar actions trigger not found' }
  await raceAbort(avatarTrigger.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1500), signal)

  if (skipIfExists) {
    // Facebook only shows a "Delete"/"Remove" option in this menu when a
    // real custom photo (not the default silhouette) is currently set —
    // used as the existence check since there's no simpler DOM signal.
    const removeOption = await findFirstVisible(
      page,
      ['div[role="menuitem"]:has-text("Delete")', 'div[role="menuitem"]:has-text("Remove")'],
      2000
    )
    if (removeOption) {
      await raceAbort(page.keyboard.press('Escape').catch(() => void 0), signal)
      return { ok: true, skipped: true, detail: 'Skipped — profile picture already set' }
    }
  }

  const chooseItem = await findFirstVisible(
    page,
    [
      'div[role="menuitem"]:has-text("Choose profile picture")',
      'div[role="menuitem"] span:has-text("Choose profile picture")',
      'div[role="menuitem"]:has-text("Update profile picture")'
    ],
    5000
  )
  if (!chooseItem) return { ok: false, detail: '"Choose profile picture" menu item not found' }
  await raceAbort(chooseItem.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(2000), signal)

  // "Choose profile picture" opens a further submenu with its own "Upload
  // Photo" option that must be clicked before the hidden file input becomes
  // the active target for the browsing session.
  const uploadOption = await findFirstVisible(
    page,
    [
      'div[role="menuitem"]:has-text("Upload photo")',
      'div[role="button"]:has-text("Upload Photo")',
      'div[role="button"]:has-text("Tải ảnh lên")'
    ],
    3000
  )
  if (uploadOption) {
    await raceAbort(uploadOption.click({ timeout: 3000, force: true }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(3000), signal)
  }

  const scopedInputs = page.locator('[aria-label="Choose profile picture"] input[type="file"]')
  const scopedCount = await scopedInputs.count().catch(() => 0)
  const fileInput = scopedCount > 0 ? scopedInputs.first() : page.locator('input[type="file"]').first()
  const present = await fileInput.count().then((c) => c > 0).catch(() => false)
  if (!present) return { ok: false, detail: 'File input not found' }
  await raceAbort(fileInput.setInputFiles(imagePath), signal)

  // Poll for the crop dialog rather than a flat wait — it can take a moment
  // to swap in after the file attaches.
  const cropDialog = page.locator('div[role="dialog"]:has-text("Crop photo")').first()
  const cropReady = await cropDialog
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false)
  if (!cropReady) return { ok: false, detail: 'Crop dialog never appeared after attaching file' }

  // Save/Done button scoped to the crop dialog specifically — an unscoped
  // `div[role="dialog"]` can also match an unrelated open dialog (e.g. the
  // Notifications panel) elsewhere on the page.
  const saveBtn = cropDialog
    .locator(
      ['div[aria-label="Save"]', 'button:has-text("Save")', 'div[role="button"]:has-text("Save")'].join(
        ', '
      )
    )
    .first()
  const saveVisible = await saveBtn
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  if (!saveVisible) return { ok: false, detail: 'Save button in crop dialog not found' }
  await raceAbort(saveBtn.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
  await raceAbort(
    cropDialog.waitFor({ state: 'detached', timeout: 15000 }).catch(() => void 0),
    signal
  )

  return { ok: true, detail: 'Avatar updated' }
}

/**
 * Cover-photo change flow. UNVERIFIED against a real account (unlike the
 * avatar flow above, which was live-tested and required two non-obvious
 * scoping fixes to work at all) — implemented per the requested selectors,
 * but Facebook's real cover-photo upload DOM may have the same kind of
 * hidden-decoy-element pitfalls the avatar flow did. If this reports
 * "not found" in practice, it needs the same live-test-and-fix treatment.
 */
async function changeCoverOnPage(
  page: Page,
  imagePath: string,
  skipIfExists: boolean,
  signal?: AbortSignal
): Promise<{ ok: boolean; skipped?: boolean; detail: string }> {
  await raceAbort(
    page.goto('https://web.facebook.com/me/', { timeout: 45000, waitUntil: 'domcontentloaded' }),
    signal
  )
  await raceAbort(page.waitForTimeout(3000), signal)

  if (skipIfExists) {
    const addCoverBtn = await findFirstVisible(
      page,
      ['div[role="button"]:has-text("Add cover photo")', 'div[aria-label="Add cover photo" i]'],
      2000
    )
    // "Add cover photo" only shows when there ISN'T one yet — its presence
    // means no cover photo is set; its absence means one already is.
    if (!addCoverBtn) return { ok: true, skipped: true, detail: 'Skipped — cover photo already set' }
  }

  const coverBtn = await findFirstVisible(
    page,
    [
      'div[aria-label*="cover photo" i]',
      'div[role="button"]:has-text("Add Cover Photo")',
      'div[role="button"]:has-text("Edit Cover Photo")'
    ],
    8000
  )
  if (!coverBtn) return { ok: false, detail: 'Cover photo button not found' }
  await raceAbort(coverBtn.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1500), signal)

  const uploadItem = await findFirstVisible(
    page,
    [
      'div[role="menuitem"]:has-text("Upload photo")',
      'div[role="button"]:has-text("Upload Photo")'
    ],
    5000
  )
  if (uploadItem) {
    await raceAbort(uploadItem.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(2000), signal)
  }

  const scopedInputs = page.locator('[aria-label*="cover photo" i] input[type="file"]')
  const scopedCount = await scopedInputs.count().catch(() => 0)
  const fileInput = scopedCount > 0 ? scopedInputs.first() : page.locator('input[type="file"]').first()
  const present = await fileInput.count().then((c) => c > 0).catch(() => false)
  if (!present) return { ok: false, detail: 'File input not found' }
  await raceAbort(fileInput.setInputFiles(imagePath), signal)
  await raceAbort(page.waitForTimeout(2500), signal)

  const saveBtn = await findFirstVisible(
    page,
    [
      'button:has-text("Save changes")',
      'div[role="button"]:has-text("Save changes")',
      'div[role="dialog"] button:has-text("Save")',
      'div[role="dialog"] div[role="button"]:has-text("Save")'
    ],
    8000
  )
  if (!saveBtn) return { ok: false, detail: 'Save changes button not found' }
  await raceAbort(saveBtn.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(3000), signal)

  return { ok: true, detail: 'Cover photo updated' }
}

const ACCOUNT_CENTER_2FA_URL = 'https://accountscenter.facebook.com/password_and_security/two_factor'

/**
 * If 2FA is currently active on this account, turn it off first — a reset
 * always disables before re-enabling, since Facebook only lets one 2FA
 * method be "pending setup" at a time. Confirms the disable with the
 * account's current password when prompted (Facebook's standard security
 * checkpoint for this action). UNVERIFIED against a real account with 2FA
 * already on — this app has not yet had a live account in that exact state
 * to test against; implemented per the requested flow, best-effort.
 */
async function disableExisting2FAIfActive(
  page: Page,
  currentPassword: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; wasActive: boolean; detail: string }> {
  await raceAbort(
    page.goto(ACCOUNT_CENTER_2FA_URL, { timeout: 45000, waitUntil: 'domcontentloaded' }),
    signal
  )
  await raceAbort(page.waitForTimeout(2500), signal)

  const turnOffBtn = await findFirstVisible(
    page,
    [
      'div[role="button"]:has-text("Turn off")',
      'div[role="button"]:has-text("Remove")',
      'button:has-text("Turn off")'
    ],
    4000
  )
  if (!turnOffBtn) {
    // No "Turn off" control visible — 2FA isn't currently active, nothing to disable.
    return { ok: true, wasActive: false, detail: '2FA was not active' }
  }

  await raceAbort(turnOffBtn.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1500), signal)

  // Confirmation dialog, possibly requiring the current password.
  const confirmBtn = await findFirstVisible(
    page,
    ['div[role="dialog"] div[role="button"]:has-text("Turn off")', 'button:has-text("Turn off")'],
    3000
  )
  const passwordField = await findFirstVisible(
    page,
    ['div[role="dialog"] input[type="password"]', 'input[type="password"]'],
    2000
  )
  if (passwordField && currentPassword) {
    await raceAbort(passwordField.fill(currentPassword).catch(() => void 0), signal)
  }
  const submitBtn = confirmBtn ?? (await findFirstVisible(page, ['button:has-text("Continue")', 'div[role="button"]:has-text("Continue")'], 2000))
  if (submitBtn) {
    await raceAbort(submitBtn.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(2000), signal)
  }

  return { ok: true, wasActive: true, detail: '2FA disabled' }
}

/**
 * Full 2FA reset/setup: disable any currently-active 2FA, then walk through
 * enabling an authentication-app 2FA method, extract the Base32 secret
 * Facebook displays, generate the current 6-digit TOTP code from it locally
 * (totp.ts — no external app needed), submit that code back to Facebook to
 * confirm setup, and report the secret for the caller to persist.
 *
 * Only the disable step and the secret-extraction step have been observed
 * against this app's own earlier live testing; the final code-submit
 * confirmation step is implemented per spec but UNVERIFIED — if Facebook's
 * confirm-code screen uses different selectors, this reports a clear
 * failure detail rather than silently leaving 2FA half-configured.
 */
/**
 * Facebook's own anti-automation gate for this exact action — live-tested:
 * clicking through to a specific account's 2FA setup from an automated
 * session reliably shows "You can't make this change at the moment... This
 * is because we noticed you are using a device you don't usually use and we
 * need to keep your account safe." This is not a selector problem and there
 * is no selector fix for it — it's Facebook actively refusing the change
 * based on device-trust heuristics. Detected so the caller gets a clear,
 * honest failure instead of the flow silently stalling on a dead-end page.
 */
async function isDeviceTrustBlocked(page: Page): Promise<boolean> {
  const body = (await page.locator('body').innerText().catch(() => '')).toLowerCase()
  return body.includes("can't make this change at the moment") || body.includes('device you don\'t usually use')
}

async function enable2FAOnPage(
  page: Page,
  currentPassword: string,
  signal?: AbortSignal
): Promise<{ ok: boolean; secret?: string; detail: string }> {
  const disableResult = await disableExisting2FAIfActive(page, currentPassword, signal)
  if (!disableResult.ok) return { ok: false, detail: `Disable step failed: ${disableResult.detail}` }

  await raceAbort(
    page.goto(ACCOUNT_CENTER_2FA_URL, { timeout: 45000, waitUntil: 'domcontentloaded' }),
    signal
  )
  await raceAbort(page.waitForTimeout(2500), signal)

  if (await isDeviceTrustBlocked(page)) {
    return {
      ok: false,
      detail:
        "Facebook blocked this change: \"device you don't usually use\" — this is Facebook's own anti-automation security gate, not a selector issue. Complete 2FA setup manually from a recognized device/browser instead."
    }
  }

  // Account Center's 2FA page is a cross-app account picker, not the 2FA
  // settings directly — live-tested: it shows "Choose an account to set up
  // two-factor authentication" with one entry per linked account/app, and
  // the actual "Authentication app" option only appears after clicking
  // through to this specific account.
  const useAuthAppBtn = await findFirstVisible(
    page,
    [
      'div[role="button"]:has-text("Authentication app")',
      'div[role="button"]:has-text("Ứng dụng xác thực")'
    ],
    3000
  )
  if (!useAuthAppBtn) {
    // Not on the per-account page yet — click through the account picker's
    // only entry (this app only ever manages one Facebook account per
    // profile, so there is exactly one row to click).
    const accountRow = page.locator('[role="button"], a').filter({ hasText: /facebook/i }).first()
    const rowVisible = await accountRow
      .waitFor({ state: 'visible', timeout: 4000 })
      .then(() => true)
      .catch(() => false)
    if (rowVisible) {
      await raceAbort(accountRow.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
      await raceAbort(page.waitForTimeout(2500), signal)
    }

    if (await isDeviceTrustBlocked(page)) {
      return {
        ok: false,
        detail:
          "Facebook blocked this change: \"device you don't usually use\" — this is Facebook's own anti-automation security gate, not a selector issue. Complete 2FA setup manually from a recognized device/browser instead."
      }
    }
  }

  const useAuthAppBtn2 =
    useAuthAppBtn ??
    (await findFirstVisible(
      page,
      [
        'div[role="button"]:has-text("Authentication app")',
        'div[role="button"]:has-text("Ứng dụng xác thực")'
      ],
      5000
    ))
  if (!useAuthAppBtn2) {
    return { ok: false, detail: '2FA setup entry point not found' }
  }
  await raceAbort(useAuthAppBtn2.click({ timeout: 5000 }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1500), signal)

  const nextBtn = await findFirstVisible(
    page,
    ['div[role="button"]:has-text("Next")', 'button:has-text("Next")'],
    3000
  )
  if (nextBtn) {
    await raceAbort(nextBtn.click({ timeout: 3000 }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(1500), signal)
  }

  const showSecretLink = await findFirstVisible(
    page,
    [
      'a:has-text("having trouble")',
      'div[role="button"]:has-text("Can\'t scan")',
      'div[role="button"]:has-text("Copy key")',
      'div[role="button"]:has-text("enter the code manually")'
    ],
    4000
  )
  if (showSecretLink) {
    await raceAbort(showSecretLink.click({ timeout: 3000 }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(1000), signal)
  }

  // The secret is normally rendered as a monospace Base32 code block on this step.
  const body = await page.content().catch(() => '')
  const match = body.match(/\b([A-Z2-7]{16,32})\b/)
  if (!match) {
    return { ok: false, detail: 'Could not locate the 2FA secret key on the page' }
  }
  const secret = match[1]

  const code = generateTOTP(secret)
  if (!code) {
    return { ok: false, secret, detail: 'Secret extracted but failed to generate a TOTP code from it' }
  }

  const codeInput = await findFirstVisible(
    page,
    ['input[name="approvals_code"]', 'input[type="text"]', 'input[type="tel"]'],
    4000
  )
  if (!codeInput) {
    return { ok: false, secret, detail: 'Secret extracted but code-confirmation input not found' }
  }
  await raceAbort(codeInput.fill(code).catch(() => void 0), signal)

  const confirmBtn = await findFirstVisible(
    page,
    [
      'div[role="button"]:has-text("Next")',
      'div[role="button"]:has-text("Confirm")',
      'button:has-text("Next")',
      'button:has-text("Confirm")'
    ],
    3000
  )
  if (!confirmBtn) {
    return { ok: false, secret, detail: 'Secret extracted but confirm button not found' }
  }
  await raceAbort(confirmBtn.click({ timeout: 5000, force: true }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(2500), signal)

  return { ok: true, secret, detail: '2FA reset and confirmed' }
}

/**
 * Run the selected batch-change operations for one account. Each enabled
 * operation runs independently; failures are collected in `errors` and don't
 * stop the remaining operations.
 */
export async function batchChangeInfo(
  account: Account,
  options: ChangeInfoOptions
): Promise<ChangeInfoResult> {
  const { changePassword, updateAbout, changeAvatar, changeCover, enable2FA, signal, onProgress } =
    options
  const progress = (label: string): void => onProgress?.(label)

  const trackKey = `changeinfo:${account.id}`
  // No explicit headless override — launchContext falls back to the
  // persisted General Settings Browser Mode. A hardcoded `true` here used to
  // silently ignore the "Headed" setting for every Change Info run.
  const context = await launchContext({ account })
  trackContext(trackKey, context)

  const errors: string[] = []
  let newPassword: string | undefined
  let newBio: string | undefined
  let newWork: string | undefined
  let newCurrentCity: string | undefined
  let newHometown: string | undefined
  let newHighSchool: string | undefined
  let newAvatarPath: string | undefined
  let newCoverPath: string | undefined
  let new2FASecret: string | undefined

  try {
    const page = context.pages()[0] ?? (await context.newPage())

    if (changePassword) {
      checkAborted(signal)
      progress('Changing password...')
      try {
        const generated = generatePassword(changePassword.pattern)
        const res = await changePasswordOnPage(page, account.password ?? '', generated, signal)
        if (res.ok) newPassword = generated
        else errors.push(`Password Failed: ${res.detail}`)
      } catch (err) {
        errors.push(`Password Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (updateAbout) {
      const skip = Boolean(updateAbout.skipIfAlreadySet)
      const fields: [AboutSection, AboutFieldOption | undefined, (v: string) => void][] = [
        ['bio', updateAbout.bio, (v) => (newBio = v)],
        ['work', updateAbout.work, (v) => (newWork = v)],
        ['currentCity', updateAbout.currentCity, (v) => (newCurrentCity = v)],
        ['hometown', updateAbout.hometown, (v) => (newHometown = v)],
        ['highSchool', updateAbout.highSchool, (v) => (newHighSchool = v)]
      ]
      // All five fields live on the same /me/about page — navigate once,
      // then edit whichever fields were requested in sequence.
      await raceAbort(
        page.goto('https://web.facebook.com/me/about', {
          timeout: 45000,
          waitUntil: 'domcontentloaded'
        }),
        signal
      )
      await raceAbort(page.waitForTimeout(3000), signal)

      for (const [section, option, setResult] of fields) {
        if (!option) continue
        checkAborted(signal)
        progress(`Updating ${ABOUT_SECTION_HEADINGS[section]}...`)
        try {
          const value = pickSpinText(option.template)
          const res = await updateAboutFieldOnPage(page, section, value, skip, signal)
          if (res.ok && !res.skipped) setResult(value)
          else if (!res.ok) errors.push(`${ABOUT_SECTION_HEADINGS[section]} Failed: ${res.detail}`)
        } catch (err) {
          errors.push(
            `${ABOUT_SECTION_HEADINGS[section]} Failed: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    }

    if (changeAvatar) {
      checkAborted(signal)
      progress('Changing avatar...')
      try {
        const picked = pickRandomUnusedImage(changeAvatar.folderPath, account.avatar, account.uid)
        if (!picked) {
          errors.push('Avatar Failed: No usable image found in folder')
        } else {
          const res = await changeAvatarOnPage(page, picked, Boolean(changeAvatar.skipIfExists), signal)
          if (res.ok && !res.skipped) {
            newAvatarPath = picked
            if (changeAvatar.deleteUsedImage) {
              try {
                unlinkSync(picked)
              } catch (err) {
                errors.push(
                  `Avatar: uploaded but failed to delete source file — ${err instanceof Error ? err.message : String(err)}`
                )
              }
            }
          } else if (!res.ok) {
            errors.push(`Avatar Failed: ${res.detail}`)
          }
        }
      } catch (err) {
        errors.push(`Avatar Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (changeCover) {
      checkAborted(signal)
      progress('Changing cover photo...')
      try {
        const picked = pickRandomUnusedImage(changeCover.folderPath, null, account.uid)
        if (!picked) {
          errors.push('Cover Photo Failed: No usable image found in folder')
        } else {
          const res = await changeCoverOnPage(page, picked, Boolean(changeCover.skipIfExists), signal)
          if (res.ok && !res.skipped) {
            newCoverPath = picked
            if (changeCover.deleteUsedImage) {
              try {
                unlinkSync(picked)
              } catch (err) {
                errors.push(
                  `Cover Photo: uploaded but failed to delete source file — ${err instanceof Error ? err.message : String(err)}`
                )
              }
            }
          } else if (!res.ok) {
            errors.push(`Cover Photo Failed: ${res.detail}`)
          }
        }
      } catch (err) {
        errors.push(`Cover Photo Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (enable2FA) {
      checkAborted(signal)
      progress('Resetting 2FA...')
      try {
        const res = await enable2FAOnPage(page, account.password ?? '', signal)
        if (res.ok) new2FASecret = res.secret
        else errors.push(`2FA Failed: ${res.detail}`)
      } catch (err) {
        errors.push(`2FA Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const changedSomething = Boolean(
      newPassword ||
        newBio ||
        newWork ||
        newCurrentCity ||
        newHometown ||
        newHighSchool ||
        newAvatarPath ||
        newCoverPath ||
        new2FASecret
    )
    progress(changedSomething ? 'Warm-up Completed' : 'Error')

    return {
      success: changedSomething,
      detail:
        errors.length === 0
          ? 'All requested changes applied'
          : `Completed with ${errors.length} error(s)`,
      newPassword,
      newBio,
      newWork,
      newCurrentCity,
      newHometown,
      newHighSchool,
      newAvatarPath,
      newCoverPath,
      new2FASecret,
      errors
    }
  } catch (err) {
    if (err instanceof AbortedError) {
      return { success: false, detail: 'Cancelled by user', errors: [...errors, 'Cancelled'] }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, detail: `Change Info error: ${message}`, errors: [...errors, message] }
  } finally {
    untrackContext(trackKey)
    await context.close().catch(() => void 0)
  }
}
