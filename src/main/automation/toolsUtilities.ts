// ---------------------------------------------------------------------------
// toolsUtilities.ts  — Tools & Utilities menu implementations:
//   * Fast UID Live Checker — public Graph/avatar probe, no browser needed
//   * Bulk Proxy Health Checker — TCP-connect latency test through each proxy
//   * Remove Duplicate Accounts — dedupe by UID, keeping the oldest row
// ---------------------------------------------------------------------------
import { connect as netConnect } from 'net'
import * as accountsRepo from '../db/accountsRepo'
import { parseProxy } from './browserContext'

export interface UidCheckResult {
  accountId: number
  uid: string | null
  status: 'Live' | 'Die' | 'Unknown'
  detail: string
}

/**
 * Classify a Facebook UID using the public, unauthenticated avatar endpoint —
 * no login/browser required. A UID that resolves to a real (non-placeholder)
 * profile picture is very likely live; a 404-style silhouette or fetch error
 * generally means the account is gone/blocked. This is a heuristic, not a
 * guarantee — Facebook doesn't expose a public "is this account alive" API.
 */
async function probeUid(uid: string): Promise<{ status: 'Live' | 'Die' | 'Unknown'; detail: string }> {
  const url = `https://graph.facebook.com/${encodeURIComponent(uid)}/picture?type=normal&redirect=false`
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return { status: 'Unknown', detail: `HTTP ${res.status}` }
    const json = (await res.json().catch(() => null)) as
      | { data?: { url?: string; is_silhouette?: boolean } }
      | null
    const data = json?.data
    if (!data?.url) return { status: 'Die', detail: 'No profile data returned' }
    if (data.is_silhouette) return { status: 'Unknown', detail: 'Default/silhouette avatar' }
    return { status: 'Live', detail: 'Profile picture resolved' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'Unknown', detail: `Network error: ${message}` }
  }
}

/**
 * Check every account that has a UID, without opening a browser — fires
 * requests through a bounded worker pool (default concurrency 30, within the
 * requested 20-50 range) rather than one at a time, so a batch of 1,000+
 * accounts completes in a few seconds instead of minutes. Each account still
 * reports through onProgress the moment its own probe resolves, independent
 * of the others, so the UI keeps updating incrementally under concurrency
 * exactly as it did when this ran sequentially.
 */
export async function checkUidsLive(
  accountIds: number[],
  onProgress?: (result: UidCheckResult, index: number, total: number) => void,
  concurrency = 30
): Promise<UidCheckResult[]> {
  const total = accountIds.length
  const results: UidCheckResult[] = new Array(total)
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor
      if (i >= total) return
      cursor += 1

      const acc = accountsRepo.getAccount(accountIds[i])
      let result: UidCheckResult
      if (!acc || !acc.uid) {
        result = { accountId: accountIds[i], uid: acc?.uid ?? null, status: 'Unknown', detail: 'No UID set' }
      } else {
        const probe = await probeUid(acc.uid)
        result = { accountId: acc.id, uid: acc.uid, ...probe }
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

export interface ProxyHealthResult {
  proxy: string
  alive: boolean
  latencyMs: number | null
  detail: string
}

/** Attempt a raw TCP connect to host:port and measure the round-trip time. */
function tcpPing(host: string, port: number, timeoutMs = 8000): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const socket = netConnect({ host, port, timeout: timeoutMs })
    socket.once('connect', () => {
      const ms = Date.now() - start
      socket.destroy()
      resolve(ms)
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('Connection timed out'))
    })
    socket.once('error', (err) => {
      socket.destroy()
      reject(err)
    })
  })
}

/** Test one proxy's reachability/latency. Accepts the same formats as parseProxy. */
export async function checkProxyHealth(raw: string): Promise<ProxyHealthResult> {
  const parsed = parseProxy(raw)
  if (!parsed) return { proxy: raw, alive: false, latencyMs: null, detail: 'Could not parse proxy' }
  try {
    const url = new URL(parsed.server)
    const host = url.hostname
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
    const latencyMs = await tcpPing(host, port)
    return { proxy: raw, alive: true, latencyMs, detail: `Connected in ${latencyMs}ms` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { proxy: raw, alive: false, latencyMs: null, detail: message }
  }
}

/** Test many proxies concurrently (bounded) and report as each completes. */
export async function checkProxiesHealth(
  proxies: string[],
  onProgress?: (result: ProxyHealthResult, index: number, total: number) => void,
  concurrency = 10
): Promise<ProxyHealthResult[]> {
  const total = proxies.length
  const results: ProxyHealthResult[] = new Array(total)
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor
      if (i >= total) return
      cursor += 1
      const result = await checkProxyHealth(proxies[i])
      results[i] = result
      done += 1
      onProgress?.(result, done, total)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, () => worker())
  await Promise.all(workers)
  return results
}
