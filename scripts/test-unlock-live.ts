// ---------------------------------------------------------------------------
// scripts/test-unlock-live.ts  — standalone live test of the Checkpoint 282
// unlock flow, run outside Electron via `npx tsx scripts/test-unlock-live.ts`.
//
// Reads the 2Captcha API key from the real SQLite settings table using
// node:sqlite (not better-sqlite3 — that binary is compiled against
// Electron's Node ABI and fails to load under plain Node/tsx).
// ---------------------------------------------------------------------------
import { chromium } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import os from 'os'

const UID = process.argv[2] || '61582171741044'
const CHECKPOINT_URL =
  process.argv[3] || 'https://web.facebook.com/checkpoint/1501092823525282/'

const AVATAR_UNLOCK_DIR =
  'C:\\Users\\STARLINK WORLD\\Documents\\APP\\facebook account\\avatar_unlock'
const PROFILE_DIR = join(
  os.homedir(),
  'AppData',
  'Roaming',
  'fb-account-manager',
  'profiles',
  UID
)
const DB_PATH = join(os.homedir(), 'AppData', 'Roaming', 'fb-account-manager', 'data.sqlite')

function log(msg: string): void {
  console.log(`[LOG] ${msg}`)
}

/** Read the persisted 2Captcha API key straight from SQLite (read-only). */
function loadApiKey(): string {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const row = db.prepare("SELECT value FROM settings WHERE key = 'app.generalSettings'").get() as
      | { value: string }
      | undefined
    db.close()
    if (!row) return ''
    const settings = JSON.parse(row.value) as { twoCaptchaApiKey?: string }
    return settings.twoCaptchaApiKey ?? ''
  } catch (err) {
    log(`Could not read settings DB: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

/** ${dir}/${uid}.jpg or .png, falling back to any image file in the folder. */
function resolveAvatarPath(uid: string): string | null {
  const jpg = join(AVATAR_UNLOCK_DIR, `${uid}.jpg`)
  if (existsSync(jpg)) return jpg
  const png = join(AVATAR_UNLOCK_DIR, `${uid}.png`)
  if (existsSync(png)) return png

  if (!existsSync(AVATAR_UNLOCK_DIR)) return null
  const fallback = readdirSync(AVATAR_UNLOCK_DIR).find((f) => /\.(jpe?g|png)$/i.test(f))
  return fallback ? join(AVATAR_UNLOCK_DIR, fallback) : null
}

/** Minimal 2Captcha submit-then-poll client (mirrors twoCaptchaService.ts). */
async function solveImageCaptcha(apiKey: string, base64Image: string): Promise<string> {
  const submitRes = await fetch('https://2captcha.com/in.php', {
    method: 'POST',
    body: new URLSearchParams({ key: apiKey, json: '1', method: 'base64', body: base64Image })
  })
  const submitJson = (await submitRes.json()) as { status: number; request: string }
  if (submitJson.status !== 1) throw new Error(`2Captcha submit failed: ${submitJson.request}`)
  const captchaId = submitJson.request

  const start = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const res = await fetch(
      `https://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`
    )
    const json = (await res.json()) as { status: number; request: string }
    if (json.status === 1) return json.request
    if (json.request !== 'CAPCHA_NOT_READY') throw new Error(`2Captcha failed: ${json.request}`)
    if (Date.now() - start >= 120000) throw new Error('2Captcha timed out after 120s')
  }
}

