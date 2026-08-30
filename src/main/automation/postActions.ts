// ---------------------------------------------------------------------------
// postActions.ts  — Auto Post: publish spun text (+ optional images) to the
// personal feed or a random selection of joined groups.
// ---------------------------------------------------------------------------
import type { Page } from 'playwright'
import type { Account } from '../../types/account'
import { launchContext, trackContext, untrackContext } from './browserContext'
import { parseSpinSyntax } from '../utils/spinSyntax'
import { verifyActiveSession } from './sessionGuard'

export type PostDestination = 'feed' | 'groups'

export interface AutoPostOptions {
  destination: PostDestination
  /** Raw template — spun independently for every post. */
  contentTemplate: string
  /** Absolute local file paths of images to attach (optional). */
  imagePaths?: string[]
  /** When destination = 'groups', post to at most this many joined groups. */
  groupCount?: number
  /** Seconds to wait between consecutive group posts. */
  delayMinSeconds?: number
  delayMaxSeconds?: number
  signal?: AbortSignal
  onProgress?: (label: string) => void
}

export interface AutoPostResult {
  success: boolean
  posted: number
  attempted: number
  detail: string
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
async function delay(page: Page, min: number, max: number, signal?: AbortSignal): Promise<void> {
  const seconds = min + Math.random() * Math.max(0, max - min)
  await raceAbort(page.waitForTimeout(Math.round(seconds * 1000)), signal)
}

// ---------------------------------------------------------------------------
// Polymorphic selectors — Facebook's composer DOM varies by locale/A-B test.
// Ordered most-specific-first; each list is tried top to bottom until one
// resolves to a visible element.
// ---------------------------------------------------------------------------
const COMPOSER_TRIGGER_SELECTORS = [
  'div[role="main"] div[role="button"]:has-text("What\'s on your mind")',
  'div[role="main"] div[role="button"]:has-text("Share a")',
  'div[role="main"] div[role="button"]:has-text("Create story")',
  'div[role="button"]:has-text("What\'s on your mind")',
  '[aria-label="What\'s on your mind?"]',
  '[aria-label*="What\'s on your mind" i]',
  '[aria-label*="Bạn đang nghĩ gì"]',
  'div[data-pagelet="ProfileComposer"] div[role="button"]',
  'div[data-pagelet="FeedUnit_0"] div[role="button"]',
  'div[role="region"] div[role="button"]',
  'div[role="main"] span:has-text("What\'s on your mind")',
  'div[role="button"]:has-text("Photo/video")',
  'div[aria-label="Create a post"]'
]
const COMPOSER_TEXTBOX_SELECTORS = [
  'div[role="dialog"] div[role="textbox"]',
  'div[role="dialog"] div[contenteditable="true"]',
  'div[role="dialog"] [aria-label*="What\'s on your mind" i]',
  'div[aria-label*="What\'s on your mind" i][contenteditable="true"]',
  'div[aria-label*="Bạn đang nghĩ gì"][contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]'
]
const PHOTO_BUTTON_SELECTORS = [
  'div[role="dialog"] div[aria-label="Photo/video"]',
  'div[role="dialog"] div[role="button"]:has-text("Photo/video")',
  'div[role="dialog"] [aria-label*="Photo" i]',
  '[aria-label="Photo/video"]',
  '[aria-label*="Ảnh/video"]',
  'div[role="button"]:has-text("Photo/video")'
]
const FILE_INPUT_SELECTORS = [
  'input[type="file"][accept*="image"][accept*="video"]',
  'input[type="file"][accept*="image"]',
  'input[type="file"]'
]
const POST_SUBMIT_SELECTORS = [
  'div[role="dialog"] div[aria-label="Post"]',
  'div[role="dialog"] div[role="button"]:has-text("Post")',
  'div[role="dialog"] [aria-label="Post"][role="button"]',
  'div[role="dialog"] [aria-label="Đăng"][role="button"]',
  'div[role="dialog"] div[role="button"]:has-text("Đăng")',
  'div[role="dialog"] [aria-label="Next"][role="button"]',
  'div[role="dialog"] div[role="button"]:has-text("Next")',
  'div[role="dialog"] [aria-label="Tiếp"][role="button"]',
  'div[role="dialog"] div[role="button"]:has-text("Tiếp")',
  'div[aria-label="Post"][role="button"]',
  'div[aria-label="Next"][role="button"]',
  'div[role="button"]:has-text("Post")',
  'div[role="button"]:has-text("Next")'
]

async function findFirstVisible(
  page: Page,
  selectors: string[],
  timeoutMs = 4000
): Promise<ReturnType<Page['locator']> | null> {
  // 1. Fast check: is any selector already visible right now?
  for (const sel of selectors) {
    const loc = page.locator(sel).first()
    if (await loc.isVisible().catch(() => false)) return loc
  }

  // 2. Combined locator wait for immediate match on any of the selectors
  const combined = page.locator(selectors.join(', ')).first()
  const visible = await combined
    .waitFor({ state: 'visible', timeout: timeoutMs })
    .then(() => true)
    .catch(() => false)
  if (visible) return combined

  return null
}

/** Open the post composer on whatever page we're on (feed or a group). */
async function openComposer(page: Page, signal?: AbortSignal): Promise<boolean> {
  const trigger = await findFirstVisible(page, COMPOSER_TRIGGER_SELECTORS, 5000)
  if (trigger) {
    await raceAbort(trigger.click({ timeout: 4000, force: true }).catch(() => void 0), signal)
  }

  // Also evaluate click on the exact text element for 100% reliability
  await page.evaluate(() => {
    const main = document.querySelector('div[role="main"]') || document.body
    const spans = Array.from(main.querySelectorAll('span, div[role="button"], div[tabindex="0"]'))
    const target = spans.find((s) => {
      const txt = (s.textContent || '').trim()
      const aria = s.getAttribute('aria-label') || ''
      return /What's on your mind|Create a post|Photo\/video|Share a|Bạn đang nghĩ/i.test(txt + ' ' + aria)
    })
    if (target) {
      const btn = (target as HTMLElement).closest('div[role="button"]') || target
      ;(btn as HTMLElement).click()
    }
  }).catch(() => void 0)

  await raceAbort(page.waitForTimeout(1500), signal)
  const dialog = page.locator('div[role="dialog"], div[aria-label="Create post"], div[aria-label="Create a post"]').first()
  return await dialog.isVisible({ timeout: 5000 }).catch(() => false)
}

/** Type the (already-spun) content into the open composer's textbox. */
async function typeComposerText(page: Page, text: string, signal?: AbortSignal): Promise<boolean> {
  const box = await findFirstVisible(page, COMPOSER_TEXTBOX_SELECTORS, 6000)
  if (box) {
    await raceAbort(box.click({ timeout: 3000, force: true }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(500), signal)
    await raceAbort(page.keyboard.type(text, { delay: 40 }), signal)
    return true
  }

  // Fallback evaluated typing / focus
  return await page.evaluate((val) => {
    const dialog = document.querySelector('div[role="dialog"]') || document.body
    const el = dialog.querySelector('div[role="textbox"], div[contenteditable="true"]') as HTMLElement
    if (el) {
      el.focus()
      document.execCommand('insertText', false, val)
      return true
    }
    return false
  }, text).catch(() => false)
}

/** Attach local image files via the composer's file input, if any given. */
async function attachImages(page: Page, imagePaths: string[], signal?: AbortSignal): Promise<void> {
  if (imagePaths.length === 0) return

  // Check if file input already exists or if we need to click photo button
  let fileInput = page.locator(FILE_INPUT_SELECTORS.join(', ')).first()
  let exists = await fileInput.count().then((c) => c > 0).catch(() => false)

  if (!exists) {
    const photoBtn = await findFirstVisible(page, PHOTO_BUTTON_SELECTORS, 3000)
    if (photoBtn) {
      await raceAbort(photoBtn.click({ timeout: 3000, force: true }).catch(() => void 0), signal)
      await raceAbort(page.waitForTimeout(1000), signal)
    }
  }

  fileInput = page.locator(FILE_INPUT_SELECTORS.join(', ')).first()
  const present = await fileInput.count().then((c) => c > 0).catch(() => false)
  if (present) {
    await raceAbort(fileInput.setInputFiles(imagePaths).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(2500), signal)
  }
}

/**
 * Click the final Post/Đăng submit button, then wait for the composer
 * dialog to actually close before returning.
 */
async function submitPost(page: Page, signal?: AbortSignal): Promise<boolean> {
  // Step 1: Poll until Next / Post button is enabled (upload finished)
  const maxWait = Date.now() + 25000
  let isNextEnabled = false

  while (Date.now() < maxWait) {
    checkAborted(signal)
    const state = await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"]') || document.body
      const btns = Array.from(dialog.querySelectorAll('div[role="button"], button, [aria-label]'))
      const target = btns.find((b) => {
        const text = (b.textContent || '').trim()
        const aria = (b.getAttribute('aria-label') || '').trim()
        return /^(Next|Post|Đăng|Tiếp)$/i.test(text) || /^(Next|Post|Đăng|Tiếp)$/i.test(aria)
      })
      if (!target) return { found: false, disabled: true }
      const disabled = target.getAttribute('aria-disabled') === 'true' || (target as HTMLButtonElement).disabled
      return { found: true, disabled }
    }).catch(() => ({ found: false, disabled: true }))

    if (state.found && !state.disabled) {
      isNextEnabled = true
      break
    }
    await raceAbort(page.waitForTimeout(500), signal)
  }

