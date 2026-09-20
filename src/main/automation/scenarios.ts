// ---------------------------------------------------------------------------
// scenarios.ts  — Facebook warm-up / farming interactions on an already
// logged-in Playwright Page. Browser View (desktop) and App View (m-site)
// use separate locators. Each step returns a verified result — success is
// only reported when the UI actually changed.
// ---------------------------------------------------------------------------
import type { Locator, Page } from 'playwright'
import { AbortedError, dismissFacebookAppPromotion } from './autoLogin'
import { getAppSettings } from '../db/settingsRepo'
import type { ScrollDirectionMode } from '../../types/scenario'

export type { AbortedError }

export type ScenarioProgressFn = (label: string) => void

export interface ScenarioStepContext {
  page: Page
  signal?: AbortSignal
  onProgress?: ScenarioProgressFn
  uid?: string
}

export interface ScenarioActionResult {
  success: boolean
  action: string
  reason?: string
  details?: Record<string, unknown>
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

function viewModeOf(): 'browser' | 'app' {
  return getAppSettings().viewMode === 'app' ? 'app' : 'browser'
}

function homeUrl(): string {
  return viewModeOf() === 'app' ? 'https://m.facebook.com/' : 'https://web.facebook.com/'
}

function tag(ctx: ScenarioStepContext): string {
  return `[Scenario][${ctx.uid || 'unknown'}]`
}

function report(ctx: ScenarioStepContext, label: string): void {
  ctx.onProgress?.(label)
}

function log(ctx: ScenarioStepContext, message: string): void {
  console.log(`${tag(ctx)} ${message}`)
}

async function pause(ctx: ScenarioStepContext, minSeconds: number, maxSeconds: number): Promise<void> {
  const lo = Math.min(minSeconds, maxSeconds)
  const hi = Math.max(minSeconds, maxSeconds)
  const ms = Math.round((lo + Math.random() * Math.max(0, hi - lo)) * 1000)
  checkAborted(ctx.signal)
  await raceAbort(ctx.page.waitForTimeout(ms), ctx.signal)
}

export async function randomDelay(
  ctx: ScenarioStepContext,
  minSeconds: number,
  maxSeconds: number
): Promise<ScenarioActionResult> {
  report(ctx, 'Random Delay...')
  await pause(ctx, minSeconds, maxSeconds)
  return { success: true, action: 'random_delay' }
}

export async function dismissKnownFacebookDialogs(page: Page): Promise<void> {
  await dismissFacebookAppPromotion(page).catch(() => false)
  try {
    await page.keyboard.press('Escape').catch(() => void 0)
    const closeBtn = page
      .locator(
        [
          'div[role="dialog"] [aria-label="Close"]',
          'div[role="dialog"] [aria-label="Not now"]',
          '[aria-label="Close"]',
          '[aria-label="Not now"]',
          '[role="button"]:has-text("Not now")',
          '[role="button"]:has-text("Close")'
        ].join(', ')
      )
      .first()
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 1200 }).catch(() => void 0)
    }
  } catch {
    /* best-effort */
  }
}

