// ---------------------------------------------------------------------------
// watchLive.ts  — Watch Live: open a livestream URL, stay on it for a
// configured duration, and optionally post a random comment from a list.
// ---------------------------------------------------------------------------
import type { Account } from '../../types/account'
import { launchContext, trackContext, untrackContext } from './browserContext'
import { verifyActiveSession } from './sessionGuard'

export interface WatchLiveOptions {
  liveUrl: string
  watchSeconds: number
  comments?: string[]
  signal?: AbortSignal
  onProgress?: (label: string) => void
}

export interface WatchLiveResult {
  success: boolean
  commented: boolean
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

const COMMENT_BOX_SELECTORS = [
  'div[aria-label="Write a comment"][contenteditable="true"]',
  'div[aria-label*="comment" i][contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]'
]

async function findFirstVisible(
  page: import('playwright').Page,
  selectors: string[],
  timeoutMs = 3000
): Promise<ReturnType<import('playwright').Page['locator']> | null> {
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

/** Pick one random comment from the list, if any were provided. */
function pickComment(comments: string[] | undefined): string | null {
  if (!comments || comments.length === 0) return null
  return comments[Math.floor(Math.random() * comments.length)]
}

/**
 * Watch a livestream for a set duration and optionally drop one random
 * comment partway through. Assumes an already-authenticated session
 * (persistent profile from a prior login).
 */
export async function watchLive(account: Account, options: WatchLiveOptions): Promise<WatchLiveResult> {
  const { liveUrl, watchSeconds, comments, signal, onProgress } = options
  const progress = (label: string): void => onProgress?.(label)

  const trackKey = `watchlive:${account.id}`
  // No explicit headless override — launchContext falls back to the
  // persisted General Settings Browser Mode.
  const context = await launchContext({ account })
  trackContext(trackKey, context)

  let commented = false

  try {
    const page = context.pages()[0] ?? (await context.newPage())

    progress('Opening livestream...')
    checkAborted(signal)
    await raceAbort(page.goto(liveUrl, { timeout: 45000, waitUntil: 'domcontentloaded' }), signal)
    await raceAbort(page.waitForTimeout(2500), signal)

    const session = await verifyActiveSession(page, account, signal, progress)
    if (!session.live) {
      return { success: false, commented: false, detail: session.detail }
    }

    const comment = pickComment(comments)
    // Post the comment roughly halfway through the watch window so it looks
    // like organic engagement rather than an immediate drive-by comment.
    const commentAtMs = comment ? Math.round((watchSeconds * 1000) / 2) : null

    const totalMs = Math.max(1000, Math.round(watchSeconds * 1000))
    const start = Date.now()
    const tick = 1000

    while (Date.now() - start < totalMs) {
      checkAborted(signal)
      const elapsed = Date.now() - start
      progress(`Watching... ${Math.round(elapsed / 1000)}/${watchSeconds}s`)

      if (comment && commentAtMs != null && !commented && elapsed >= commentAtMs) {
        const box = await findFirstVisible(page, COMMENT_BOX_SELECTORS, 3000)
        if (box) {
          await raceAbort(box.click({ timeout: 3000 }).catch(() => void 0), signal)
          await raceAbort(box.type(comment, { delay: 20 + Math.random() * 30 }), signal)
          await raceAbort(page.keyboard.press('Enter').catch(() => void 0), signal)
          commented = true
          progress('Posted comment')
        }
      }

      await raceAbort(page.waitForTimeout(Math.min(tick, totalMs - elapsed)), signal)
    }

    return {
      success: true,
      commented,
      detail: comment
        ? commented
          ? `Watched ${watchSeconds}s, posted 1 comment`
          : `Watched ${watchSeconds}s, comment box not found`
        : `Watched ${watchSeconds}s`
    }
  } catch (err) {
    if (err instanceof AbortedError) {
      return { success: false, commented, detail: 'Cancelled by user' }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, commented, detail: `Watch Live error: ${message}` }
  } finally {
    untrackContext(trackKey)
    await context.close().catch(() => void 0)
  }
}
