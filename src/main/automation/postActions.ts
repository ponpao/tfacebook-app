// ---------------------------------------------------------------------------
// postActions.ts  — Auto Post: publish spun text (+ optional images) to the
// personal feed or a random selection of joined groups.
// ---------------------------------------------------------------------------
import type { Page } from 'playwright'
import type { Account, ManagedPage } from '../../types/account'
import { launchContext, trackContext, untrackContext } from './browserContext'
import { parseSpinSyntax } from '../utils/spinSyntax'
import { verifyActiveSession } from './sessionGuard'

export type PostDestination = 'feed' | 'groups' | 'pages'

export interface AutoPostOptions {
  destination: PostDestination
  /** Raw template — spun independently for every post. */
  contentTemplate: string
  /** Absolute local file paths of images to attach (optional). */
  imagePaths?: string[]
  /** When destination = 'groups', post to at most this many joined groups. */
  groupCount?: number
  /** When destination = 'pages', post to at most this many managed pages. */
  pageCount?: number
  /** Seconds to wait between consecutive group posts. */
  delayMinSeconds?: number
  delayMaxSeconds?: number
  /** Optional comment (often a link) posted on the new post. Spin syntax supported. */
  commentTemplate?: string
  pageTargets?: { accountId: number; pageId: string; comment?: string }[]
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
  '[aria-label*="តើអ្នកកំពុងគិត"]',
  'div[role="button"]:has-text("Create a post")',
  'div[role="button"]:has-text("Create post")',
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
  '[aria-label*="តើអ្នកកំពុងគិត"][contenteditable="true"]',
  '[aria-label*="Write something" i][contenteditable="true"]',
  '[aria-placeholder*="What\'s on your mind" i]',
  'div[role="textbox"][contenteditable="true"]'
]
const COMMENT_BOX_SELECTORS = [
  'div[role="article"] div[aria-label="Write a comment"][contenteditable="true"]',
  'div[aria-label="Write a comment"][contenteditable="true"]',
  'div[aria-label*="Write a comment" i][contenteditable="true"]',
  'div[aria-label*="Write a comment" i][role="textbox"]',
  'div[aria-label*="Viết bình luận" i][contenteditable="true"]',
  'div[aria-label*="បញ្ចេញមតិ" i][contenteditable="true"]',
  'form div[contenteditable="true"][role="textbox"]'
]
const SWITCH_PAGE_SELECTORS = [
  'div[role="button"]:has-text("Switch Now")',
  'div[aria-label="Switch Now"]',
  'div[role="button"]:has-text("Switch into")',
  'div[role="button"]:has-text("Switch to Page")',
  '[aria-label="Switch"]',
  'div[role="button"]:has-text("Switch")',
  'div[role="button"]:has-text("ប្តូរឥឡូវ")',
  'div[role="button"]:has-text("ប្តូរ")'
]
const PHOTO_BUTTON_SELECTORS = [
  'div[role="dialog"] div[aria-label="Photo/video"]',
  'div[role="dialog"] div[role="button"]:has-text("Photo/video")',
  'div[role="dialog"] [aria-label*="Photo" i]',
  '[aria-label="Photo/video"]',
  '[aria-label*="Ảnh/video"]',
  '[aria-label*="រូបថត"]',
  'div[role="button"]:has-text("Photo/video")',
  'div[role="button"]:has-text("Photo / video")'
]
const FILE_INPUT_SELECTORS = [
  'input[type="file"][accept*="image"][accept*="video"]',
  'input[type="file"][accept*="video"]',
  'input[type="file"][accept*="image"]',
  'input[type="file"]'
]
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)$/i

function isVideoPath(p: string): boolean {
  return VIDEO_EXT.test(p)
}
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
  if (await dialog.isVisible({ timeout: 4000 }).catch(() => false)) return true
  const box = await findFirstVisible(page, COMPOSER_TEXTBOX_SELECTORS, 2500)
  return Boolean(box)
}

function parseManagedPages(account: Account): ManagedPage[] {
  if (!account.pages_data?.trim()) return []
  try {
    const parsed = JSON.parse(account.pages_data) as ManagedPage[]
    return Array.isArray(parsed)
      ? parsed.filter((p) => p?.pageId && p.status !== 'Deactivated / Deleted')
      : []
  } catch {
    return []
  }
}

function pageProfileUrl(managed: ManagedPage): string {
  const raw = (managed.url || '').trim()
  if (/^https?:\/\/(www\.|web\.|m\.)?facebook\.com\//i.test(raw) && !/\/pages\/\?/.test(raw)) {
    return raw.replace('://www.facebook.com', '://web.facebook.com').replace('://m.facebook.com', '://web.facebook.com')
  }
  const id = String(managed.pageId || '').replace(/^\/+/, '').split('?')[0]
  if (/^\d{5,}$/.test(id)) return `https://web.facebook.com/profile.php?id=${id}`
  if (id) return `https://web.facebook.com/${encodeURI(id)}`
  return 'https://web.facebook.com/'
}

