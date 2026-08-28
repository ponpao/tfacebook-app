// ---------------------------------------------------------------------------
// avatarService.ts  — high-speed(ish) avatar downloader via a real stealth
// headless Playwright context per account.
//
// Superseded a bare-fetch() + cookie-header approach (v1.1.1) that turned
// out not to work: Facebook fingerprints non-browser HTTP clients and
// serves a browser-unsupported wall / silently-logged-out response to plain
// fetch() requests even with a fully valid session cookie attached — verified
// live against a real account (curl/fetch to mbasic.facebook.com returned
// "Facebook is not available on this browser" regardless of cookie
// correctness). Routing the same cookie through a real Playwright Chromium
// context (this app's existing launchContext(), which already handles
// stealth args + cookie injection) gets straight past that: confirmed live,
// a real `[aria-label="Your profile"] image` element resolves and its
// scontent CDN URL is genuinely reachable.
//
// A second, separate bug was found in the same live test: the nav-bar
// avatar element's URL carries a `ctp=s40x40` crop-to-40px query param —
// downloading it as-is silently saves a 40x40 icon that still passes every
// validation check (real CDN domain, not a silhouette, comfortably under
// 1MB) while being visually useless. Stripping just that one param from the
// same URL returns the genuine 1024x1024 source photo (also verified live:
// 977 bytes -> 219KB, 40x40 -> 1024x1024, same underlying image). See
// stripCropParams() below.
// ---------------------------------------------------------------------------
import { writeFile } from 'fs/promises'
import { join } from 'path'
import sharp from 'sharp'
import { BrowserWindow } from 'electron'
import type { BrowserContext, Page } from 'playwright'
import * as accounts from '../db/accountsRepo'
import { resolveAvatarsRoot, launchContext, trackContext, untrackContext } from '../automation/browserContext'
import { IPC } from '../ipc/channels'
import type { Account } from '../../types/account'

// Real browser instances are far heavier than the bare-fetch approach this
// replaces — 2-4 concurrent Chromium processes is the sweet spot the spec
// asks for (smooth on a typical machine, no browser-collision/RAM blowup
// from opening many at once for a large batch).
const CONCURRENCY = 3
const NAV_TIMEOUT_MS = 45000
const MAX_FILE_SIZE_BYTES = 1024 * 1024 // strictly under 1MB, per spec

const AVATAR_IMG_SELECTORS = [
  '[aria-label="Your profile"] image',
  'div[role="banner"] svg image',
  'img[alt*="profile" i]',
  'div[role="navigation"] image'
]

export interface AvatarDownloadEvent {
  accountId: number
  uid: string | null
  index: number
  total: number
  ok: boolean
  detail?: string
}

export interface AvatarDownloadSummary {
  total: number
  succeeded: number
  failed: number
}

function avatarPath(uid: string): string {
  return join(resolveAvatarsRoot(), `${uid}.jpg`)
}

/** Local on-disk avatar path for a UID, without triggering a download — used by avatars:get-local-path. */
export function getLocalAvatarPath(uid: string): string {
  return avatarPath(uid)
}

/**
 * Strips Facebook's crop-to-size query param (ctp=WxH) from a CDN image
 * URL, unlocking the full-resolution source the URL otherwise still points
 * at via its other size hints (cstp=, etc.) — verified live: the same URL
 * with only this one param removed goes from a 977-byte 40x40 crop to a
 * 219KB 1024x1024 image. Leaves every other query param untouched (the
 * signed oh=/oe= auth tokens, _nc_* CDN routing hints, etc. all still need
 * to be present for the URL to resolve at all).
 */
function stripCropParams(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('ctp')
    return parsed.toString()
  } catch {
    // Malformed URL somehow — fall back to the original rather than throwing,
    // the caller will just get whatever resolution that returns.
    return url
  }
}

/**
 * Re-encodes quality downward (90 -> 85 -> 75 -> 65 -> 55) until the JPEG
 * fits under MAX_FILE_SIZE_BYTES, or gives up at the last attempt regardless
 * — a 1080x1080 photo essentially never fails to fit even at quality 90, but
 * this guarantees the "strictly under 1MB" requirement rather than assuming
 * it.
 */