  if (!isNextEnabled) return false

  // Click Next / Post button
  await page.evaluate(() => {
    const dialog = document.querySelector('div[role="dialog"]') || document.body
    const btns = Array.from(dialog.querySelectorAll('div[role="button"], button, [aria-label]'))
    const target = btns.find((b) => {
      const text = (b.textContent || '').trim()
      const aria = (b.getAttribute('aria-label') || '').trim()
      return /^(Next|Post|Đăng|Tiếp)$/i.test(text) || /^(Next|Post|Đăng|Tiếp)$/i.test(aria)
    })
    if (target) {
      (target as HTMLElement).focus?.()
      ;(target as HTMLElement).click?.()
    }
  }).catch(() => void 0)

  await raceAbort(page.waitForTimeout(2000), signal)

  // Step 2: Check if second "Post" or "Đăng" button is shown on step 2
  const finalWait = Date.now() + 10000
  while (Date.now() < finalWait) {
    checkAborted(signal)
    const clickedFinal = await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"]')
      if (!dialog) return false
      const btns = Array.from(dialog.querySelectorAll('div[role="button"], button, [aria-label]'))
      const target = btns.find((b) => {
        const text = (b.textContent || '').trim()
        const aria = (b.getAttribute('aria-label') || '').trim()
        const disabled = b.getAttribute('aria-disabled') === 'true' || (b as HTMLButtonElement).disabled
        return (/^(Post|Đăng)$/i.test(text) || /^(Post|Đăng)$/i.test(aria)) && !disabled
      })
      if (target) {
        (target as HTMLElement).focus?.()
        ;(target as HTMLElement).click?.()
        return true
      }
      return false
    }).catch(() => false)

    if (clickedFinal) break
    await raceAbort(page.waitForTimeout(500), signal)
  }

  // Step 3: Wait for composer dialog to detach
  const dialog = page.locator('div[role="dialog"]').first()
  await raceAbort(
    dialog.waitFor({ state: 'detached', timeout: 25000 }).catch(() => void 0),
    signal
  )
  await raceAbort(page.waitForTimeout(1500), signal)
  return true
}

