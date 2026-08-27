// ---------------------------------------------------------------------------
// shareActions.ts  — Auto Share: share a Facebook post/reel/video/livestream
// URL to the personal wall or a random selection of joined groups.
// ---------------------------------------------------------------------------
import type { Page } from 'playwright'
import type { Account } from '../../types/account'
import { launchContext, trackContext, untrackContext } from './browserContext'
import { parseSpinSyntax } from '../utils/spinSyntax'

export type ShareDestination = 'wall' | 'groups'

export interface AutoShareOptions {
  targetUrl: string
  destination: ShareDestination
  /** Optional spun caption added to the share dialog. */
  captionTemplate?: string
  groupCount?: number
  delayMinSeconds?: number
  delayMaxSeconds?: number
  signal?: AbortSignal
  onProgress?: (label: string) => void
}

export interface AutoShareResult {
  success: boolean
  shared: number
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

const SHARE_BUTTON_SELECTORS = [
  '[aria-label="Send this to friends or post it on your profile." i]',
  '[aria-label="Share" i]',
  'div[role="button"]:has-text("Share")',
  'div[role="button"]:has-text("Chia sẻ")'
]
const SHARE_NOW_SELECTORS = [
  // Facebook's share picker renders its options as menuitems in some
  // layouts and as plain buttons in others — both are tried.
  'div[role="menuitem"]:has-text("Share now")',
  'div[role="menuitem"]:has-text("Share to Feed")',
  'div[role="button"]:has-text("Share now")',
  'div[role="button"]:has-text("Share to Feed")',
  'div[role="button"]:has-text("Chia sẻ ngay")',
  'span:has-text("Share to News Feed")'
]
const SHARE_TO_GROUP_SELECTORS = [
  'div[role="menuitem"]:has-text("Share to a group")',
  'div[role="button"]:has-text("Share to a group")',
  'div[role="button"]:has-text("Chia sẻ vào nhóm")'
]
const GROUP_PICKER_SEARCH_SELECTORS = [
  'input[placeholder="Search for groups"]',
  'input[aria-label*="Search"]'
]
const CAPTION_TEXTBOX_SELECTORS = [
  'div[aria-label="Write something..."][contenteditable="true"]',
  'div[aria-label*="Viết gì đó"][contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]'
]
const POST_SUBMIT_SELECTORS = [
  'div[aria-label="Post"][role="button"]',
  'div[aria-label="Đăng"][role="button"]',
  'div[role="button"]:has-text("Post")',
  'div[role="button"]:has-text("Đăng")'
]

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

/** Fill an optional spun caption into the share dialog, if a textbox appears. */
async function fillCaptionIfPresent(
  page: Page,
  captionTemplate: string | undefined,
  signal?: AbortSignal
): Promise<void> {
  if (!captionTemplate || !captionTemplate.trim()) return
  const box = await findFirstVisible(page, CAPTION_TEXTBOX_SELECTORS, 2500)
  if (!box) return
  const caption = parseSpinSyntax(captionTemplate)
  await raceAbort(box.click({ timeout: 3000 }).catch(() => void 0), signal)
  await raceAbort(box.type(caption, { delay: 15 + Math.random() * 25 }), signal)
}

/** Share the post currently on `page` to the personal wall (public share). */
async function shareToWall(page: Page, captionTemplate: string | undefined, signal?: AbortSignal): Promise<{ ok: boolean; detail: string }> {
  const shareBtn = await findFirstVisible(page, SHARE_BUTTON_SELECTORS, 8000)
  if (!shareBtn) return { ok: false, detail: 'Share button not found' }
  await raceAbort(shareBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1000), signal)

  const shareNow = await findFirstVisible(page, SHARE_NOW_SELECTORS, 5000)
  if (!shareNow) return { ok: false, detail: '"Share now" option not found' }
  await raceAbort(shareNow.click({ timeout: 5000 }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1200), signal)

  await fillCaptionIfPresent(page, captionTemplate, signal)

  const submit = await findFirstVisible(page, POST_SUBMIT_SELECTORS, 4000)
  if (submit) {
    await raceAbort(submit.click({ timeout: 5000 }).catch(() => void 0), signal)
  }
  // "Share now" often completes immediately with no separate submit step
  // (no dialog to wait on) — a flat wait for the confirmation toast covers
  // both that case and the "Share to Feed" caption-dialog case above.
  await raceAbort(page.waitForTimeout(3000), signal)

  return { ok: true, detail: 'Shared to wall' }
}