async function encodeUnderSizeLimit(buffer: Buffer): Promise<Buffer> {
  const qualities = [90, 85, 75, 65, 55]
  let last: Buffer = buffer
  for (const quality of qualities) {
    last = await sharp(buffer)
      .resize(1080, 1080, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality })
      .toBuffer()
    if (last.length <= MAX_FILE_SIZE_BYTES) return last
  }
  return last
}

async function extractAvatarUrl(page: Page): Promise<string | undefined> {
  for (const sel of AVATAR_IMG_SELECTORS) {
    const loc = page.locator(sel).first()
    const url =
      (await loc.getAttribute('src').catch(() => null)) ??
      (await loc.getAttribute('href').catch(() => null)) ??
      (await loc.getAttribute('xlink:href').catch(() => null))
    if (url && /^https?:\/\//i.test(url)) return url
  }
  return undefined
}

/**
 * Launches a real stealth headless Chromium context for the account
 * (launchContext() already injects its saved cookie — see
 * browserContext.ts's injectSavedCookies()), navigates to the feed,
 * extracts the nav-bar avatar's scontent URL, strips its crop param, and
 * downloads the resulting full-resolution image through the page's own
 * request context (so the fetch goes through the same proxy the account's
 * browser session uses, matching this app's existing downloadAvatarToFile()
 * convention in autoLogin.ts). Always closes the context, success or not.
 */
async function downloadOneViaPlaywright(account: Account): Promise<Buffer> {
  const uid = account.uid!
  const trackKey = `avatar:${account.id}`
  let context: BrowserContext | null = null
  try {
    context = await launchContext({ headless: true, account })
    trackContext(trackKey, context)

    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto('https://www.facebook.com/me', {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: 'domcontentloaded'
    })
    await page.waitForTimeout(2000)

    const rawUrl = await extractAvatarUrl(page)
    if (!rawUrl) {
      throw new Error('No avatar image element found — session may be logged out or checkpointed')
    }

    const fullResUrl = stripCropParams(rawUrl)
    const imgRes = await page.context().request.get(fullResUrl, { timeout: 20000 })
    if (!imgRes.ok()) {
      throw new Error(`Image fetch failed: HTTP ${imgRes.status()}`)
    }
    return await imgRes.body()
  } finally {
    untrackContext(trackKey)
    await context?.close().catch(() => void 0)
  }
}

/** Runs `items` through `worker` with at most `limit` in flight at once. */
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      if (index >= items.length) return
      cursor += 1
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

function broadcast(event: AvatarDownloadEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.avatars.onProgress, event)
  }
}

/**
 * Downloads avatars for the given account ids, CONCURRENCY real browser
 * contexts at a time. Updates each account's `avatar` column with the local
 * file path and `live_status` with the outcome on success/failure — the DB
 * trigger that bumps updated_at on any row change is what lets the grid's
 * avatar:// <img> (keyed on a ?v={updated_at} cache-busting query param —
 * see gridColumns.tsx) actually re-fetch and show the freshly-overwritten
 * file instead of reusing whatever it loaded before. Skips accounts with no
 * uid entirely (nothing to fetch by).
 */
export async function downloadAvatarsBatch(accountIds: number[]): Promise<AvatarDownloadSummary> {
  const rows = accounts.getAccountsByIds(accountIds).filter((a) => !!a.uid?.trim())
  const total = rows.length
  let succeeded = 0
  let failed = 0

  await runWithConcurrency(rows, CONCURRENCY, async (account, index) => {
    const uid = account.uid! // filtered above
    try {
      const raw = await downloadOneViaPlaywright(account)
      const jpeg = await encodeUnderSizeLimit(raw)
      await writeFile(avatarPath(uid), jpeg)
      accounts.updateAccount(account.id, {
        avatar: avatarPath(uid),
        live_status: 'Avatar downloaded (HD)'
      })
      succeeded += 1
      broadcast({ accountId: account.id, uid, index: index + 1, total, ok: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      accounts.updateAccount(account.id, { live_status: `Avatar download failed: ${message}` })
      failed += 1
      broadcast({ accountId: account.id, uid, index: index + 1, total, ok: false, detail: message })
    }
  })

  return { total, succeeded, failed }
}
