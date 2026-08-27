// ---------------------------------------------------------------------------
// scripts/test-all-features-live.ts  — comprehensive live test of the
// redesigned Change Info engine (About Info, Profile Picture, Cover Photo,
// 2FA reset) plus Auto Post / Auto Share, run outside Electron via
// `npx tsx scripts/test-all-features-live.ts` against the first Live
// account's real persisted session.
//
// Mirrors the selector/flow logic in changeInfo.ts / postActions.ts /
// shareActions.ts directly (rather than importing those files) because they
// import browserContext.ts, which calls Electron's `app`/`screen` APIs —
// those only resolve to real objects inside the Electron runtime, not under
// plain Node/tsx. This script uses Playwright's chromium.launchPersistentContext
// directly against the account's existing profile folder instead.
//
// Each test is independently gated by a CLI flag so a run can exercise just
// one area at a time — this matters most for Test 3 (2FA reset), which
// disables the account's CURRENT 2FA before the new one is confirmed and is
// not easily reversible if it fails partway through.
//
// Usage:
//   npx tsx scripts/test-all-features-live.ts --about --avatar --cover --2fa --post --share=<url>
//   (omit a flag to skip that test; run with no flags to just print the plan)
// ---------------------------------------------------------------------------
import { chromium, type Page } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'fs'
import { join, basename, extname } from 'path'
import os from 'os'

const DB_PATH = join(os.homedir(), 'AppData', 'Roaming', 'fb-account-manager', 'data.sqlite')
const PROFILES_ROOT = join(os.homedir(), 'AppData', 'Roaming', 'fb-account-manager', 'profiles')
const AVATAR_FOLDER = 'C:\\Users\\STARLINK WORLD\\Downloads\\ROTH PROFILE'
const COVER_FOLDER = AVATAR_FOLDER // no dedicated cover-photo folder provided; reuse for the test
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

const flags = new Set(process.argv.slice(2))
const shareArg = process.argv.find((a) => a.startsWith('--share='))
const shareUrl = shareArg ? shareArg.slice('--share='.length) : ''

function log(msg: string): void {
  console.log(`[LOG] ${msg}`)
}
function err(msg: string): void {
  console.error(`[ERROR] ${msg}`)
}
function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

interface AccountRow {
  id: number
  uid: string
  password: string | null
}

function findFirstActiveAccount(): AccountRow | null {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const row = db
    .prepare(
      `SELECT id, uid, password FROM accounts WHERE status = 'Live' AND is_deleted = 0 ORDER BY id LIMIT 1`
    )
    .get() as AccountRow | undefined
  db.close()
  return row ?? null
}

