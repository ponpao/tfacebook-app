// ---------------------------------------------------------------------------
// fastChecker.ts  — standalone, no-browser Live/Die probe over raw UIDs (not
// scoped to accounts already in the database). Same underlying Graph/avatar
// heuristic as toolsUtilities.ts's checkUidsLive, exposed here as a plain
// uid -> status map for callers that just have a list of UIDs to test.
// ---------------------------------------------------------------------------

export type UidLiveStatus = 'Live' | 'Die'

const DEFAULT_CONCURRENCY = 30
const REQUEST_TIMEOUT_MS = 10000

/**
 * Classify one UID via Facebook's public, unauthenticated avatar endpoint —
 * no login/browser required. A resolvable, non-silhouette profile picture
 * means the account is very likely live; anything else (404, no data, a
 * default silhouette, a network error) is treated as Die. This is a
 * heuristic, not a guarantee — Facebook exposes no public "is this account
 * alive" API — callers wanting the finer 'Unknown' distinction (e.g. a
 * default avatar that could just mean no profile photo) should use
 * toolsUtilities.ts's checkUidsLive instead, which keeps that third state.
 */
async function probeUidFast(uid: string): Promise<UidLiveStatus> {
  const url = `https://graph.facebook.com/${encodeURIComponent(uid)}/picture?type=normal&redirect=false`
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) return 'Die'
    const json = (await res.json().catch(() => null)) as
      | { data?: { url?: string; is_silhouette?: boolean } }
      | null
    const data = json?.data
    if (!data?.url) return 'Die'
    return data.is_silhouette ? 'Die' : 'Live'
  } catch {
    return 'Die'
  }
}

/**
 * Check up to thousands of UIDs in parallel through a bounded worker pool
 * (default concurrency 30, within the requested 20-50 range) — no Chromium
 * instance is ever launched, so a batch of 1,000+ UIDs typically finishes in
 * a few seconds rather than minutes.
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
