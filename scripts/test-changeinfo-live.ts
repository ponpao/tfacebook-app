// ---------------------------------------------------------------------------
// scripts/test-changeinfo-live.ts  — standalone live test of the Update Bio
// and Change Avatar flows, run outside Electron via
// `npx tsx scripts/test-changeinfo-live.ts` against the first Live
// account's real persisted session.
//
// Mirrors the selector/flow logic in changeInfo.ts directly (rather than
// importing that file) because it imports browserContext.ts, which calls
// Electron's `app`/`screen` APIs — those only resolve to real objects
// inside the Electron runtime, not under plain Node/tsx. This script uses
// Playwright's chromium.launchPersistentContext directly against the
// account's existing profile folder instead.
// ---------------------------------------------------------------------------
import { chromium, type Page } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'fs'
import { join, basename, extname } from 'path'
import os from 'os'

const DB_PATH = join(os.homedir(), 'AppData', 'Roaming', 'fb-account-manager', 'data.sqlite')
const PROFILES_ROOT = join(os.homedir(), 'AppData', 'Roaming', 'fb-account-manager', 'profiles')
const AVATAR_FOLDER = 'C:\\Users\\STARLINK WORLD\\Downloads\\ROTH PROFILE'
const TEST_BIO_TEXT = 'welcome hi!'

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

function log(msg: string): void {
  console.log(`[LOG] ${msg}`)
}
function err(msg: string): void {
  console.error(`[ERROR] ${msg}`)
}

interface AccountRow {
  id: number
  uid: string
}

function findFirstActiveAccount(): AccountRow | null {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const row = db
    .prepare(`SELECT id, uid FROM accounts WHERE status = 'Live' AND is_deleted = 0 ORDER BY id LIMIT 1`)
    .get() as AccountRow | undefined
  db.close()
  return row ?? null
}

