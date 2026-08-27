// ---------------------------------------------------------------------------
// scripts/test-actions-live.ts  — standalone live test of the Auto Post and
// Auto Share composer/share-dialog flows, run outside Electron via
// `npx tsx scripts/test-actions-live.ts` against the first Live account's
// real persisted session.
//
// Mirrors the selector/flow logic in postActions.ts and shareActions.ts
// directly (rather than importing those files) because both import
// browserContext.ts, which calls Electron's `app`/`screen` APIs — those
// only resolve to real objects inside the Electron runtime, not under plain
// Node/tsx (confirmed: `require('electron')` here just returns a path
// string). This script uses Playwright's chromium.launchPersistentContext
// directly against the account's existing profile folder instead.
// ---------------------------------------------------------------------------
import { chromium, type Page } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import os from 'os'

const DB_PATH = join(os.homedir(), 'AppData', 'Roaming', 'fb-account-manager', 'data.sqlite')
const PROFILES_ROOT = join(os.homedir(), 'AppData', 'Roaming', 'fb-account-manager', 'profiles')

const TEST_POST_CONTENT = 'Testing automation status'
const TEST_SHARE_URL = process.argv[2] || ''

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

// ---- Test 1: Auto Post (mirrors postActions.ts's flow) --------------------
async function testAutoPost(page: Page): Promise<void> {
  log('--- TEST 1: Auto Post ---')
  await page.goto('https://web.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  const trigger = await findFirstVisible(
    page,
    [
      'div[role="button"]:has-text("What\'s on your mind")',
      '[aria-label="What\'s on your mind?"]',
      '[aria-label*="What\'s on your mind" i]',
      'div[role="region"] div[role="button"]'
    ],
    8000
  )
  if (!trigger) {
    err('Composer trigger not found — cannot test Auto Post.')
    return
  }
  await trigger.click({ timeout: 5000 })
  await page.waitForTimeout(1200)
  log('Composer opened.')

  const textbox = await findFirstVisible(
    page,
    [
      'div[role="dialog"] div[role="textbox"]',
      'div[role="dialog"] div[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]'
    ],
    6000
  )
  if (!textbox) {
    err('Composer textbox not found.')
    return
  }
  await textbox.click({ timeout: 3000 })
  await page.waitForTimeout(500)
  await page.keyboard.type(TEST_POST_CONTENT, { delay: 30 })
  log(`Typed test content: "${TEST_POST_CONTENT}"`)

  const postBtn = await findFirstVisible(
    page,
    ['div[role="dialog"] div[aria-label="Post"]', 'div[role="dialog"] div[role="button"]:has-text("Post")'],
    5000
  )
  if (!postBtn) {
    err('Post button not found — leaving composer open for manual inspection, not submitting.')
    return
  }
  log('Post button found. NOT clicking automatically in this test run — verify content looks correct, then this would call postBtn.click().')
}

// ---- Test 2: Auto Share (mirrors shareActions.ts's flow) -------------------
async function testAutoShare(page: Page): Promise<void> {
  log('--- TEST 2: Auto Share ---')
  if (!TEST_SHARE_URL) {
    log('No test share URL provided as argv[2] — skipping Auto Share test.')
    log('Usage: npx tsx scripts/test-actions-live.ts <https://web.facebook.com/.../posts/...>')
    return
  }

  await page.goto(TEST_SHARE_URL, { timeout: 45000, waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)

  const shareBtn = await findFirstVisible(
    page,
    [
      '[aria-label="Send this to friends or post it on your profile." i]',
      '[aria-label="Share" i]',
      'div[role="button"]:has-text("Share")'
    ],
    8000
  )
  if (!shareBtn) {
    err('Share button not found — cannot test Auto Share on this URL.')
    return
  }
  await shareBtn.click({ timeout: 5000 })
  await page.waitForTimeout(1200)
  log('Share menu opened.')

  const shareNow = await findFirstVisible(
    page,
    [
      'div[role="menuitem"]:has-text("Share now")',
      'div[role="menuitem"]:has-text("Share to Feed")',
      'div[role="button"]:has-text("Share now")',
      'div[role="button"]:has-text("Share to Feed")'
    ],
    5000
  )
  if (!shareNow) {
    err('"Share now" / "Share to Feed" option not found.')
    return
  }
  log('"Share now" option found. NOT clicking automatically in this test run to avoid an unwanted live share.')
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
    await testAutoPost(page)
    await testAutoShare(page)
    log('--- TEST 3: Execution summary ---')
    log('Both selector/flow checks completed without throwing. See [ERROR] lines above for anything that did not resolve.')
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