/** Detect Facebook's "your post is pending approval" notice after submitting to a group. */
async function checkPendingApproval(page: Page): Promise<boolean> {
  const body = (await page.content().catch(() => '')).toLowerCase()
  return (
    body.includes('pending approval') ||
    body.includes('waiting for approval') ||
    body.includes('chờ phê duyệt') ||
    body.includes('đang chờ')
  )
}

/** Post once to whatever URL the page is currently on. Returns success + a short detail. */
async function postOnce(
  page: Page,
  content: string,
  imagePaths: string[],
  signal?: AbortSignal
): Promise<{ ok: boolean; detail: string }> {
  const opened = await openComposer(page, signal)
  if (!opened) return { ok: false, detail: 'Composer not found (layout changed?)' }

  // Step 1: Type text into composer
  if (content && content.trim()) {
    const typed = await typeComposerText(page, content, signal)
    if (!typed) {
      await page.evaluate((text) => {
        const dialog = document.querySelector('div[role="dialog"]') || document.body
        const box = dialog.querySelector('div[role="textbox"], div[contenteditable="true"]') as HTMLElement
        if (box) {
          box.focus()
          document.execCommand('insertText', false, text)
        }
      }, content).catch(() => void 0)
    }
    await raceAbort(page.waitForTimeout(1000), signal)
  }

  // Step 2: Attach images if any
  if (imagePaths && imagePaths.length > 0) {
    await attachImages(page, imagePaths, signal)
    await raceAbort(page.waitForTimeout(2000), signal)
  }

  // Step 3: Submit post
  const submitted = await submitPost(page, signal)
  if (!submitted) return { ok: false, detail: 'Post/Next button not found or remained disabled' }

  const pending = await checkPendingApproval(page)
  return { ok: true, detail: pending ? 'Posted (pending group approval)' : 'Posted' }
}