export async function isStoryViewer(page: Page): Promise<boolean> {
  const url = page.url()
  if (/\/stories\//i.test(url) || /story_fbid=/i.test(url)) return true
  const loc = page
    .locator(
      '[aria-label="Pause"], [aria-label="Next card"], [aria-label="Next story"], div[role="dialog"] [aria-label*="story" i]'
    )
    .first()
  return loc.isVisible().catch(() => false)
}

export async function isReelViewer(page: Page): Promise<boolean> {
  const url = page.url()
  if (/\/reel\//i.test(url) || /\/reels\//i.test(url) || /\/watch/i.test(url)) return true
  const video = page.locator('video').first()
  return video.isVisible().catch(() => false)
}

export async function isPhotoViewer(page: Page): Promise<boolean> {
  const url = page.url()
  if (/\/photo/i.test(url) || /fbid=/i.test(url) || /\/photos\//i.test(url)) return true
  const dialog = page.locator('div[role="dialog"] img, div[role="dialog"] [aria-label="Close"]').first()
  return dialog.isVisible().catch(() => false)
}

async function feedShellVisible(page: Page): Promise<boolean> {
  const loc = page
    .locator(
      [
        'div[role="feed"]',
        '[aria-label="News Feed"]',
        '[aria-label="Facebook Menu"]',
        'div[data-mcomponent]',
        '[aria-label="Create a post"]',
        'textarea[name="xhpc_message"]',
        '[aria-label="What\'s on your mind?"]'
      ].join(', ')
    )
    .first()
  return loc.isVisible().catch(() => false)
}

export async function ensureFeedReady(page: Page, signal?: AbortSignal): Promise<boolean> {
  checkAborted(signal)
  await dismissKnownFacebookDialogs(page)
  const url = page.url()
  const onFacebook = /facebook\.com/i.test(url)
  const inOverlay = await isStoryViewer(page) || await isReelViewer(page) || await isPhotoViewer(page)
  if (!onFacebook || inOverlay || /\/reel|\/stories|\/watch|\/photo/i.test(url)) {
    await raceAbort(
      page.goto(homeUrl(), { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => void 0),
      signal
    )
    await page.waitForTimeout(600)
  }
  await dismissKnownFacebookDialogs(page)
  await dismissFacebookAppPromotion(page).catch(() => false)
  return feedShellVisible(page)
}

export async function safeBackToFeed(page: Page, signal?: AbortSignal): Promise<void> {
  checkAborted(signal)
  for (let i = 0; i < 3; i++) {
    if (await feedShellVisible(page) && !(await isStoryViewer(page)) && !(await isPhotoViewer(page))) {
      if (!/\/reel|\/stories|\/watch|\/photo/i.test(page.url())) return
    }
    await page.keyboard.press('Escape').catch(() => void 0)
    const closeBtn = page
      .locator(
        '[aria-label="Close"], [aria-label="Back"], div[role="button"][aria-label="Back"], a[aria-label="Back"]'
      )
      .first()
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click({ timeout: 1500 }).catch(() => void 0)
    } else {
      await page.goBack({ timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => void 0)
    }
    await page.waitForTimeout(400)
  }
  if (!(await feedShellVisible(page)) || /\/reel|\/stories|\/watch|\/photo/i.test(page.url())) {
    await page.goto(homeUrl(), { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => void 0)
  }
  await dismissKnownFacebookDialogs(page)
}

function getFeedPostLocators(page: Page, mode: 'browser' | 'app'): Locator {
  if (mode === 'app') {
    return page.locator('article, div[data-mcomponent] article, div[role="article"]')
  }
  return page.locator('div[role="feed"] div[role="article"], div[role="article"]')
}

function likeButtonsOnPage(page: Page): Locator {
  return page.locator(
    [
      '[aria-label="Like"]',
      '[aria-label="Thích"]',
      '[aria-label="ចូលចិត្ត"]',
      '[aria-label="Like or react"]',
      'div[role="button"][aria-label="Like"]',
      'div[role="button"]:has-text("Like")',
      'div[role="button"]:has-text("Thích")',
      'span[role="button"]:has-text("Like")',
      '[data-sigil*="like"]',
      'div[role="button"] span:text-is("Like")',
      'div[role="button"] span:text-is("Thích")'
    ].join(', ')
  )
}

async function isAlreadyLiked(btn: Locator): Promise<boolean> {
  const pressed = await btn.getAttribute('aria-pressed').catch(() => null)
  if (pressed === 'true') return true
  const label = ((await btn.getAttribute('aria-label').catch(() => '')) || '').toLowerCase()
  if (/unlike|remove like|liked|bỏ thích|លែងចូលចិត្ត/.test(label)) return true
  return false
}

async function looksSponsored(post: Locator): Promise<boolean> {
  const text = ((await post.innerText().catch(() => '')) || '').slice(0, 400)
  return /sponsored|ឧបត្ថម្ភ|được tài trợ/i.test(text)
}

function getStoryLocators(page: Page, mode: 'browser' | 'app'): Locator {
  if (mode === 'app') {
    return page.locator(
      'a[href*="/stories/"]:not([href*="create"]), div[role="button"][aria-label*="story" i], div[data-mcomponent] a[href*="stories"]'
    )
  }
  return page.locator(
    'a[href*="/stories/"]:not([href*="create"]), div[role="button"][aria-label*="story" i]:not([aria-label*="Create" i])'
  )
}

function getReelLocators(page: Page, mode: 'browser' | 'app'): Locator {
  if (mode === 'app') {
    return page.locator('a[href*="/reel/"], a[href*="/reels/"], a[aria-label*="Reels" i]')
  }
  return page.locator('a[href*="/reel/"], a[aria-label*="Reels" i], a[href*="/watch/"]')
}

export async function scrollNewsfeed(
  ctx: ScenarioStepContext,
  durationSeconds: number,
  scrollMode: ScrollDirectionMode = 'down_and_up'
): Promise<ScenarioActionResult> {
  const { page, signal } = ctx
  checkAborted(signal)
  log(ctx, 'Scroll Newsfeed started')
  report(ctx, 'Scrolling Newsfeed...')
  const ready = await ensureFeedReady(page, signal)
  if (!ready) {
    log(ctx, 'Scroll Newsfeed skipped: feed not ready')
    return { success: false, action: 'scroll_newsfeed', reason: 'feed not ready' }
  }

  const startY = await page.evaluate(() => window.scrollY).catch(() => 0)
  let lastY = startY
  let moved = false
  const endAt = Date.now() + Math.max(2, durationSeconds) * 1000
  let ticks = 0
  while (Date.now() < endAt) {
    checkAborted(signal)
    ticks += 1
    const elapsed = Math.round((durationSeconds * 1000 - (endAt - Date.now())) / 1000)
    report(ctx, `Scrolling Newsfeed (${Math.max(0, elapsed)}s/${durationSeconds}s)...`)
    const vh = (await page.evaluate(() => window.innerHeight).catch(() => 700)) || 700
    const goDown =
      scrollMode === 'mostly_down' ? Math.random() > 0.08 : ticks % 5 !== 4 && Math.random() > 0.18
    const frac = goDown ? 0.45 + Math.random() * 0.7 : 0.12 + Math.random() * 0.22
    const delta = Math.round(vh * frac) * (goDown ? 1 : -1)
    await raceAbort(page.mouse.wheel(0, delta).catch(() => void 0), signal)
    await pause(ctx, goDown ? 1.2 : 0.8, goDown ? 3.2 : 1.8)
    const y = await page.evaluate(() => window.scrollY).catch(() => lastY)
    if (Math.abs(y - lastY) > 24) moved = true
    lastY = y
  }
  log(ctx, moved ? 'Scroll Newsfeed success' : 'Scroll Newsfeed failed: position unchanged')
  return {
    success: moved,
    action: 'scroll_newsfeed',
    reason: moved ? undefined : 'page scroll position did not change',
    details: { startY, endY: lastY }
  }
}

export async function likeRandomPosts(
  ctx: ScenarioStepContext,
  count: number
): Promise<ScenarioActionResult> {
  const { page, signal } = ctx
  checkAborted(signal)
  log(ctx, `Like posts started target=${count}`)
  report(ctx, `Liking post... (0/${count})`)
  await ensureFeedReady(page, signal)

  let liked = 0
  let already = 0
  let attempts = 0
  const maxAttempts = Math.max(8, count * 8)
  const seen = new Set<number>()

  while (liked + already < count && attempts < maxAttempts) {
    checkAborted(signal)
    attempts += 1
    const buttons = likeButtonsOnPage(page)
    const total = await buttons.count().catch(() => 0)
    if (total === 0) {
      await raceAbort(page.mouse.wheel(0, 420).catch(() => void 0), signal)
      await pause(ctx, 0.8, 1.6)
      continue
    }
    let picked: Locator | null = null
    for (let i = 0; i < total; i++) {
      if (seen.has(i)) continue
      const btn = buttons.nth(i)
      if (!(await btn.isVisible().catch(() => false))) continue
      const nearby = ((await btn.evaluate((el) => (el.closest('[role="article"]') as HTMLElement | null)?.innerText || el.parentElement?.innerText || '').catch(() => '')) || '').slice(0, 500)
      if (/sponsored|ឧបត្ថម្ភ|được tài trợ/i.test(nearby)) {
        seen.add(i)
        continue
      }
      seen.add(i)
      picked = btn
      break
    }
    if (!picked) {
      await raceAbort(page.mouse.wheel(0, 360).catch(() => void 0), signal)
      await pause(ctx, 0.6, 1.2)
      continue
    }
    await picked.scrollIntoViewIfNeeded().catch(() => void 0)
    if (await isAlreadyLiked(picked)) {
      already += 1
      report(ctx, `Liking post... (${liked}/${count}) already liked`)
      continue
    }
    const before = ((await picked.getAttribute('aria-label').catch(() => '')) || '').toLowerCase()
    await pause(ctx, 0.4, 1.1)
    const clicked = await raceAbort(picked.click({ timeout: 4000 }).then(() => true).catch(() => false), signal)
    if (!clicked) continue
    await pause(ctx, 0.6, 1.2)
    const after = ((await picked.getAttribute('aria-label').catch(() => '')) || '').toLowerCase()
    const unlikeVisible = await page
      .locator('[aria-label="Unlike"], [aria-label="Remove Like"], [aria-label="Bỏ thích"], [aria-pressed="true"]')
      .first()
      .isVisible()
      .catch(() => false)
    const verified = (await isAlreadyLiked(picked)) || unlikeVisible || (after !== before && /unlike|liked|remove/.test(after))
    if (verified) {
      liked += 1
      log(ctx, `Like post success ${liked}/${count}`)
      report(ctx, `Liking post... (${liked}/${count})`)
      await pause(ctx, 1.2, 2.8)
    }
  }

  const success = liked + already > 0
  if (!success) log(ctx, 'Like posts failed: no verified like')
  return {
    success,
    action: 'like_random_posts',
    reason: success ? undefined : 'no like control verified',
    details: { liked, already, attempts }
  }
}

export async function watchReelsOrVideos(
  ctx: ScenarioStepContext,
  count: number,
  durationPerVideoSeconds: number
): Promise<ScenarioActionResult> {
  const { page, signal } = ctx
  const mode = viewModeOf()
  checkAborted(signal)
  log(ctx, `Watch Reels started count=${count}`)
  report(ctx, 'Watching Reels — opening...')
  await ensureFeedReady(page, signal)

  const reelHome = mode === 'app' ? 'https://m.facebook.com/reel/' : 'https://www.facebook.com/reel/'
  let opened = false
  const tray = getReelLocators(page, mode).first()
  if (await tray.isVisible().catch(() => false)) {
    opened = await raceAbort(tray.click({ timeout: 4000 }).then(() => true).catch(() => false), signal)
  }
  if (!opened) {
    await raceAbort(page.goto(reelHome, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => void 0), signal)
  }
  await pause(ctx, 1.2, 2.2)
  if (!(await isReelViewer(page))) {
    log(ctx, 'Watch Reels skipped: viewer did not open')
    await safeBackToFeed(page, signal)
    return { success: false, action: 'watch_reels', reason: 'reel viewer did not open' }
  }

  let watched = 0
  for (let i = 1; i <= count; i++) {
    checkAborted(signal)
    if (!(await isReelViewer(page))) break
    watched += 1
    const endAt = Date.now() + Math.max(3, durationPerVideoSeconds) * 1000
    while (Date.now() < endAt) {
      checkAborted(signal)
      const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000))
      report(
        ctx,
        `Watching Reels/Video ${i}/${count} (${durationPerVideoSeconds - remaining}s/${durationPerVideoSeconds}s)...`
      )
      await pause(ctx, 1.0, 2.0)
    }
    if (i < count) {
      await raceAbort(page.keyboard.press('ArrowDown').catch(() => void 0), signal)
      await raceAbort(page.mouse.wheel(0, 640).catch(() => void 0), signal)
      await pause(ctx, 0.8, 1.6)
    }
  }
  await safeBackToFeed(page, signal)
  log(ctx, watched > 0 ? `Watch Reels success ${watched}/${count}` : 'Watch Reels failed')
  return {
    success: watched > 0,
    action: 'watch_reels',
    reason: watched > 0 ? undefined : 'no reel stayed open',
    details: { watched }
  }
}

export async function viewStories(
  ctx: ScenarioStepContext,
  count: number
): Promise<ScenarioActionResult> {
  const { page, signal } = ctx
  const mode = viewModeOf()
  checkAborted(signal)
  log(ctx, `View Stories started count=${count}`)
  report(ctx, 'View Stories — looking...')
  await ensureFeedReady(page, signal)

  const tiles = getStoryLocators(page, mode)
  const n = await tiles.count().catch(() => 0)
  let first: Locator | null = null
  for (let i = 0; i < Math.min(n, 12); i++) {
    const tile = tiles.nth(i)
    const label = ((await tile.getAttribute('aria-label').catch(() => '')) || '').toLowerCase()
    const href = ((await tile.getAttribute('href').catch(() => '')) || '').toLowerCase()
    if (/create/.test(label) || /create/.test(href)) continue
    if (await tile.isVisible().catch(() => false)) {
      first = tile
      break
    }
  }
  if (!first) {
    log(ctx, 'View Story skipped: no available story')
    report(ctx, 'View Stories — none found')
    return { success: false, action: 'view_stories', reason: 'no available story' }
  }

  await pause(ctx, 0.4, 1.0)
  const clicked = await raceAbort(first.click({ timeout: 5000 }).then(() => true).catch(() => false), signal)
  await pause(ctx, 1.0, 1.8)
  if (!clicked || !(await isStoryViewer(page))) {
    log(ctx, 'View Story skipped: viewer did not open')
    await safeBackToFeed(page, signal)
    return { success: false, action: 'view_stories', reason: 'story viewer did not open' }
  }

  let viewed = 0
  for (let i = 0; i < count; i++) {
    checkAborted(signal)
    if (!(await isStoryViewer(page))) break
    viewed += 1
    report(ctx, `Viewing stories... (${viewed}/${count})`)
    log(ctx, `View Story success ${viewed}/${count}`)
    await pause(ctx, 4, 8)
    if (i < count - 1) {
      const next = page
        .locator('[aria-label="Next"], [aria-label="Next card"], [aria-label="Tiếp theo"], [aria-label="បន្ទាប់"]')
        .first()
      if (await next.isVisible().catch(() => false)) {
        await raceAbort(next.click({ timeout: 2500 }).catch(() => void 0), signal)
      } else {
        await raceAbort(page.keyboard.press('ArrowRight').catch(() => void 0), signal)
      }
      await pause(ctx, 0.6, 1.2)
    }
  }
  await safeBackToFeed(page, signal)
  return {
    success: viewed > 0,
    action: 'view_stories',
    reason: viewed > 0 ? undefined : 'story closed immediately',
    details: { viewed }
  }
}

export async function viewPhotoPosts(
  ctx: ScenarioStepContext,
  count: number,
  durationSeconds: number
): Promise<ScenarioActionResult> {
  const { page, signal } = ctx
  const mode = viewModeOf()
  checkAborted(signal)
  log(ctx, `View Photo/Post started count=${count}`)
  report(ctx, 'View Photo / Post...')
  await ensureFeedReady(page, signal)

  let viewed = 0
  let attempts = 0
  const maxAttempts = Math.max(8, count * 6)
  while (viewed < count && attempts < maxAttempts) {
    checkAborted(signal)
    attempts += 1
    const posts = getFeedPostLocators(page, mode)
    const total = await posts.count().catch(() => 0)
    if (total === 0) {
      await raceAbort(page.mouse.wheel(0, 400).catch(() => void 0), signal)
      await pause(ctx, 0.7, 1.4)
      continue
    }
    const post = posts.nth(Math.min(total - 1, Math.floor(Math.random() * total)))
    if (await looksSponsored(post)) continue
    const img = post
      .locator(
        'a[href*="/photo"] img, a[href*="/photos"] img, a[href*="fbid="] img, a[href*="/photo"], a[href*="/photos/"], img[src*="scontent"]'
      )
      .first()
    if (!(await img.isVisible().catch(() => false))) {
      await raceAbort(page.mouse.wheel(0, 380).catch(() => void 0), signal)
      await pause(ctx, 0.5, 1.1)
      continue
    }
    const box = await img.boundingBox().catch(() => null)
    if (box && (box.width < 40 || box.height < 40)) continue
    await pause(ctx, 0.4, 1.0)
    const clicked = await raceAbort(img.click({ timeout: 4000 }).then(() => true).catch(() => false), signal)
    await pause(ctx, 0.8, 1.5)
    if (!clicked || !(await isPhotoViewer(page))) {
      await page.keyboard.press('Escape').catch(() => void 0)
      continue
    }
    viewed += 1
    log(ctx, `View Photo/Post success ${viewed}/${count}`)
    report(ctx, `View Photo / Post (${viewed}/${count})`)
    await pause(ctx, Math.max(2, durationSeconds * 0.8), Math.max(3, durationSeconds * 1.2))
    await safeBackToFeed(page, signal)
    await pause(ctx, 0.6, 1.4)
  }
  await safeBackToFeed(page, signal)
  if (viewed === 0) log(ctx, 'View Photo/Post skipped: no photo post opened')
  return {
    success: viewed > 0,
    action: 'view_photo_post',
    reason: viewed > 0 ? undefined : 'no photo/post viewer opened',
    details: { viewed, attempts }
  }
}

export async function visitProfile(
  ctx: ScenarioStepContext,
  durationSeconds: number
): Promise<ScenarioActionResult> {
  const { page, signal } = ctx
  const mode = viewModeOf()
  checkAborted(signal)
  log(ctx, 'Visit Profile started')
  report(ctx, 'Visit Profile...')
  await ensureFeedReady(page, signal)

  const profileUrl =
    mode === 'app'
      ? ctx.uid
        ? `https://m.facebook.com/profile.php?id=${ctx.uid}`
        : 'https://m.facebook.com/me'
      : 'https://web.facebook.com/me'
  const ownLink = page
    .locator(
      'a[href*="/me"]:not([href*="logout"]), a[aria-label="Your profile"], a[href*="profile.php?id="]'
    )
    .first()
  if (await ownLink.isVisible().catch(() => false) && mode !== 'app') {
    await raceAbort(ownLink.click({ timeout: 4000 }).catch(() => void 0), signal)
  } else {
    await raceAbort(page.goto(profileUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }).catch(() => void 0), signal)
  }
  await pause(ctx, 1.2, 2.2)
  const url = page.url()
  const loaded =
    /\/me(\/|$|\?)/i.test(url) ||
    /profile\.php\?id=/i.test(url) ||
    (ctx.uid ? url.includes(ctx.uid) : false) ||
    (await page.locator('h1, div[role="main"] [data-mcomponent], [aria-label*="profile" i]').first().isVisible().catch(() => false))
  if (!loaded) {
    log(ctx, 'Visit Profile failed: profile did not load')
    await safeBackToFeed(page, signal)
    return { success: false, action: 'visit_profile', reason: 'profile did not load' }
  }
  const endAt = Date.now() + Math.max(3, durationSeconds) * 1000
  while (Date.now() < endAt) {
    checkAborted(signal)
    const vh = (await page.evaluate(() => window.innerHeight).catch(() => 700)) || 700
    await raceAbort(page.mouse.wheel(0, Math.round(vh * (0.35 + Math.random() * 0.4))).catch(() => void 0), signal)
    await pause(ctx, 1.0, 2.2)
  }
  await safeBackToFeed(page, signal)
  log(ctx, 'Visit Profile success')
  return { success: true, action: 'visit_profile', details: { url } }
}