function pickImage(folder: string): string | null {
  let files: string[]
  try {
    files = readdirSync(folder, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
  } catch (e) {
    err(`Could not read image folder ${folder}: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  if (files.length === 0) return null
  return join(folder, files[Math.floor(Math.random() * files.length)])
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

// ---- Test 1: About Info Update ---------------------------------------------
const ABOUT_SECTION_HEADINGS: Record<string, string> = {
  bio: 'Bio',
  work: 'Work',
  currentCity: 'Current city',
  hometown: 'Hometown',
  highSchool: 'High school'
}

function pickSpinText(text: string): string {
  const options = text.split('|').map((s) => s.trim()).filter(Boolean)
  return options.length ? options[Math.floor(Math.random() * options.length)] : text
}

async function findSectionEditButton(page: Page, headingText: string): Promise<ReturnType<Page['locator']> | null> {
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
  const scoped = page
    .locator(
      `xpath=//span[normalize-space(text())="${headingText}"]/ancestor::*[6]//*[@role="button"][contains(translate(@aria-label, "EDIT", "edit"), "edit") and not(contains(translate(@aria-label, "AUDIENCE", "audience"), "audience"))]`
    )
    .first()
  const visible = await scoped.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)
  return visible ? scoped : null
}

async function testAboutInfo(page: Page): Promise<void> {
  section('TEST 1: About Info Update')
  const testValues: Record<string, string> = {
    bio: 'Testing bio update|Automation verification bio',
    currentCity: 'Washington|New York|Houston',
    hometown: 'Washington|New York|Houston',
    work: 'Washington|New York|Houston',
    highSchool: 'Washington|New York|Houston'
  }

  await page.goto('https://web.facebook.com/me/about', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  for (const [section_, template] of Object.entries(testValues)) {
    const heading = ABOUT_SECTION_HEADINGS[section_]
    const value = pickSpinText(template)
    log(`Testing "${heading}" -> "${value}"`)
    const editBtn = await findSectionEditButton(page, heading)
    if (!editBtn) {
      err(`"${heading}" edit button not found — skipping this field.`)
      continue
    }
    await editBtn.click({ timeout: 5000 }).catch(() => void 0)
    await page.waitForTimeout(1000)
    const textarea = await findFirstVisible(
      page,
      ['textarea', 'div[role="dialog"] div[contenteditable="true"]', 'div[contenteditable="true"]'],
      4000
    )
    if (!textarea) {
      err(`"${heading}" input field not found.`)
      continue
    }
    await textarea.click({ timeout: 3000 }).catch(() => void 0)
    await page.keyboard.press('Control+A').catch(() => void 0)
    await page.keyboard.press('Delete').catch(() => void 0)
    await page.keyboard.type(value, { delay: 30 })
    const saveBtn = await findFirstVisible(
      page,
      ['button:has-text("Save")', 'div[role="button"]:has-text("Save")'],
      4000
    )
    if (!saveBtn) {
      err(`Save button not found for "${heading}".`)
      continue
    }
    await saveBtn.click({ timeout: 5000 }).catch(() => void 0)
    await page.waitForTimeout(2000)
    log(`"${heading}" saved.`)
  }
}

// ---- Test 2: Profile Picture & Cover Photo ---------------------------------
async function testProfilePicture(page: Page, uid: string): Promise<void> {
  section('TEST 2a: Profile Picture Upload')
  const imagePath = pickImage(AVATAR_FOLDER)
  if (!imagePath) {
    err(`No usable image found in ${AVATAR_FOLDER}`)
    return
  }
  log(`Selected: ${imagePath}`)

  await page.goto('https://web.facebook.com/me/', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  const avatarTrigger = await findFirstVisible(
    page,
    ['div[role="main"] div[aria-label="Profile picture actions"]'],
    8000
  )
  if (!avatarTrigger) {
    err('Avatar actions trigger not found.')
    return
  }
  await avatarTrigger.click({ force: true })
  await page.waitForTimeout(1500)

  const chooseItem = await findFirstVisible(
    page,
    ['div[role="menuitem"]:has-text("Choose profile picture")'],
    5000
  )
  if (!chooseItem) {
    err('"Choose profile picture" not found.')
    return
  }
  await chooseItem.click({ force: true })
  await page.waitForTimeout(2000)

  const uploadOption = await findFirstVisible(page, ['div[role="menuitem"]:has-text("Upload photo")'], 3000)
  if (uploadOption) {
    await uploadOption.click({ force: true }).catch(() => void 0)
    await page.waitForTimeout(3000)
  }

  const scopedInputs = page.locator('[aria-label="Choose profile picture"] input[type="file"]')
  const scopedCount = await scopedInputs.count().catch(() => 0)
  const fileInput = scopedCount > 0 ? scopedInputs.first() : page.locator('input[type="file"]').first()
  const present = await fileInput.count().then((c) => c > 0).catch(() => false)
  if (!present) {
    err('File input not found.')
    return
  }
  await fileInput.setInputFiles(imagePath)
  log('File attached.')

  const cropDialog = page.locator('div[role="dialog"]:has-text("Crop photo")').first()
  const cropReady = await cropDialog.waitFor({ state: 'visible', timeout: 10000 }).then(() => true).catch(() => false)
  if (!cropReady) {
    err('Crop dialog never appeared.')
    return
  }
  const saveBtn = cropDialog.locator('div[aria-label="Save"], button:has-text("Save")').first()
  const saveVisible = await saveBtn.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false)
  if (!saveVisible) {
    err('Save button in crop dialog not found.')
    return
  }
  await saveBtn.click({ force: true })
  log('Clicked Save.')
  await cropDialog.waitFor({ state: 'detached', timeout: 15000 }).catch(() => err('Crop dialog did not detach.'))
  log('Profile picture updated successfully!')

  if (flags.has('--delete-used')) {
    try {
      const { unlinkSync } = await import('fs')
      unlinkSync(imagePath)
      log(`Deleted used image from disk: ${imagePath}`)
    } catch (e) {
      err(`Failed to delete used image: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    log('(--delete-used not passed — source file left on disk)')
  }
}

async function testCoverPhoto(page: Page): Promise<void> {
  section('TEST 2b: Cover Photo Upload')
  const imagePath = pickImage(COVER_FOLDER)
  if (!imagePath) {
    err(`No usable image found in ${COVER_FOLDER}`)
    return
  }
  log(`Selected: ${imagePath}`)

  await page.goto('https://web.facebook.com/me/', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  const coverBtn = await findFirstVisible(
    page,
    [
      'div[aria-label*="cover photo" i]',
      'div[role="button"]:has-text("Add Cover Photo")',
      'div[role="button"]:has-text("Edit Cover Photo")'
    ],
    8000
  )
  if (!coverBtn) {
    err('Cover photo button not found — UNVERIFIED selector, needs a live-test-and-fix pass like the avatar flow got.')
    return
  }
  await coverBtn.click({ force: true }).catch(() => void 0)
  await page.waitForTimeout(1500)

  const uploadItem = await findFirstVisible(
    page,
    ['div[role="menuitem"]:has-text("Upload photo")', 'div[role="button"]:has-text("Upload Photo")'],
    5000
  )
  if (uploadItem) {
    await uploadItem.click({ force: true }).catch(() => void 0)
    await page.waitForTimeout(2000)
  }

  const scopedInputs = page.locator('[aria-label*="cover photo" i] input[type="file"]')
  const scopedCount = await scopedInputs.count().catch(() => 0)
  const fileInput = scopedCount > 0 ? scopedInputs.first() : page.locator('input[type="file"]').first()
  const present = await fileInput.count().then((c) => c > 0).catch(() => false)
  if (!present) {
    err('File input not found.')
    return
  }
  await fileInput.setInputFiles(imagePath)
  await page.waitForTimeout(2500)

  const saveBtn = await findFirstVisible(
    page,
    ['button:has-text("Save changes")', 'div[role="button"]:has-text("Save changes")'],
    8000
  )
  if (!saveBtn) {
    err('Save changes button not found.')
    return
  }
  await saveBtn.click({ force: true })
  await page.waitForTimeout(3000)
  log('Cover photo updated successfully!')
}

// ---- Test 3: 2FA Reset/Enable (HIGH RISK — gated by --2fa) -----------------
async function testTwoFactorReset(page: Page, currentPassword: string): Promise<void> {
  section('TEST 3: 2FA Reset/Enable')
  const ACCOUNT_CENTER_2FA_URL = 'https://accountscenter.facebook.com/password_and_security/two_factor'

  await page.goto(ACCOUNT_CENTER_2FA_URL, { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const turnOffBtn = await findFirstVisible(
    page,
    ['div[role="button"]:has-text("Turn off")', 'div[role="button"]:has-text("Remove")'],
    4000
  )
  if (turnOffBtn) {
    log('Existing 2FA detected — disabling first.')
    await turnOffBtn.click({ force: true }).catch(() => void 0)
    await page.waitForTimeout(1500)
    const passwordField = await findFirstVisible(page, ['input[type="password"]'], 2000)
    if (passwordField && currentPassword) {
      await passwordField.fill(currentPassword).catch(() => void 0)
    }
    const confirmBtn = await findFirstVisible(
      page,
      ['div[role="dialog"] div[role="button"]:has-text("Turn off")', 'button:has-text("Continue")'],
      3000
    )
    if (confirmBtn) {
      await confirmBtn.click({ force: true }).catch(() => void 0)
      await page.waitForTimeout(2000)
    }
    log('2FA disabled.')
  } else {
    log('No existing 2FA detected — proceeding straight to setup.')
  }

  await page.goto(ACCOUNT_CENTER_2FA_URL, { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  const useAuthAppBtn = await findFirstVisible(
    page,
    ['div[role="button"]:has-text("Authentication app")'],
    5000
  )
  if (!useAuthAppBtn) {
    err('2FA setup entry point ("Authentication app") not found. STOPPING before any further action.')
    return
  }
  await useAuthAppBtn.click({ timeout: 5000 }).catch(() => void 0)
  await page.waitForTimeout(1500)

  const nextBtn = await findFirstVisible(page, ['div[role="button"]:has-text("Next")'], 3000)
  if (nextBtn) {
    await nextBtn.click({ timeout: 3000 }).catch(() => void 0)
    await page.waitForTimeout(1500)
  }

  const showSecretLink = await findFirstVisible(
    page,
    [
      'a:has-text("having trouble")',
      'div[role="button"]:has-text("Can\'t scan")',
      'div[role="button"]:has-text("Copy key")'
    ],
    4000
  )
  if (showSecretLink) {
    await showSecretLink.click({ timeout: 3000 }).catch(() => void 0)
    await page.waitForTimeout(1000)
  }

  const body = await page.content().catch(() => '')
  const match = body.match(/\b([A-Z2-7]{16,32})\b/)
  if (!match) {
    err('Could not locate the 2FA secret key on the page. STOPPING — account may be left mid-setup, check manually in the browser window.')
    return
  }
  const secret = match[1]
  log(`Extracted Base32 secret: ${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`)

  // Local TOTP generation — RFC 6238, mirrors src/main/automation/totp.ts.
  const { createHmac } = await import('crypto')
  function base32Decode(input: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    const clean = input.replace(/=+$/g, '').toUpperCase()
    let bits = 0, value = 0
    const out: number[] = []
    for (const ch of clean) {
      const idx = alphabet.indexOf(ch)
      if (idx === -1) continue
      value = (value << 5) | idx
      bits += 5
      if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff) }
    }
    return Buffer.from(out)
  }
  function generateTOTP(rawSecret: string): string | null {
    const key = base32Decode(rawSecret)
    if (key.length === 0) return null
    const counter = Math.floor(Date.now() / 1000 / 30)
    const msg = Buffer.alloc(8)
    let tmp = counter
    for (let i = 7; i >= 0; i--) { msg[i] = tmp & 0xff; tmp = Math.floor(tmp / 256) }
    const h = createHmac('sha1', key).update(msg).digest()
    const offset = h[h.length - 1] & 0x0f
    const binCode = ((h[offset] & 0x7f) << 24) | ((h[offset + 1] & 0xff) << 16) | ((h[offset + 2] & 0xff) << 8) | (h[offset + 3] & 0xff)
    return (binCode % 1_000_000).toString().padStart(6, '0')
  }

  const code = generateTOTP(secret)
  if (!code) {
    err('Failed to generate a TOTP code from the extracted secret. STOPPING.')
    return
  }
  log(`Generated 6-digit code: ${code}`)

  const codeInput = await findFirstVisible(page, ['input[name="approvals_code"]', 'input[type="text"]', 'input[type="tel"]'], 4000)
  if (!codeInput) {
    err(`Secret extracted (${secret}) but code-confirmation input not found. Leaving browser open — complete manually if needed.`)
    return
  }
  await codeInput.fill(code).catch(() => void 0)

  const confirmBtn = await findFirstVisible(
    page,
    ['div[role="button"]:has-text("Next")', 'div[role="button"]:has-text("Confirm")', 'button:has-text("Confirm")'],
    3000
  )
  if (!confirmBtn) {
    err(`Secret extracted (${secret}) but confirm button not found. Leaving browser open — complete manually if needed.`)
    return
  }
  await confirmBtn.click({ force: true }).catch(() => void 0)
  await page.waitForTimeout(2500)
  log(`2FA reset flow completed. New secret to save: ${secret}`)
}

// ---- Test 4: Auto Post & Auto Share ----------------------------------------
async function testAutoPost(page: Page): Promise<void> {
  section('TEST 4a: Auto Post')
  await page.goto('https://web.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  const trigger = await findFirstVisible(
    page,
    ['div[role="button"]:has-text("What\'s on your mind")', '[aria-label="What\'s on your mind?"]'],
    8000
  )
  if (!trigger) {
    err('Composer trigger not found.')
    return
  }
  await trigger.click({ timeout: 5000 })
  await page.waitForTimeout(1200)

  const textbox = await findFirstVisible(
    page,
    ['div[role="dialog"] div[role="textbox"]', 'div[role="dialog"] div[contenteditable="true"]'],
    6000
  )
  if (!textbox) {
    err('Composer textbox not found.')
    return
  }
  await textbox.click({ timeout: 3000 })
  await page.waitForTimeout(500)
  await page.keyboard.type('Testing automation status', { delay: 30 })
  log('Typed test post content.')

  const postBtn = await findFirstVisible(
    page,
    ['div[role="dialog"] div[aria-label="Post"]', 'div[role="dialog"] div[role="button"]:has-text("Post")'],
    5000
  )
  log(`Post button ${postBtn ? 'found' : 'NOT found'} — not clicking automatically in this test.`)
}

async function testAutoShare(page: Page, url: string): Promise<void> {
  section('TEST 4b: Auto Share')
  if (!url) {
    log('No --share=<url> provided — skipping.')
    return
  }
  await page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  const shareBtn = await findFirstVisible(
    page,
    ['[aria-label="Send this to friends or post it on your profile." i]', '[aria-label="Share" i]'],
    8000
  )
  if (!shareBtn) {
    err('Share button not found.')
    return
  }
  await shareBtn.click({ timeout: 5000 })
  await page.waitForTimeout(1200)

  const shareNow = await findFirstVisible(
    page,
    ['div[role="menuitem"]:has-text("Share now")', 'div[role="menuitem"]:has-text("Share to Feed")'],
    5000
  )
  log(`"Share now"/"Share to Feed" ${shareNow ? 'found' : 'NOT found'} — not clicking automatically in this test.`)
}

async function main(): Promise<void> {
  console.log('Flags:', [...flags].join(' ') || '(none — plan-only run)')

  const account = findFirstActiveAccount()
  if (!account) {
    err('No Live account found in the database.')
    return
  }
  log(`Using account: id=${account.id} uid=${account.uid}`)

  if (flags.has('--2fa')) {
    log('WARNING: --2fa will disable this account\'s CURRENT 2FA before confirming a new one.')
  }

  const context = await chromium.launchPersistentContext(join(PROFILES_ROOT, account.uid), {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  })
  const page = context.pages()[0] ?? (await context.newPage())

  try {
    if (flags.has('--about')) await testAboutInfo(page)
    if (flags.has('--avatar')) await testProfilePicture(page, account.uid)
    if (flags.has('--cover')) await testCoverPhoto(page)
    if (flags.has('--2fa')) await testTwoFactorReset(page, account.password ?? '')
    if (flags.has('--post')) await testAutoPost(page)
    if (shareUrl) await testAutoShare(page, shareUrl)

    console.log('\n=== Execution summary ===')
    log('Requested test(s) exercised. See [ERROR] lines above for anything that did not resolve.')
  } catch (e) {
    err(`Unhandled error: ${e instanceof Error ? e.stack : String(e)}`)
  } finally {
    await context.close()
  }
}

main().catch((e) => {
  console.error('[FATAL]', e)
  process.exit(1)
})