async function main(): Promise<void> {
  log(`UID: ${UID}`)
  log(`Checkpoint URL: ${CHECKPOINT_URL}`)
  log(`Profile dir: ${PROFILE_DIR}`)

  if (!existsSync(PROFILE_DIR)) {
    log(`ABORT: no persisted profile directory found at ${PROFILE_DIR}`)
    return
  }

  const apiKey = loadApiKey()
  log(`2Captcha API key loaded: ${apiKey ? `${apiKey.slice(0, 6)}… (${apiKey.length} chars)` : '(none configured)'}`)

  const avatarPath = resolveAvatarPath(UID)
  log(`Avatar file resolved: ${avatarPath ?? '(none found in ' + AVATAR_UNLOCK_DIR + ')'}`)

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  })
  const page = context.pages()[0] ?? (await context.newPage())

  try {
    // ---- STEP 1: navigate ----
    log(`Navigating to checkpoint URL...`)
    await page.goto(CHECKPOINT_URL, { timeout: 20000, waitUntil: 'domcontentloaded' }).catch((e) => {
      log(`goto error: ${e.message}`)
    })
    await page.waitForTimeout(2000)
    log(`URL after navigation: ${page.url()}`)
    log(`Title after navigation: ${await page.title()}`)

    // ---- STEP 2: click Continue ----
    const continueBtn = page
      .locator(
        [
          'div[role="button"]:has-text("Continue")',
          'button:has-text("Continue")',
          '[aria-label="Continue"]',
          'div[role="main"] div[role="button"]'
        ].join(', ')
      )
      .first()

    const foundContinue = await continueBtn
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false)

    if (foundContinue) {
      await continueBtn.scrollIntoViewIfNeeded()
      await page.waitForTimeout(500)
      await continueBtn.click({ force: true })
      log('Clicked Continue button successfully.')
    } else {
      log('No "Continue" button found within 8s — checkpoint may already show captcha/upload, or is a different screen.')
    }

    await page.waitForTimeout(3000)
    log(`URL after Continue: ${page.url()}`)

    // ---- STEP 3: captcha or upload ----
    const captchaImg = page
      .locator('img[src*="captcha" i], img[alt*="captcha" i], .captcha img, #captcha_wrapper img')
      .first()
    const hasCaptcha = await captchaImg
      .waitFor({ state: 'visible', timeout: 2500 })
      .then(() => true)
      .catch(() => false)

    if (hasCaptcha) {
      log('Captcha image detected.')
      if (!apiKey) {
        log('ABORT: captcha present but no 2Captcha API key configured.')
      } else {
        const screenshot = await captchaImg.screenshot()
        log(`Captured captcha screenshot (${screenshot.length} bytes). Submitting to 2Captcha...`)
        try {
          const solved = await solveImageCaptcha(apiKey, screenshot.toString('base64'))
          log(`2Captcha solved: "${solved}"`)
          const input = page
            .locator('input[name*="captcha" i], input[id*="captcha" i], input[type="text"]')
            .first()
          await input.fill(solved)
          const submitBtn = page
            .locator('button:has-text("Continue"), [role="button"]:has-text("Continue"), button:has-text("Submit")')
            .first()
          await submitBtn.click({ timeout: 5000 }).catch(() => log('Could not click submit after captcha.'))
          log('Captcha answer submitted.')
        } catch (err) {
          log(`Captcha solve error: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } else {
      log('No captcha detected.')
    }

    const fileInput = page.locator('input[type="file"]').first()
    const hasFileInput = await fileInput
      .waitFor({ state: 'attached', timeout: 2500 })
      .then(() => true)
      .catch(() => false)

    if (hasFileInput) {
      log('File upload input detected.')
      if (!avatarPath) {
        log('ABORT: file upload present but no local avatar image available.')
      } else {
        await fileInput.setInputFiles(avatarPath)
        log(`Attached avatar file: ${avatarPath}`)
        await page.waitForTimeout(1500)
        const submitBtn = page
          .locator(
            'button:has-text("Continue"), [role="button"]:has-text("Continue"), button:has-text("Submit"), button:has-text("Send")'
          )
          .first()
        await submitBtn.click({ timeout: 5000 }).catch(() => log('Could not click submit after upload.'))
        log('Upload submitted.')
      }
    } else {
      log('No file upload input detected.')
    }

    // ---- STEP 4: final state ----
    await page.waitForTimeout(3000)
    log(`Final URL: ${page.url()}`)
    log(`Final title: ${await page.title()}`)
    const bodyText = await page.locator('body').innerText().catch(() => '')
    log(`Body text preview (first 400 chars): ${bodyText.slice(0, 400).replace(/\n+/g, ' | ')}`)
  } finally {
    await context.close()
  }
}

main().catch((err) => {
  console.error('[FATAL]', err)
  process.exit(1)
})
