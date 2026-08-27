// ---------------------------------------------------------------------------
// scenarios.ts  — modular Facebook account "warm-up" / farming interactions.
// Each function operates on an already-logged-in Playwright Page and reports
// progress via the same ProgressFn used by autoLogin.ts, so the queue runner
// can surface live per-step status in the grid.
// ---------------------------------------------------------------------------
import type { Page } from 'playwright'
import { AbortedError } from './autoLogin'

export type { AbortedError }

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

/** Live progress callback: short label the grid's Activity Status column shows. */
export type ScenarioProgressFn = (label: string) => void

export interface ScenarioStepContext {
  page: Page
  signal?: AbortSignal
  onProgress?: ScenarioProgressFn
}

function report(ctx: ScenarioStepContext, label: string): void {
  ctx.onProgress?.(label)
}

// ---------------------------------------------------------------------------
// randomDelay — clean, abortable pause used between/within every action.
// ---------------------------------------------------------------------------
export async function randomDelay(
  ctx: ScenarioStepContext,
  minSeconds: number,
  maxSeconds: number
): Promise<void> {
  const seconds = minSeconds + Math.random() * Math.max(0, maxSeconds - minSeconds)
  const ms = Math.round(seconds * 1000)
  checkAborted(ctx.signal)
  await raceAbort(ctx.page.waitForTimeout(ms), ctx.signal)
}

// ---------------------------------------------------------------------------
// scrollNewsfeed — smooth variable-delta scrolling with reading pauses.
// ---------------------------------------------------------------------------
export async function scrollNewsfeed(
  ctx: ScenarioStepContext,
  durationSeconds: number
): Promise<void> {
  const { page, signal } = ctx
  checkAborted(signal)

  if (!page.url().includes('facebook.com')) {
    report(ctx, 'Scrolling Newsfeed — opening feed...')
    await raceAbort(
      page.goto('https://www.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' }),
      signal
    )
  }

  const endAt = Date.now() + durationSeconds * 1000
  let elapsed = 0
  while (Date.now() < endAt) {
    checkAborted(signal)
    elapsed = Math.round((durationSeconds * 1000 - (endAt - Date.now())) / 1000)
    report(ctx, `Scrolling Newsfeed (${elapsed}s/${durationSeconds}s)...`)

    // Variable-delta wheel scroll — mimics a human scanning posts.
    const delta = 250 + Math.random() * 500
    await raceAbort(
      page.mouse.wheel(0, delta).catch(() => void 0),
      signal
    )

    // Random "reading" pause between scrolls.
    await randomDelay(ctx, 2, 5)
  }
}

// ---------------------------------------------------------------------------
// likeRandomPosts — scan visible posts, click a handful of Like buttons.
// ---------------------------------------------------------------------------
const LIKE_BUTTON_SELECTORS = [
  '[aria-label*="Like"]:not([aria-label*="Unlike"])',
  '[aria-label*="Thích"]:not([aria-label*="Bỏ thích"])',
  'div[role="button"]:has-text("Like")',
  'div[role="button"]:has-text("Thích")'
]

export async function likeRandomPosts(
  ctx: ScenarioStepContext,
  count: number
): Promise<{ liked: number }> {
  const { page, signal } = ctx
  checkAborted(signal)
  report(ctx, `Liking post... (0/${count})`)

  let liked = 0
  let attempts = 0
  const maxAttempts = count * 6 // generous scroll budget to find enough posts

  while (liked < count && attempts < maxAttempts) {
    checkAborted(signal)
    attempts += 1

    const buttons = page.locator(LIKE_BUTTON_SELECTORS.join(', '))
    const total = await buttons.count().catch(() => 0)

    if (total === 0) {
      // Nothing visible yet — scroll to surface more posts and retry.
      await raceAbort(page.mouse.wheel(0, 400).catch(() => void 0), signal)
      await randomDelay(ctx, 1, 2)
      continue
    }

    const idx = Math.floor(Math.random() * total)
    const btn = buttons.nth(idx)

    const visible = await btn.isVisible().catch(() => false)
    if (!visible) {
      await btn.scrollIntoViewIfNeeded().catch(() => void 0)
      await randomDelay(ctx, 0.5, 1)
    }

    // Randomized probability — not every scanned post gets liked, like a
    // real user skimming past some.
    if (Math.random() < 0.6) {
      const clicked = await raceAbort(
        btn.click({ timeout: 4000 }).then(() => true).catch(() => false),
        signal
      )
      if (clicked) {
        liked += 1
        report(ctx, `Liking post... (${liked}/${count})`)
        await randomDelay(ctx, 1.5, 4)
      }
    } else {
      await raceAbort(page.mouse.wheel(0, 300).catch(() => void 0), signal)
      await randomDelay(ctx, 1, 2)
    }
  }

  return { liked }
}

