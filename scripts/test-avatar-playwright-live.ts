// ---------------------------------------------------------------------------
// scripts/test-avatar-playwright-live.ts  — standalone live test of avatar
// extraction via a real Playwright Chromium context, run outside Electron
// via `npx tsx scripts/test-avatar-playwright-live.ts` against UID
// 61579537703933's real persisted session/profile and saved cookie.
//
// Mirrors browserContext.ts's cookie-injection logic and stealth launch
// directly (rather than importing that file) because it calls Electron's
// `app`/`screen` APIs, which only resolve to real objects inside the
// Electron runtime — confirmed in this repo's existing
// scripts/test-actions-live.ts, same rationale. stealthEngine.ts has zero
// imports (pure content-script string builder), so it's imported directly.
//
// This is a one-off diagnostic script, not part of the app's build — it
// exists to answer: does routing the avatar fetch through a real, cookie-
// authenticated Playwright browser context (rather than a bare Node
// fetch()) get past whatever is blocking mbasic.facebook.com for this
// account (see the prior isolated fetch-based test's findings).
// ---------------------------------------------------------------------------
import { chromium, type Cookie } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'path'
import os from 'os'
import sharp from 'sharp'
import { writeFileSync } from 'fs'
import { buildStealthScript } from '../src/main/automation/stealthEngine'

const UID = '61579537703933'
const DB_PATH = join(os.homedir(), 'AppData', 'Roaming', 'fb-account-manager', 'data.sqlite')
const PROFILE_DIR = join(os.homedir(), 'AppData', 'Roaming', 'fb-account-manager', 'profiles', UID)
const OUT_FILE = join(__dirname, '..', '..', 'test_real_avatar.jpg')

function log(msg: string): void {
  console.log(`[LOG] ${msg}`)
}
function err(msg: string): void {
  console.error(`[ERROR] ${msg}`)
}

function getAccount(uid: string): { uid: string; cookie: string | null } {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const row = db.prepare('SELECT uid, cookie FROM accounts WHERE uid = ?').get(uid) as
    | { uid: string; cookie: string | null }
    | undefined
  db.close()
  if (!row) throw new Error(`No account found for uid ${uid}`)
  return row
}

// Identical logic to browserContext.ts's parseCookieString()/injectSavedCookies().
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
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: 'None'
    })
  }
  return cookies
}

const AVATAR_IMG_SELECTORS = [
  '[aria-label="Your profile"] image',
  'div[role="banner"] svg image',
  'img[alt*="profile" i]',
  'div[role="navigation"] image'
]

async function main(): Promise<void> {
  const account = getAccount(UID)
  log(`Loaded account uid=${account.uid}, cookie length=${account.cookie?.length ?? 0}`)
  if (!account.cookie) {
    err('No saved cookie — aborting.')
    process.exit(1)
  }

  log(`Launching stealth headless Chromium against persistent profile: ${PROFILE_DIR}`)
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: { width: 1366, height: 768 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--no-default-browser-check',
      '--window-size=1366,768'
    ]
  })

  await context.addInitScript(buildStealthScript({ languages: ['en-US', 'en'], profileSeed: UID }))

  log('Injecting saved cookies into context...')
  const cookies = parseCookieString(account.cookie)
  await context.addCookies(cookies)
  log(`Injected ${cookies.length} cookie(s).`)

  const page = context.pages()[0] ?? (await context.newPage())

  try {
    log('Navigating to https://www.facebook.com/me ...')
    const res = await page.goto('https://www.facebook.com/me', {
      timeout: 45000,
      waitUntil: 'domcontentloaded'
    })
    log(`Navigation status: ${res?.status()}, final URL: ${page.url()}`)
    await page.waitForTimeout(3000)

    const title = await page.title()
    log(`Page title: "${title}"`)

    let avatarUrl: string | undefined
    for (const sel of AVATAR_IMG_SELECTORS) {
      const loc = page.locator(sel).first()
      const count = await loc.count().catch(() => 0)
      log(`Selector "${sel}": ${count} match(es)`)
      if (count === 0) continue
      const url =
        (await loc.getAttribute('src').catch(() => null)) ??
        (await loc.getAttribute('href').catch(() => null)) ??
        (await loc.getAttribute('xlink:href').catch(() => null))
      if (url && /^https?:\/\//i.test(url)) {
        avatarUrl = url
        log(`  -> extracted URL via this selector: ${url}`)
        break
      }
    }

    if (!avatarUrl) {
      err('No avatar URL found via any selector. Dumping page HTML snippet for diagnosis...')
      const html = await page.content()
      writeFileSync(join(__dirname, '..', '..', 'test_me_page.html'), html)
      log(`Saved full page HTML (${html.length} bytes) to test_me_page.html for inspection.`)
      log(`Current URL: ${page.url()}`)
      process.exitCode = 1
      return
    }

    log(`\nReal scontent URL found: ${avatarUrl}`)
    const isRealPhoto = /scontent/i.test(avatarUrl) && !/silhouette|rsrc\.php/i.test(avatarUrl)
    log(`Looks like a real photo (not silhouette/rsrc.php): ${isRealPhoto}`)

    log('Fetching high-res image buffer via page.context().request.get()...')
    const imgRes = await page.context().request.get(avatarUrl, { timeout: 20000 })
    log(`Image fetch status: ${imgRes.status()}`)
    if (!imgRes.ok()) {
      err(`Image fetch failed: HTTP ${imgRes.status()}`)
      process.exitCode = 1
      return
    }
    const rawBuffer = await imgRes.body()
    log(`Downloaded ${rawBuffer.length} raw bytes.`)

    log('Processing with sharp: resize to fit 1080x1080, JPEG...')
    let jpeg = await sharp(rawBuffer)
      .resize(1080, 1080, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer()
    if (jpeg.length > 1024 * 1024) {
      for (const q of [80, 70, 60]) {
        jpeg = await sharp(rawBuffer)
          .resize(1080, 1080, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: q })
          .toBuffer()
        if (jpeg.length <= 1024 * 1024) break
      }
    }
    writeFileSync(OUT_FILE, jpeg)

    log('\n=== RESULT ===')
    log(`Extracted image URL: ${avatarUrl}`)
    log(`HTTP status: ${imgRes.status()}`)
    log(`Saved file path: ${OUT_FILE}`)
    log(`Saved file size: ${jpeg.length} bytes (${(jpeg.length / 1024).toFixed(1)} KB)`)
    log(`Under 1MB: ${jpeg.length < 1024 * 1024}`)
    log(`Appears to be a real photo: ${isRealPhoto}`)
  } finally {
    await context.close()
    log('Browser context closed.')
  }
}

main().catch((e) => {
  err(e instanceof Error ? e.stack ?? e.message : String(e))
  process.exit(1)
})