function pickAvatarImage(uid: string): string | null {
  let files: string[]
  try {
    files = readdirSync(AVATAR_FOLDER, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
  } catch (e) {
    err(`Could not read avatar folder: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
  if (files.length === 0) return null

  const matched = files.find((f) => basename(f, extname(f)) === uid)
  if (matched) return join(AVATAR_FOLDER, matched)

  return join(AVATAR_FOLDER, files[Math.floor(Math.random() * files.length)])
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

async function findBioEditButton(page: Page): Promise<ReturnType<Page['locator']> | null> {
  const explicit = await findFirstVisible(
    page,
    ['div[role="button"]:has-text("Add bio")', 'div[role="button"]:has-text("Edit bio")'],
    2500
  )
  if (explicit) return explicit
  const scoped = page
    .locator('xpath=//span[normalize-space(text())="Bio"]/ancestor::*[6]//*[@role="button"]')
    .first()
  const visible = await scoped.waitFor({ state: 'visible', timeout: 2500 }).then(() => true).catch(() => false)
  return visible ? scoped : null
}

// ---- Test 1: Update Bio ----------------------------------------------------
async function testUpdateBio(page: Page): Promise<void> {
  log('--- TEST 1: Update Bio ---')
  await page.goto('https://web.facebook.com/me/about', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  log(`URL: ${page.url()}`)

  const editBtn = await findBioEditButton(page)
  if (!editBtn) {
    err('Add/Edit bio button not found.')
    return
  }
  log('Add/Edit bio button found. Clicking...')
  await editBtn.click({ timeout: 5000 })
  await page.waitForTimeout(1000)

  const textarea = await findFirstVisible(page, ['textarea', 'div[contenteditable="true"]'], 4000)
  if (!textarea) {
    err('Bio textbox not found.')
    return
  }
  await textarea.click({ timeout: 3000 })
  await page.keyboard.press('Control+A').catch(() => void 0)
  await page.keyboard.press('Delete').catch(() => void 0)
  await page.keyboard.type(TEST_BIO_TEXT, { delay: 30 })
  log(`Typed bio: "${TEST_BIO_TEXT}"`)

  const saveBtn = await findFirstVisible(
    page,
    ['button:has-text("Save")', 'div[role="button"]:has-text("Save")'],
    4000
  )
  if (!saveBtn) {
    err('Save button not found.')
    return
  }
  await saveBtn.click({ timeout: 5000 })
  await page.waitForTimeout(2000)
  log('Bio save submitted.')
}

/** Dismiss a stray cover-photo edit overlay (e.g. left open from a previous run) via its Cancel button. */
async function dismissCoverPhotoOverlayIfPresent(page: Page): Promise<void> {
  const cancelBtn = page
    .locator('div[aria-label="Cancel" i], div[role="button"]:has-text("Cancel")')
    .first()
  const present = await cancelBtn
    .waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true)
    .catch(() => false)
  if (present) {
    log('Cover photo overlay detected — dismissing via Cancel.')
    await cancelBtn.click({ timeout: 3000 }).catch(() => void 0)
    await page.waitForTimeout(500)
  }
}

// ---- Test 2: Change Avatar --------------------------------------------------
async function testChangeAvatar(page: Page, uid: string): Promise<void> {
  log('--- TEST 2: Change Avatar ---')
  const imagePath = pickAvatarImage(uid)
  if (!imagePath) {
    err(`No usable image found in ${AVATAR_FOLDER}`)
    return
  }
  log(`Selected avatar image: ${imagePath}`)

  await page.goto('https://web.facebook.com/me/', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)

  await dismissCoverPhotoOverlayIfPresent(page)

  // Step 1: open the avatar (not cover photo) actions trigger. Tried in
  // priority order via findFirstVisible — a single joined CSS selector list
  // (`a, b, c`) matches whichever appears FIRST IN DOM ORDER, not first in
  // the list, and this page's nav bar has its own unrelated
  // `svg[aria-label="Your profile"]` icon that a joined selector matches
  // before ever reaching the real page-scoped trigger below (confirmed live
  // — the joined-selector version opened the wrong element, a nav popup
  // with zero menu items, instead of the avatar actions menu).
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
  if (!avatarTrigger) {
    err('Avatar actions trigger not found.')
    return
  }
  await avatarTrigger.click({ force: true })
  log('Opened profile photo menu.')
  await page.waitForTimeout(1500)

  // Step 2: click "Choose profile picture" in the popup menu.
  const chooseItem = page
    .locator(
      [
        'div[role="menuitem"]:has-text("Choose profile picture")',
        'div[role="menuitem"] span:has-text("Choose profile picture")',
        'div[role="menuitem"]:has-text("Update profile picture")'
      ].join(', ')
    )
    .first()
  const chooseVisible = await chooseItem
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false)
  if (!chooseVisible) {
    err('"Choose profile picture" menu item not found.')
    return
  }
  await chooseItem.click({ force: true })
  log('Clicked "Choose profile picture".')
  await page.waitForTimeout(2000)

  // "Choose profile picture" opens ANOTHER submenu (its own dialog) with an
  // "Upload photo" option that must be clicked before the hidden file input
  // becomes the active target — confirmed live: skipping this step lets
  // setInputFiles() "succeed" with no error, but no crop dialog ever opens
  // because the browsing/upload session was never actually initiated.
  const uploadPhoto = page
    .locator('div[role="menuitem"]:has-text("Upload photo"), div[role="button"]:has-text("Upload photo")')
    .first()
  const uploadVisible = await uploadPhoto
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (uploadVisible) {
    await uploadPhoto.click({ force: true }).catch(() => void 0)
    log('Clicked "Upload photo".')
    await page.waitForTimeout(3000)
  }

  // Step 3: attach the image file. Scoped to the "Choose profile picture"
  // menu's own ancestor — the page has FIVE hidden <input type="file">
  // elements (Stories, Feed composer, video upload, etc.), all invisible by
  // design, so `input[type="file"]` alone with .first() grabs an unrelated
  // one in DOM order rather than the one actually wired to this flow
  // (confirmed live: an unscoped pick silently "succeeded" but never opened
  // a crop dialog — the file just went nowhere).
  const scopedInputs = page.locator('[aria-label="Choose profile picture"] input[type="file"]')
  const scopedCount = await scopedInputs.count()
  const fileInput = scopedCount > 0 ? scopedInputs.first() : page.locator('input[type="file"]').first()
  const present = await fileInput.count().then((c) => c > 0).catch(() => false)
  if (!present) {
    err('File input not found.')
    return
  }
  await fileInput.setInputFiles(imagePath)
  log('Image file attached successfully.')

  // The crop dialog can take a moment to swap in after the file is attached
  // — poll for it explicitly instead of a single fixed wait, which is what
  // caused an intermittent false "Save button not found" (the crop dialog
  // hadn't replaced the picker dialog's content yet when the flat 2.5s wait
  // ran out).
  const cropReady = await page
    .locator('div[role="dialog"]:has-text("Crop photo")')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false)
  log(`Crop dialog appeared: ${cropReady}`)
  if (!cropReady) {
    const dialogTexts = await page
      .locator('div[role="dialog"]')
      .evaluateAll((els) => els.map((el) => el.textContent?.trim().slice(0, 120)))
      .catch(() => [])
    err(`Crop dialog never appeared. Current dialog texts: ${JSON.stringify(dialogTexts)}`)
    return
  }

  // Step 4: save & apply crop.
  // Scoped to the crop dialog specifically — an unscoped `div[role="dialog"]`
  // also matches the unrelated Notifications panel left open from earlier in
  // the session (confirmed live: the un-scoped detach-wait below picked that
  // one and timed out even though the actual Save click succeeded).
  const cropDialog = page.locator('div[role="dialog"]:has-text("Crop photo")').first()
  const saveBtn = cropDialog
    .locator(
      [
        'div[aria-label="Save"]',
        'button:has-text("Save")',
        'div[role="button"]:has-text("Save")'
      ].join(', ')
    )
    .first()
  const saveVisible = await saveBtn
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  if (!saveVisible) {
    err('Save button in crop dialog not found.')
    return
  }
  await saveBtn.click({ force: true })
  log('Clicked Save button.')
  await cropDialog
    .waitFor({ state: 'detached', timeout: 15000 })
    .catch((e) => err(`Crop dialog did not detach within timeout: ${e.message}`))
  log('Profile picture updated successfully!')
}

async function main(): Promise<void> {
  const account = findFirstActiveAccount()
  if (!account) {
    err('No Live account found in the database.')
    return
  }
  log(`Using account: id=${account.id} uid=${account.uid}`)

  const profileDir = join(PROFILES_ROOT, account.uid)
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  })
  const page = context.pages()[0] ?? (await context.newPage())

  try {
    const runBio = process.argv.includes('--bio')
    if (runBio) await testUpdateBio(page)
    await testChangeAvatar(page, account.uid)
    log('--- Execution summary ---')
    log('Flow(s) exercised. See [ERROR] lines above for anything that did not resolve.')
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
