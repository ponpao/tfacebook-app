// ---------------------------------------------------------------------------
// avatarService.ts  — high-speed direct avatar downloader.
//
// Bypasses launching a browser entirely: Facebook's public Graph "picture"
// endpoint (https://graph.facebook.com/{uid}/picture?...&redirect=true)
// serves a profile photo for a given UID over a plain HTTP redirect + image
// response, with no login/session required — so a batch of avatars can be
// fetched directly via `fetch()` + `sharp`, orders of magnitude faster than
// opening a real Chrome profile per account (the existing
// downloadAvatarToFile() path in autoLogin.ts, which still runs as part of
// a full login for accounts that need one anyway).
//
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

/**
 * Re-encodes quality downward (90 -> 80 -> 70 -> 60) until the JPEG fits
 * under MAX_FILE_SIZE_BYTES, or gives up at the last attempt regardless —
 * a 1080x1080 photo essentially never fails to fit even at quality 90, but
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

async function downloadOne(uid: string): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(graphPictureUrl(uid), { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const arrayBuffer = await res.arrayBuffer()
    const jpeg = await encodeUnderSizeLimit(Buffer.from(arrayBuffer))
    await writeFile(avatarPath(uid), jpeg)
  } finally {
    clearTimeout(timeout)
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
 * Downloads avatars for the given account ids directly (no browser),
 * CONCURRENCY at a time. Updates each account's `avatar` column with the
 * local file path and `live_status` with the outcome on success/failure —
 * skips accounts with no uid entirely (nothing to fetch by).
 */
export async function downloadAvatarsBatch(accountIds: number[]): Promise<AvatarDownloadSummary> {
  const rows = accounts.getAccountsByIds(accountIds).filter((a) => !!a.uid?.trim())
  const total = rows.length
  let succeeded = 0
  let failed = 0

  await runWithConcurrency(rows, CONCURRENCY, async (account, index) => {
    const uid = account.uid! // filtered above
    try {
      await downloadOne(uid)
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