// ---------------------------------------------------------------------------
// watchReelsOrVideos — Facebook Watch / Reels viewing with occasional
// unmute / next-video scrolling.
// ---------------------------------------------------------------------------
export async function watchReelsOrVideos(
  ctx: ScenarioStepContext,
  count: number,
  durationPerVideoSeconds: number
): Promise<void> {
  const { page, signal } = ctx
  checkAborted(signal)

  report(ctx, 'Watching Reels — opening...')
  await raceAbort(
    page
      .goto('https://www.facebook.com/reel/', { timeout: 45000, waitUntil: 'domcontentloaded' })
      .catch(() =>
        page.goto('https://www.facebook.com/watch/', {
          timeout: 45000,
          waitUntil: 'domcontentloaded'
        })
      ),
    signal
  )
  await randomDelay(ctx, 1.5, 3)

  for (let i = 1; i <= count; i++) {
    checkAborted(signal)
    const endAt = Date.now() + durationPerVideoSeconds * 1000

    // Occasionally unmute briefly, mimicking a curious viewer.
    if (Math.random() < 0.3) {
      const unmute = page
        .locator('[aria-label*="Unmute"], [aria-label*="Bật tiếng"]')
        .first()
      await raceAbort(unmute.click({ timeout: 2000 }).catch(() => void 0), signal)
    }

    while (Date.now() < endAt) {
      checkAborted(signal)
      const remaining = Math.max(0, Math.round((endAt - Date.now()) / 1000))
      report(ctx, `Watching Reels/Video ${i}/${count} (${durationPerVideoSeconds - remaining}s/${durationPerVideoSeconds}s)...`)
      await randomDelay(ctx, 1, 2)
    }

    // Move to the next video (arrow-down works for Reels; fallback to wheel).
    await raceAbort(page.keyboard.press('ArrowDown').catch(() => void 0), signal)
    await raceAbort(page.mouse.wheel(0, 600).catch(() => void 0), signal)
    await randomDelay(ctx, 0.5, 1.5)
  }
}

// ---------------------------------------------------------------------------
// viewStories — open the stories row, click through a few stories.
// ---------------------------------------------------------------------------
const STORY_TILE_SELECTORS = [
  '[aria-label="Create a story"] ~ div [role="button"]',
  'div[role="button"][aria-label*="story" i]',
  'a[href*="/stories/"]'
]
const NEXT_STORY_SELECTORS = [
  '[aria-label="Next"]',
  '[aria-label="Tiếp theo"]',
  'div[role="button"][aria-label*="Next" i]'
]

export async function viewStories(ctx: ScenarioStepContext, count: number): Promise<{ viewed: number }> {
  const { page, signal } = ctx
  checkAborted(signal)

  if (!page.url().replace(/\/$/, '').endsWith('facebook.com')) {
    report(ctx, 'View Stories — opening feed...')
    await raceAbort(
      page.goto('https://www.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' }),
      signal
    )
    await randomDelay(ctx, 1, 2)
  }

  const firstStory = await (async () => {
    for (const sel of STORY_TILE_SELECTORS) {
      const loc = page.locator(sel).first()
      const visible = await loc.isVisible().catch(() => false)
      if (visible) return loc
    }
    return null
  })()

  if (!firstStory) {
    report(ctx, 'View Stories — none found')
    return { viewed: 0 }
  }

  report(ctx, `Viewing stories... (0/${count})`)
  await raceAbort(firstStory.click({ timeout: 5000 }).catch(() => void 0), signal)
  await randomDelay(ctx, 1, 2)

  let viewed = 0
  for (let i = 0; i < count; i++) {
    checkAborted(signal)
    viewed += 1
    report(ctx, `Viewing stories... (${viewed}/${count})`)

    // Let the story "play" for a natural amount of time.
    const watchSeconds = 5 + Math.random() * 5
    await randomDelay(ctx, watchSeconds, watchSeconds)

    if (i < count - 1) {
      const next = page.locator(NEXT_STORY_SELECTORS.join(', ')).first()
      const hasNext = await next.isVisible().catch(() => false)
      if (!hasNext) break
      await raceAbort(next.click({ timeout: 3000 }).catch(() => void 0), signal)
    }
  }

  // Close the story viewer (Escape works on the standard overlay).
  await raceAbort(page.keyboard.press('Escape').catch(() => void 0), signal)

  return { viewed }
}
