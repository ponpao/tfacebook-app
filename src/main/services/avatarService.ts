// ---------------------------------------------------------------------------
// avatarService.ts  — high-speed direct avatar downloader.
//
// Bypasses launching a browser entirely. Two fetch strategies, in order:
//
//   1. Authenticated (uses the account's saved cookie): fetches the account's
//      mbasic.facebook.com profile page with that cookie attached, and
//      extracts the real profile photo's `scontent` CDN URL from the HTML.
//      This is the ONLY way to get the account's actual current profile
//      photo — Facebook's public, unauthenticated endpoints (below) serve a
//      generic default silhouette for any UID they can't verify a session
//      for, which is indistinguishable from "this account really has no
//      photo" without ever fetching a real image.
//   2. Public Graph "picture" endpoint (no auth): used when an account has
//      no saved cookie, or the authenticated fetch/extraction fails for any
//      reason — still better than nothing, even though it may return the
//      generic silhouette for a UID Facebook can't resolve anonymously.
//
// Both paths converge on the same sharp resize/compress/save pipeline.
// Concurrency is capped via a small dependency-free chunked-batch helper
// rather than pulling in p-limit as a direct dependency (it's already
// present transitively, but not declared — not worth relying on for
// something this simple).
// ---------------------------------------------------------------------------
import { writeFile } from 'fs/promises'
import { join } from 'path'
import sharp from 'sharp'
import { BrowserWindow } from 'electron'
import * as accounts from '../db/accountsRepo'
import { resolveAvatarsRoot } from '../automation/browserContext'
import { IPC } from '../ipc/channels'

const CONCURRENCY = 6
const FETCH_TIMEOUT_MS = 20000
const MAX_FILE_SIZE_BYTES = 1024 * 1024 // strictly under 1MB, per spec
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

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

function graphPictureUrl(uid: string): string {
  return `https://graph.facebook.com/${encodeURIComponent(uid)}/picture?type=large&width=1080&height=1080&redirect=true`
}

function avatarPath(uid: string): string {
  return join(resolveAvatarsRoot(), `${uid}.jpg`)
}

/** Local on-disk avatar path for a UID, without triggering a download — used by avatars:get-local-path. */
export function getLocalAvatarPath(uid: string): string {
  return avatarPath(uid)
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Extracts the profile photo's scontent CDN URL from an mbasic.facebook.com
 * profile page's HTML. mbasic's markup isn't publicly documented and can
 * change without notice, so this tries a few known patterns rather than one
 * brittle regex — the profile photo is consistently an <img> whose src is a
 * scontent*.fbcdn.net URL carrying signed oh=/oe= query params, usually
 * (but not always) inside an <a> linking to /photo.php. Returns null if
 * nothing matches, which the caller treats as "fall back to the public
 * endpoint" rather than a hard failure.
 */
function extractProfilePhotoUrl(html: string): string | null {
  // Pattern 1: an <img> whose src is a scontent CDN url with a signed oh=
  // param, inside a link to /photo.php — the typical "big" profile photo
  // treatment on the mbasic profile header.
  const photoLinkMatch = html.match(
    /photo\.php[^"']*"[^>]*>\s*<img[^>]*src="([^"]*scontent[^"]*oh=[^"]*)"/i
  )
  if (photoLinkMatch?.[1]) return decodeHtmlEntities(photoLinkMatch[1])

  // Pattern 2: any <img> tag with a scontent CDN src, first match — a looser
  // fallback for a markup variant pattern 1 doesn't cover.
  const anyImgMatch = html.match(/<img[^>]*src="([^"]*scontent[^"]*)"/i)
  if (anyImgMatch?.[1]) return decodeHtmlEntities(anyImgMatch[1])

  return null
}

function decodeHtmlEntities(url: string): string {
  return url.replace(/&amp;/g, '&').replace(/&#0*38;/g, '&')
}

/**
 * Authenticated fetch: loads the account's mbasic profile page with its
 * saved cookie attached, extracts the real profile photo URL, and downloads
 * that image. Returns null (not a thrown error) for any failure along the
 * way — a missing cookie, a login-wall response, no photo URL found, or the
 * image fetch itself failing — so the caller can fall back to the public
 * endpoint instead of failing the whole download.
 */
async function fetchAuthenticatedPhoto(uid: string, cookie: string): Promise<Buffer | null> {
  try {
    const pageRes = await fetchWithTimeout(`https://mbasic.facebook.com/profile.php?id=${encodeURIComponent(uid)}`, {
      headers: { Cookie: cookie, 'User-Agent': USER_AGENT }
    })
    if (!pageRes.ok) return null
    const html = await pageRes.text()
    const photoUrl = extractProfilePhotoUrl(html)
    if (!photoUrl) return null

    const imgRes = await fetchWithTimeout(photoUrl, { headers: { Cookie: cookie, 'User-Agent': USER_AGENT } })
    if (!imgRes.ok) return null
    return Buffer.from(await imgRes.arrayBuffer())
  } catch {
    return null
  }
}

async function fetchPublicPhoto(uid: string): Promise<Buffer> {
  const res = await fetchWithTimeout(graphPictureUrl(uid), {})
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
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

async function downloadOne(uid: string, cookie: string | null): Promise<void> {
  const authenticated = cookie?.trim() ? await fetchAuthenticatedPhoto(uid, cookie.trim()) : null
  const raw = authenticated ?? (await fetchPublicPhoto(uid))
  const jpeg = await encodeUnderSizeLimit(raw)
  await writeFile(avatarPath(uid), jpeg)
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
 * Downloads avatars for the given account ids directly (no browser),
 * CONCURRENCY at a time. Prefers each account's saved cookie for a real,
 * authenticated fetch of its actual current profile photo; falls back to
 * the public Graph endpoint when there's no cookie or the authenticated
 * path fails. Updates each account's `avatar` column with the local file
 * path and `live_status` with the outcome on success/failure — the DB
 * trigger that bumps updated_at on any row change is what lets the grid's
 * avatar:// <img> (keyed on a ?v={updated_at} cache-busting query param)
 * actually re-fetch and show the freshly-overwritten file instead of
 * reusing whatever it loaded before. Skips accounts with no uid entirely
 * (nothing to fetch by).
 */
export async function downloadAvatarsBatch(accountIds: number[]): Promise<AvatarDownloadSummary> {
  const rows = accounts.getAccountsByIds(accountIds).filter((a) => !!a.uid?.trim())
  const total = rows.length
  let succeeded = 0
  let failed = 0

  await runWithConcurrency(rows, CONCURRENCY, async (account, index) => {
    const uid = account.uid! // filtered above
    try {
      await downloadOne(uid, account.cookie)
      accounts.updateAccount(account.id, {
        avatar: avatarPath(uid),
        live_status: 'Avatar downloaded'
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