/** Scrape a handful of joined-group URLs from the Groups > Joined page. */
async function getJoinedGroupUrls(page: Page, limit: number, signal?: AbortSignal): Promise<string[]> {
  await raceAbort(
    page.goto('https://web.facebook.com/groups/joins/?nav_source=tab', {
      timeout: 45000,
      waitUntil: 'domcontentloaded'
    }),
    signal
  )
  await raceAbort(page.waitForTimeout(2000), signal)

  const hrefs = await page
    .locator('a[href*="/groups/"][role="link"]')
    .evaluateAll((els) =>
      els
        .map((el) => (el as HTMLAnchorElement).href)
        .filter((h) => /\/groups\/[^/]+\/?$/.test(h))
    )
    .catch(() => [] as string[])

  const unique = [...new Set(hrefs)]
  // Shuffle then take up to `limit`, so repeated runs don't always hit the same groups.
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[unique[i], unique[j]] = [unique[j], unique[i]]
  }
  return unique.slice(0, limit)
}

/**
 * Run Auto Post for one account: either the personal feed once, or up to
 * `groupCount` randomly-chosen joined groups with a delay between each.
 * Assumes the account's persisted profile is already an authenticated
 * session (i.e. run after a successful auto-login).
 */
export async function postToFeedOrGroups(
  account: Account,
  options: AutoPostOptions
): Promise<AutoPostResult> {
  const {
    destination,
    contentTemplate,
    imagePaths = [],
    groupCount = 1,
    delayMinSeconds = 15,
    delayMaxSeconds = 45,
    signal,
    onProgress
  } = options
  const progress = (label: string): void => onProgress?.(label)

  const trackKey = `post:${account.id}`
  // No explicit headless override — launchContext falls back to the
  // persisted General Settings Browser Mode.
  const context = await launchContext({ account })
  trackContext(trackKey, context)

  let posted = 0
  let attempted = 0

  try {
    const page = context.pages()[0] ?? (await context.newPage())

    if (destination === 'feed') {
      progress('Opening feed...')
      await raceAbort(
        page.goto('https://web.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' }),
        signal
      )
      await raceAbort(page.waitForTimeout(2000), signal)

      const session = await verifyActiveSession(page, account, signal, progress)
      if (!session.live) {
        return {
          success: false,
          posted: 0,
          attempted: 0,
          detail: session.detail
        }
      }

      attempted = 1
      progress('Posting to feed...')
      checkAborted(signal)
      const content = parseSpinSyntax(contentTemplate)
      const res = await postOnce(page, content, imagePaths, signal)
      if (res.ok) posted = 1
      progress(res.ok ? 'Warm-up Completed' : `Error: ${res.detail}`)
      return {
        success: res.ok,
        posted,
        attempted,
        detail: res.detail
      }
    }

    // destination === 'groups'
    progress('Opening Facebook...')
    await raceAbort(
      page.goto('https://web.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' }),
      signal
    )
    await raceAbort(page.waitForTimeout(2000), signal)

    const session = await verifyActiveSession(page, account, signal, progress)
    if (!session.live) {
      return {
        success: false,
        posted: 0,
        attempted: 0,
        detail: session.detail
      }
    }

    progress('Finding joined groups...')
    const groups = await getJoinedGroupUrls(page, Math.max(1, groupCount), signal)
    if (groups.length === 0) {
      return { success: false, posted: 0, attempted: 0, detail: 'No joined groups found' }
    }

    for (const url of groups) {
      checkAborted(signal)
      attempted += 1
      progress(`Posting to group ${attempted}/${groups.length}...`)
      await raceAbort(page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' }), signal)
      await raceAbort(page.waitForTimeout(2000), signal)

      const content = parseSpinSyntax(contentTemplate)
      const res = await postOnce(page, content, imagePaths, signal)
      if (res.ok) posted += 1

      if (attempted < groups.length) {
        progress(`Waiting before next group post...`)
        await delay(page, delayMinSeconds, delayMaxSeconds, signal)
      }
    }

    return {
      success: posted > 0,
      posted,
      attempted,
      detail: `Posted to ${posted}/${attempted} group(s)`
    }
  } catch (err) {
    if (err instanceof AbortedError) {
      return { success: false, posted, attempted, detail: 'Cancelled by user' }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, posted, attempted, detail: `Auto Post error: ${message}` }
  } finally {
    untrackContext(trackKey)
    await context.close().catch(() => void 0)
  }
}