async function switchIntoPage(page: Page, signal?: AbortSignal): Promise<void> {
  const btn = await findFirstVisible(page, SWITCH_PAGE_SELECTORS, 2500)
  if (!btn) return
  await raceAbort(btn.click({ timeout: 3000, force: true }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(2500), signal)
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

/** Attach local photo/video files via the composer's file input. */
async function attachMedia(page: Page, mediaPaths: string[], signal?: AbortSignal): Promise<void> {
  if (mediaPaths.length === 0) return

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
  try {
    if (present) {
      await raceAbort(fileInput.setInputFiles(mediaPaths), signal)
    } else {
      const anyInput = page.locator('input[type="file"]').first()
      if ((await anyInput.count().catch(() => 0)) > 0) {
        await raceAbort(anyInput.setInputFiles(mediaPaths), signal)
      }
    }
  } catch {
    /* composer file input can remount; retry below */
    const retry = page.locator('input[type="file"]').first()
    await raceAbort(retry.setInputFiles(mediaPaths).catch(() => void 0), signal)
  }

  const hasVideo = mediaPaths.some(isVideoPath)
  const dialog = page.locator('div[role="dialog"]').first()
  const preview = hasVideo
    ? dialog.locator('video').first()
    : dialog.locator('img[src*="blob:"], img[src*="scontent"], img[src*="fbcdn"]').first()
  await raceAbort(preview.waitFor({ state: 'attached', timeout: hasVideo ? 45000 : 20000 }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(hasVideo ? 4000 : 1500), signal)
}

/**
 * Click the final Post/Đăng submit button, then wait for the composer
 * dialog to actually close before returning.
 */
async function submitPost(page: Page, signal?: AbortSignal): Promise<boolean> {
  // Step 1: Poll until Next / Post button is enabled (upload finished; videos take longer)
  const maxWait = Date.now() + 90000
  let isNextEnabled = false

  while (Date.now() < maxWait) {
    checkAborted(signal)
    const state = await page.evaluate(() => {
      const dialog = document.querySelector('div[role="dialog"]') || document.body
      const btns = Array.from(dialog.querySelectorAll('div[role="button"], button, [aria-label]'))
      const target = btns.find((b) => {
        const text = (b.textContent || '').trim()
        const aria = (b.getAttribute('aria-label') || '').trim()
        return /^(Next|Post|Đăng|Tiếp|ផុស)$/i.test(text) || /^(Next|Post|Đăng|Tiếp|ផុស)$/i.test(aria)
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
      return /^(Next|Post|Đăng|Tiếp|ផុស)$/i.test(text) || /^(Next|Post|Đăng|Tiếp|ផុស)$/i.test(aria)
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
        return (/^(Post|Đăng|ផុស)$/i.test(text) || /^(Post|Đăng|ផុស)$/i.test(aria)) && !disabled
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
  mediaPaths: string[],
  signal?: AbortSignal
): Promise<{ ok: boolean; detail: string }> {
  const opened = await openComposer(page, signal)
  if (!opened) return { ok: false, detail: 'Composer not found (layout changed?)' }

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

  if (mediaPaths && mediaPaths.length > 0) {
    await attachMedia(page, mediaPaths, signal)
    const hasVideo = mediaPaths.some(isVideoPath)
    await raceAbort(page.waitForTimeout(hasVideo ? 3000 : 1500), signal)
  }

  // Step 3: Submit post
  const submitted = await submitPost(page, signal)
  if (!submitted) return { ok: false, detail: 'Post/Next button not found or remained disabled' }

  const pending = await checkPendingApproval(page)
  return { ok: true, detail: pending ? 'Posted (pending group approval)' : 'Posted' }
}

/** Comment on the newest post currently visible (first Write a comment box). */
async function commentOnLatestPost(
  page: Page,
  comment: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!comment.trim()) return false
  await raceAbort(page.waitForTimeout(2500), signal)

  const article = page.locator('div[role="article"]').first()
  const commentBtn = article.locator(
    '[aria-label="Comment"], [aria-label*="Comment" i], div[role="button"]:has-text("Comment"), div[role="button"]:has-text("មតិ")'
  ).first()
  if (await commentBtn.isVisible().catch(() => false)) {
    await raceAbort(commentBtn.click({ timeout: 3000, force: true }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(700), signal)
  }

  let box = await findFirstVisible(page, COMMENT_BOX_SELECTORS, 8000)
  if (!box) {
    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('[aria-label], div[role="textbox"], div[contenteditable="true"]'))
      const el = labels.find((n) => /write a comment|viết bình luận|បញ្ចេញមតិ|comment/i.test(n.getAttribute('aria-label') || ''))
      if (el) (el as HTMLElement).click()
    }).catch(() => void 0)
    await raceAbort(page.waitForTimeout(800), signal)
    box = await findFirstVisible(page, COMMENT_BOX_SELECTORS, 4000)
  }
  if (!box) return false

  await raceAbort(box.click({ timeout: 3000, force: true }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(400), signal)
  await raceAbort(page.keyboard.type(comment, { delay: 20 }), signal)
  await raceAbort(page.waitForTimeout(500), signal)
  await raceAbort(page.keyboard.press('Enter'), signal)
  await raceAbort(page.waitForTimeout(1800), signal)
  return true
}

async function postOnceWithComment(
  page: Page,
  content: string,
  mediaPaths: string[],
  commentTemplate: string | undefined,
  signal?: AbortSignal,
  returnToUrl?: string
): Promise<{ ok: boolean; detail: string }> {
  const res = await postOnce(page, content, mediaPaths, signal)
  if (!res.ok) return res
  const comment = commentTemplate?.trim() ? parseSpinSyntax(commentTemplate) : ''
  if (!comment) return res
  if (returnToUrl) {
    await raceAbort(
      page.goto(returnToUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }),
      signal
    )
    await raceAbort(page.waitForTimeout(2500), signal)
    await switchIntoPage(page, signal)
  }
  const commented = await commentOnLatestPost(page, comment, signal)
  return {
    ok: true,
    detail: commented ? `${res.detail} + comment` : `${res.detail} (comment box not found)`
  }
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
    pageCount = 10,
    delayMinSeconds = 15,
    delayMaxSeconds = 45,
    commentTemplate,
    pageTargets,
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

    if (destination === 'pages') {
      progress('Opening Facebook...')
      await raceAbort(
        page.goto('https://web.facebook.com/', { timeout: 45000, waitUntil: 'domcontentloaded' }),
        signal
      )
      await raceAbort(page.waitForTimeout(2000), signal)

      const session = await verifyActiveSession(page, account, signal, progress)
      if (!session.live) {
        return { success: false, posted: 0, attempted: 0, detail: session.detail }
      }

      let pages = parseManagedPages(account)
      if (pages.length === 0) {
        progress('No saved pages — scanning Your Pages...')
        try {
          const { getOrExtractManagedPages } = await import('./pagePostsManager')
          pages = await getOrExtractManagedPages(account, true, true)
        } catch {
          pages = []
        }
      }
      const targetsForAccount = (pageTargets || []).filter((t) => t.accountId === account.id)
      if (targetsForAccount.length > 0) {
        const want = new Set(targetsForAccount.map((t) => String(t.pageId)))
        pages = pages.filter((p) => want.has(String(p.pageId)))
      } else {
        pages = pages.slice(0, Math.max(1, pageCount))
      }
      if (pages.length === 0) {
        return {
          success: false,
          posted: 0,
          attempted: 0,
          detail: 'No managed Pages found. Run Get Page Info first.'
        }
      }

      for (const managed of pages) {
        checkAborted(signal)
        attempted += 1
        progress(`Posting to page ${attempted}/${pages.length}: ${managed.name}...`)
        await raceAbort(
          page.goto(pageProfileUrl(managed), { timeout: 45000, waitUntil: 'domcontentloaded' }),
          signal
        )
        await raceAbort(page.waitForTimeout(2000), signal)
        await switchIntoPage(page, signal)

        const content = parseSpinSyntax(contentTemplate)
        const pageComment =
          targetsForAccount.find((t) => String(t.pageId) === String(managed.pageId))?.comment ||
          commentTemplate
        const profileUrl = pageProfileUrl(managed)
        let res = await postOnceWithComment(page, content, imagePaths, pageComment, signal, profileUrl)
        if (!res.ok && managed.assetId) {
          progress(`Retrying ${managed.name} via Business Suite composer...`)
          await raceAbort(
            page.goto(`https://business.facebook.com/latest/composer/?asset_id=${managed.assetId}`, {
              timeout: 45000,
              waitUntil: 'domcontentloaded'
            }),
            signal
          )
          await raceAbort(page.waitForTimeout(3000), signal)
          res = await postOnceWithComment(page, content, imagePaths, pageComment, signal, profileUrl)
        }
        if (res.ok) posted += 1

        if (attempted < pages.length) {
          progress('Waiting before next page post...')
          await delay(page, delayMinSeconds, delayMaxSeconds, signal)
        }
      }

      return {
        success: posted > 0,
        posted,
        attempted,
        detail: `Posted to ${posted}/${attempted} page(s)`
      }
    }

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
      const res = await postOnceWithComment(page, content, imagePaths, commentTemplate, signal)
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
      const res = await postOnceWithComment(page, content, imagePaths, commentTemplate, signal)
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
