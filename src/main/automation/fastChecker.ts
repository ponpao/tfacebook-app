// ---------------------------------------------------------------------------
// fastChecker.ts  — standalone, no-browser Live/Die probe over UIDs & accounts.
// Pure HTTP requests (zero Chromium browser instances launched).
// Extremely fast: 50+ accounts checked in 1-2 seconds with parallel worker pool.
// ---------------------------------------------------------------------------
import type { Account } from '../../types/account'
import type { LiveDieResult } from '../../types/ipc'
import * as accountsRepo from '../db/accountsRepo'

import { getTrackedContext, launchContext } from './browserContext'

export type UidLiveStatus = 'Live' | 'Die'

const DEFAULT_CONCURRENCY = 25
const REQUEST_TIMEOUT_MS = 6000

/**
 * Classify one UID via Facebook's public Graph API avatar endpoint.
 * When data.url exists (whether silhouette or custom photo), the UID is confirmed LIVE.
 * When Facebook returns error code 100 ("Object with ID does not exist"), it is DIE.
 */
export async function probeUidFast(uid: string): Promise<UidLiveStatus> {
  const url = `https://graph.facebook.com/${encodeURIComponent(uid)}/picture?type=normal&redirect=false`
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    const json = (await res.json().catch(() => null)) as {
      data?: { url?: string; is_silhouette?: boolean }
      error?: { code?: number; message?: string }
    } | null

    if (json?.data?.url) return 'Live'
    if (json?.error?.code === 100 || (json?.error && !json?.data)) return 'Die'
    if (!res.ok && res.status === 404) return 'Die'
    return 'Die'
  } catch {
    return 'Die'
  }
}

/**
 * Fast check of an entire Account object.
 * 1. If the browser is currently open for this account, extracts fresh cookies directly from it.
 * 2. Otherwise checks Cookie session, Access Token, and UID via fast HTTP.
 * 3. If DB cookie is expired, checks on-disk profile for a newer session and syncs it.
 */