/** Share the post currently on `page` into a specific joined group by name/URL match. */
async function shareToGroup(
  page: Page,
  groupHint: string,
  captionTemplate: string | undefined,
  signal?: AbortSignal
): Promise<{ ok: boolean; detail: string }> {
  const shareBtn = await findFirstVisible(page, SHARE_BUTTON_SELECTORS, 8000)
  if (!shareBtn) return { ok: false, detail: 'Share button not found' }
  await raceAbort(shareBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1000), signal)

  const toGroup = await findFirstVisible(page, SHARE_TO_GROUP_SELECTORS, 4000)
  if (!toGroup) return { ok: false, detail: '"Share to a group" option not found' }
  await raceAbort(toGroup.click({ timeout: 5000 }).catch(() => void 0), signal)
  await raceAbort(page.waitForTimeout(1200), signal)

  const search = await findFirstVisible(page, GROUP_PICKER_SEARCH_SELECTORS, 3000)
  if (search) {
    await raceAbort(search.type(groupHint, { delay: 30 }), signal)
    await raceAbort(page.waitForTimeout(1000), signal)
  }

  const firstResult = page.locator('[role="button"][aria-label]').first()
  const clicked = await firstResult
    .click({ timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (!clicked) return { ok: false, detail: 'No matching group in picker' }

  await fillCaptionIfPresent(page, captionTemplate, signal)

  const submit = await findFirstVisible(page, POST_SUBMIT_SELECTORS, 4000)
  if (submit) {
    await raceAbort(submit.click({ timeout: 5000 }).catch(() => void 0), signal)
    await raceAbort(page.waitForTimeout(2000), signal)
  }

  return { ok: true, detail: `Shared to group (${groupHint})` }
}

async function getJoinedGroupNames(page: Page, limit: number, signal?: AbortSignal): Promise<string[]> {
  await raceAbort(
    page.goto('https://web.facebook.com/groups/joins/?nav_source=tab', {
      timeout: 45000,
      waitUntil: 'domcontentloaded'
    }),
    signal
  )
  await raceAbort(page.waitForTimeout(2000), signal)

  const names = await page
    .locator('a[href*="/groups/"][role="link"] span')
    .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? '').filter(Boolean))
    .catch(() => [] as string[])

  const unique = [...new Set(names)]
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[unique[i], unique[j]] = [unique[j], unique[i]]
  }
  return unique.slice(0, limit)
}

/**
 * Share a target Facebook URL to the personal wall (once) or into up to
 * `groupCount` randomly-chosen joined groups (with a delay between each).
 * Assumes an already-authenticated session (run after auto-login).
 */
export async function sharePostOrVideo(
  account: Account,
  options: AutoShareOptions
): Promise<AutoShareResult> {
  const {
    targetUrl,
    destination,
    captionTemplate,
    groupCount = 1,
    delayMinSeconds = 20,
    delayMaxSeconds = 60,
    signal,
    onProgress
  } = options
  const progress = (label: string): void => onProgress?.(label)

  const trackKey = `share:${account.id}`
  // No explicit headless override — launchContext falls back to the
  // persisted General Settings Browser Mode.
  const context = await launchContext({ account })
  trackContext(trackKey, context)

  let shared = 0
  let attempted = 0

  try {
    const page = context.pages()[0] ?? (await context.newPage())

    progress('Opening target post...')
    await raceAbort(page.goto(targetUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }), signal)
    await raceAbort(page.waitForTimeout(2000), signal)

    if (destination === 'wall') {
      attempted = 1
      progress('Sharing to wall...')
      checkAborted(signal)
      const res = await shareToWall(page, captionTemplate, signal)
      if (res.ok) shared = 1
      return { success: res.ok, shared, attempted, detail: res.detail }
    }

    // destination === 'groups'
    progress('Finding joined groups...')
    const groupNames = await getJoinedGroupNames(page, Math.max(1, groupCount), signal)
    if (groupNames.length === 0) {
      return { success: false, shared: 0, attempted: 0, detail: 'No joined groups found' }
    }

    for (const name of groupNames) {
      checkAborted(signal)
      attempted += 1
      progress(`Sharing to group ${attempted}/${groupNames.length}...`)

      // Re-navigate to the post before each share attempt (the picker flow
      // consumes the share dialog).
      await raceAbort(
        page.goto(targetUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }),
        signal
      )
      await raceAbort(page.waitForTimeout(1500), signal)

      const res = await shareToGroup(page, name, captionTemplate, signal)
      if (res.ok) shared += 1

      if (attempted < groupNames.length) {
        progress('Waiting before next share (anti-spam delay)...')
        await delay(page, delayMinSeconds, delayMaxSeconds, signal)
      }
    }

    return {
      success: shared > 0,
      shared,
      attempted,
      detail: `Shared to ${shared}/${attempted} group(s)`
    }
  } catch (err) {
    if (err instanceof AbortedError) {
      return { success: false, shared, attempted, detail: 'Cancelled by user' }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, shared, attempted, detail: `Auto Share error: ${message}` }
  } finally {
    untrackContext(trackKey)
    await context.close().catch(() => void 0)
  }
}