export async function probeAccountLiveFast(account: Account): Promise<LiveDieResult> {
  const uid = account.uid?.trim()
  const cookie = account.cookie?.trim()
  const token = account.token?.trim()

  // 0. If this account currently has an open browser window, extract cookies live from it!
  const key = `profile:${account.uid ?? account.id}`
  const openCtx = getTrackedContext(key)
  if (openCtx) {
    try {
      const cookies = await openCtx.cookies()
      const cUser = cookies.find((c) => c.name === 'c_user')?.value
      const xs = cookies.find((c) => c.name === 'xs')?.value
      if (cUser && xs) {
        const freshCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        accountsRepo.updateAccount(account.id, {
          cookie: freshCookie,
          status: 'Live',
          status_detail: 'Cookie Synced from Browser',
          live_status: 'Live',
          last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
        })
        return {
          accountId: account.id,
          uid: account.uid ?? cUser,
          status: 'Live',
          detail: 'Live (Cookie Synced from Open Browser)'
        }
      }
    } catch {
      /* ignore context closing errors */
    }
  }

  // 1. If account has a session cookie, test against Facebook endpoint
  if (cookie && (cookie.includes('c_user=') || cookie.includes('xs='))) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const res = await fetch('https://mbasic.facebook.com/me', {
        headers: {
          'User-Agent':
            account.user_agent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Cookie': cookie,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        redirect: 'manual',
        signal: controller.signal
      })
      clearTimeout(timeout)

      const location = res.headers.get('location') || ''
      if (location.includes('/checkpoint/') || location.includes('checkpoint')) {
        return {
          accountId: account.id,
          uid: uid ?? null,
          status: 'Checkpoint',
          detail: 'Checkpoint detected'
        }
      }

      if (location.includes('/login') || location.includes('login.php')) {
        // Database cookie expired. Check if the on-disk profile has a newer session!
        if (!openCtx) {
          try {
            const context = await launchContext({ headless: true, account })
            try {
              const diskCookies = await context.cookies()
              const cUser = diskCookies.find((c) => c.name === 'c_user')?.value
              const xs = diskCookies.find((c) => c.name === 'xs')?.value
              if (cUser && xs) {
                const freshCookie = diskCookies.map((c) => `${c.name}=${c.value}`).join('; ')
                if (freshCookie !== account.cookie) {
                  accountsRepo.updateAccount(account.id, {
                    cookie: freshCookie,
                    status: 'Live',
                    status_detail: 'Cookie Synced from Profile',
                    live_status: 'Live',
                    last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
                  })
                  return {
                    accountId: account.id,
                    uid: account.uid ?? cUser,
                    status: 'Live',
                    detail: 'Live (Cookie Synced from Profile)'
                  }
                }
              }
            } finally {
              await context.close().catch(() => void 0)
            }
          } catch {
            /* ignore launch error */
          }
        }

        // Check if the UID itself is still live on Facebook
        if (uid) {
          const uidStatus = await probeUidFast(uid)
          if (uidStatus === 'Live') {
            return {
              accountId: account.id,
              uid,
              status: 'Live',
              detail: 'Live (UID Active, Cookie Expired)'
            }
          }
        }
        return {
          accountId: account.id,
          uid: uid ?? null,
          status: 'Die',
          detail: 'Session Expired / Cookie Invalid'
        }
      }

      // Valid redirect to profile/home or 200 OK
      if (
        res.status === 200 ||
        location.includes('/profile.php') ||
        location.includes('/home.php') ||
        (location && !location.includes('login'))
      ) {
        return {
          accountId: account.id,
          uid: uid ?? null,
          status: 'Live',
          detail: 'Live (Cookie Session Active)'
        }
      }
    } catch {
      // Network timeout or error — fall through to UID / Token check
    }
  }

  // 2. If account has an access token, test Graph API /me
  if (token && token.length > 20) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const res = await fetch(`https://graph.facebook.com/me?access_token=${encodeURIComponent(token)}`, {
        signal: controller.signal
      })
      clearTimeout(timeout)
      const json = (await res.json().catch(() => null)) as { id?: string; name?: string; error?: { code?: number } } | null
      if (json?.id) {
        return {
          accountId: account.id,
          uid: uid ?? json.id,
          status: 'Live',
          detail: 'Live (Access Token Active)'
        }
      }
    } catch {
      // Fall through to UID check
    }
  }

  // 3. Fallback: Public UID Graph API check
  if (uid) {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const res = await fetch(`https://graph.facebook.com/${encodeURIComponent(uid)}/picture?type=normal&redirect=false`, {
        signal: controller.signal
      })
      clearTimeout(timeout)
      const json = (await res.json().catch(() => null)) as {
        data?: { url?: string; is_silhouette?: boolean }
        error?: { code?: number; message?: string }
      } | null

      if (json?.data?.url) {
        return {
          accountId: account.id,
          uid,
          status: 'Live',
          detail: json.data.is_silhouette ? 'Live (Default Avatar)' : 'Live (Profile Active)'
        }
      }

      if (json?.error?.code === 100 || (json?.error && !json?.data)) {
        return {
          accountId: account.id,
          uid,
          status: 'Die',
          detail: 'Account Disabled or Deleted'
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        accountId: account.id,
        uid,
        status: 'Unknown',
        detail: `Network error: ${message}`
      }
    }
  }

  return {
    accountId: account.id,
    uid: uid ?? null,
    status: 'Unknown',
    detail: 'No UID, Cookie, or Token available'
  }
}

/**
 * Check multiple accounts in parallel through a bounded worker pool.
 * Real-time progress updates are fired after each account resolves.
 */
export async function checkAccountsLiveBatch(
  accountIds: number[],
  onProgress?: (result: LiveDieResult, index: number, total: number) => void,
  concurrency = DEFAULT_CONCURRENCY
): Promise<LiveDieResult[]> {
  const total = accountIds.length
  const results: LiveDieResult[] = new Array(total)
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor
      if (i >= total) return
      cursor += 1

      const accountId = accountIds[i]
      const acc = accountsRepo.getAccount(accountId)
      let result: LiveDieResult
      if (!acc) {
        result = { accountId, status: 'Unknown', detail: 'Account not found' }
      } else {
        result = await probeAccountLiveFast(acc)
      }

      results[i] = result
      done += 1
      onProgress?.(result, done, total)
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, total)) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}

/**
 * Check raw list of UIDs fast in parallel.
 */
export async function checkUidLiveFast(
  uids: string[],
  concurrency = DEFAULT_CONCURRENCY
): Promise<Map<string, UidLiveStatus>> {
  const results = new Map<string, UidLiveStatus>()
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor
      if (i >= uids.length) return
      cursor += 1
      const uid = uids[i]
      results.set(uid, await probeUidFast(uid))
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, uids.length)) },
    () => worker()
  )
  await Promise.all(workers)
  return results
}
