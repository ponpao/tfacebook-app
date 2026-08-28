// ---------------------------------------------------------------------------
// friendsGroups.ts  — Friends & Groups batch automation: add friends by UID
// list, add suggested friends, unfriend/cancel sent requests, join groups by
// ID/URL list, join suggested groups, leave groups. Each routine drives one
// account's already-authenticated headed browser (launchContext() injects
// the saved cookie the same way every other automation module here does)
// and always closes its context in a finally block.
// ---------------------------------------------------------------------------
import type { BrowserContext, Page } from 'playwright'
import type { Account } from '../../types/account'
import { launchContext, trackContext, untrackContext } from './browserContext'

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

async function randomDelay(minMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
  const ms = minMs + Math.random() * Math.max(0, maxMs - minMs)
  await raceAbort(new Promise((r) => setTimeout(r, ms)), signal)
}

export interface FriendsGroupsProgressFn {
  (detail: string): void
}

export interface ActionOutcome {
  success: boolean
  detail: string
}

/** Extracts a bare numeric UID or group ID out of a pasted line that may be a raw ID or a full facebook.com URL. */
export function extractIdFromLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  // Bare numeric id.
  if (/^\d+$/.test(trimmed)) return trimmed
  // profile.php?id=123 / groups/123 / groups/123/ style URLs.
  const idParam = trimmed.match(/[?&]id=(\d+)/)
  if (idParam) return idParam[1]
  const pathId = trimmed.match(/\/groups\/(\d+)/) ?? trimmed.match(/facebook\.com\/(\d+)/)
  if (pathId) return pathId[1]
  // A vanity username/slug (facebook.com/some.name or a group's vanity
  // slug) — return the trimmed slug itself so the caller can still
  // navigate to facebook.com/{slug}; not every account/group has a
  // numeric id reachable from a shared link.
  const vanity = trimmed.match(/facebook\.com\/(?:groups\/)?([^/?#]+)/i)
  if (vanity) return vanity[1]
  return trimmed
}

/** Splits a textarea's pasted content into cleaned, deduplicated id/url lines. */
export function parseIdList(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split(/[\r\n,]+/)) {
    const id = extractIdFromLine(line)
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

async function openHeadedContext(account: Account, trackKey: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await launchContext({ headless: false, account })
  trackContext(trackKey, context)
  const page = context.pages()[0] ?? (await context.newPage())
  return { context, page }
}

const ADD_FRIEND_SELECTORS = [
  'div[aria-label="Add Friend"]',
  'button[aria-label="Add Friend"]',
  'div[aria-label="Add friend"]',
  '[aria-label="Add Friend"][role="button"]'
]

const CANCEL_REQUEST_SELECTORS = [
  'div[aria-label="Cancel Request"]',
  'div[aria-label="Cancel request"]',
  'button:has-text("Cancel Request")',
  'button:has-text("Request sent")',
  'div[aria-label="Request sent"]'
]

/**
 * Click "Add Friend" on the current profile page via three fallback
 * strategies tried in order — Facebook renders this control differently
 * across profile layouts (desktop web, mbasic-derived layouts, and
 * localized builds), so no single selector reliably matches every account:
 *   1. aria-label / role=button match, including the Khmer localization
 *      Facebook actually ships ("ថែមជាមិត្តភក្តិ").
 *   2. Text match on the inner <span>, walking up to its clickable
 *      ancestor div[role="button"|tabindex=0] — covers layouts where the
 *      aria-label isn't set on the clickable element itself.
 *   3. A raw DOM query across every div[role="button"] and span for exact
 *      text/aria-label equality, clicking the nearest role="button"
 *      ancestor found — last-resort fallback when neither Playwright
 *      locator strategy above matches anything.
 * Returns true the moment a click actually happens on some element; the
 * caller verifies whether it took effect by checking for the resulting
 * "Cancel request"/"Request sent" state afterward.
 */
async function clickAddFriendButton(page: Page, signal?: AbortSignal): Promise<boolean> {
  // Strategy 1: aria-label / role button, including the Khmer localization.
  const strategy1 = page.locator(
    'div[role="main"] div[aria-label="Add friend"], div[role="main"] div[aria-label="Add Friend"], div[role="main"] div[aria-label="ថែមជាមិត្តភក្តិ"]'
  ).first()
  if (await strategy1.isVisible().catch(() => false)) {
    await raceAbort(strategy1.click({ timeout: 5000 }), signal)
    return true
  }

  // Strategy 2: text match on the inner span, walk up to the clickable ancestor.
  const strategy2 = page
    .locator('div[role="main"] span:has-text("Add friend"), div[role="main"] span:has-text("Add Friend")')
    .locator('xpath=ancestor::div[@role="button" or @tabindex="0"][1]')
    .first()
  if (await strategy2.isVisible().catch(() => false)) {
    await raceAbort(strategy2.click({ timeout: 5000 }), signal)
    return true
  }

  // Strategy 3: raw DOM query fallback, clicking the nearest role=button ancestor.
  const clicked = await page
    .evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('div[role="button"], span'))
      const btn = candidates.find((el) => {
        const text = el.textContent?.trim().toLowerCase()
        const label = el.getAttribute('aria-label')?.toLowerCase()
        return text === 'add friend' || label === 'add friend'
      })
      if (btn) {
        ;(btn.closest('div[role="button"]') ?? btn).dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true })
        )
        return true
      }
      return false
    })
    .catch(() => false)

  return clicked
}

const UNFRIEND_MENU_SELECTORS = ['div[aria-label="Friends"][role="button"]', 'div[aria-label="Friends"]']

const CONFIRM_UNFRIEND_SELECTORS = [
  'div[aria-label="Confirm"]',
  'button:has-text("Confirm")',
  '[role="button"]:has-text("Remove Friend")'
]

const JOIN_GROUP_SELECTORS = [
  'div[aria-label="Join Group"]',
  'button[aria-label="Join Group"]',
  'div[aria-label="Join group"]'
]

const LEAVE_GROUP_MENU_SELECTORS = ['div[aria-label="More"][role="button"]']

/**
 * Add one target UID as a friend by visiting their profile directly and
 * clicking Add Friend. `alreadyFriends`/`requestSent`/`notFound` are
 * distinguished so a batch's per-target log is meaningful rather than a
 * flat pass/fail.
 */
async function isCancelRequestVisible(page: Page): Promise<boolean> {
  for (const sel of CANCEL_REQUEST_SELECTORS) {
    const visible = await page.locator(sel).first().isVisible().catch(() => false)
    if (visible) return true
  }
  return false
}

async function addFriendByUid(page: Page, uid: string, signal?: AbortSignal): Promise<ActionOutcome> {
  checkAborted(signal)
  await raceAbort(
    page.goto(`https://www.facebook.com/profile.php?id=${encodeURIComponent(uid)}`, {
      timeout: 30000,
      waitUntil: 'domcontentloaded'
    }),
    signal
  )
  await randomDelay(1500, 2500, signal)

  const notFound = await page
    .locator('text=/this content isn.t available|page not found/i')
    .first()
    .isVisible()
    .catch(() => false)
  if (notFound) return { success: false, detail: 'Profile not found' }

  // Already sent a request in a previous run — nothing to click.
  if (await isCancelRequestVisible(page)) {
    return { success: true, detail: 'Request already sent' }
  }

  // Human-like pause before interacting with the page at all, then attempt
  // each fallback selector strategy in order via clickAddFriendButton.
  await randomDelay(1000, 2000, signal)
  const clicked = await clickAddFriendButton(page, signal)
  if (!clicked) {
    return { success: false, detail: 'Add Friend button not found (already friends or restricted)' }
  }

  // Verify the click actually took effect — the button transforming into
  // "Cancel request"/"Request sent" is the real confirmation, not just that
  // a click event fired somewhere.
  await randomDelay(1000, 2000, signal)
  const confirmed = await isCancelRequestVisible(page)
  if (confirmed) return { success: true, detail: 'Friend request sent' }

  // No confirmation within the short wait above — check once more after a
  // longer pause before giving up, since Facebook's UI update can lag.
  await randomDelay(1500, 2000, signal)
  if (await isCancelRequestVisible(page)) return { success: true, detail: 'Friend request sent' }

  return { success: false, detail: 'Clicked Add Friend but could not confirm request was sent' }
}

/** Runs addFriendByUid across a list of target UIDs for one already-open account, with a randomized delay between each to avoid a robotic click cadence. */
export async function runAddFriendsByUidList(
  account: Account,
  targetUids: string[],
  options: {
    delayMinSeconds?: number
    delayMaxSeconds?: number
    signal?: AbortSignal
    onProgress?: FriendsGroupsProgressFn
    /** Fired the moment each target resolves (success or failure) — lets a caller consume/strip a target from a saved list the instant it succeeds, without waiting for the whole account's run to finish. */
    onItemDone?: (targetId: string, outcome: ActionOutcome) => void
  } = {}
): Promise<{ success: boolean; detail: string; results: Record<string, ActionOutcome> }> {
  const { delayMinSeconds = 3, delayMaxSeconds = 8, signal, onProgress, onItemDone } = options
  const progress = (label: string): void => onProgress?.(label)
  const trackKey = `friends-add:${account.id}`
  let context: BrowserContext | null = null
  const results: Record<string, ActionOutcome> = {}
  let sent = 0
  // Re-clean the incoming list here too (not just at the modal boundary) —
  // dedupes and strips any stray URL-shaped/empty entries regardless of
  // which caller assembled the array.
  const uids = parseIdList(targetUids.join('\n'))

  try {
    const opened = await openHeadedContext(account, trackKey)
    context = opened.context
    const page = opened.page

    for (const uid of uids) {
      checkAborted(signal)
      progress(`Adding friend ${uid}...`)
      try {
        const outcome = await addFriendByUid(page, uid, signal)
        results[uid] = outcome
        if (outcome.success) sent += 1
        onItemDone?.(uid, outcome)
      } catch (err) {
        if (err instanceof AbortedError) throw err
        const outcome: ActionOutcome = { success: false, detail: err instanceof Error ? err.message : String(err) }
        results[uid] = outcome
        onItemDone?.(uid, outcome)
      }
      await randomDelay(delayMinSeconds * 1000, delayMaxSeconds * 1000, signal)
    }

    return {
      success: sent > 0,
      detail: `${sent}/${uids.length} friend request(s) sent`,
      results
    }
  } catch (err) {
    if (err instanceof AbortedError) return { success: false, detail: 'Cancelled by user', results }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, detail: `Add Friends error: ${message}`, results }
  } finally {
    untrackContext(trackKey)
    await context?.close().catch(() => void 0)
  }
}

/**
 * Opens Facebook's own "People You May Know" suggestions and clicks Add
 * Friend on up to `maxCount` of them, with a randomized delay between each.
 */
export async function runAddSuggestedFriends(
  account: Account,
  options: { maxCount?: number; delayMinSeconds?: number; delayMaxSeconds?: number; signal?: AbortSignal; onProgress?: FriendsGroupsProgressFn } = {}
): Promise<ActionOutcome> {
  const { maxCount = 10, delayMinSeconds = 3, delayMaxSeconds = 8, signal, onProgress } = options
  const progress = (label: string): void => onProgress?.(label)
  const trackKey = `friends-suggested:${account.id}`
  let context: BrowserContext | null = null

  try {
    const opened = await openHeadedContext(account, trackKey)
    context = opened.context
    const page = opened.page

    checkAborted(signal)
    progress('Opening friend suggestions...')
    await raceAbort(
      page.goto('https://www.facebook.com/friends/suggestions', { timeout: 30000, waitUntil: 'domcontentloaded' }),
      signal
    )
    await randomDelay(2000, 3000, signal)

    let clicked = 0
    for (let i = 0; i < maxCount; i++) {
      checkAborted(signal)
      const buttons = page.locator(ADD_FRIEND_SELECTORS.join(', '))
      const count = await buttons.count().catch(() => 0)
      if (count === 0) break
      const btn = buttons.first()
      const visible = await btn.isVisible().catch(() => false)
      if (!visible) break
      progress(`Adding suggested friend ${clicked + 1}/${maxCount}...`)
      await raceAbort(btn.click({ timeout: 5000 }).catch(() => void 0), signal)
      clicked += 1
      await randomDelay(delayMinSeconds * 1000, delayMaxSeconds * 1000, signal)
    }

    return { success: clicked > 0, detail: `${clicked} suggested friend request(s) sent` }
  } catch (err) {
    if (err instanceof AbortedError) return { success: false, detail: 'Cancelled by user' }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, detail: `Add Suggested Friends error: ${message}` }
  } finally {
    untrackContext(trackKey)
    await context?.close().catch(() => void 0)
  }
}

/**
 * Walks the account's own friends list and unfriends every entry (used for
 * "clean out inactive/target accounts" — the caller decides which accounts
 * to run this on; this always processes the full list it finds, since
 * Facebook's friends list page has no reliable "inactive" filter to
 * automate against). Also cancels any outgoing sent friend requests first.
 */
export async function runUnfriendAll(
  account: Account,
  options: { maxCount?: number; delayMinSeconds?: number; delayMaxSeconds?: number; signal?: AbortSignal; onProgress?: FriendsGroupsProgressFn } = {}
): Promise<ActionOutcome> {
  const { maxCount = 50, delayMinSeconds = 3, delayMaxSeconds = 8, signal, onProgress } = options
  const progress = (label: string): void => onProgress?.(label)
  const trackKey = `friends-unfriend:${account.id}`
  let context: BrowserContext | null = null

  try {
    const opened = await openHeadedContext(account, trackKey)
    context = opened.context
    const page = opened.page

    // ---- Cancel any outgoing sent requests first. ----
    checkAborted(signal)
    progress('Cancelling sent friend requests...')
    await raceAbort(
      page.goto('https://www.facebook.com/friends/requests/outgoing', {
        timeout: 30000,
        waitUntil: 'domcontentloaded'
      }),
      signal
    )
    await randomDelay(1500, 2500, signal)
    let cancelled = 0
    for (let i = 0; i < maxCount; i++) {
      checkAborted(signal)
      const buttons = page.locator(CANCEL_REQUEST_SELECTORS.join(', '))
      const visible = await buttons.first().isVisible().catch(() => false)
      if (!visible) break
      await raceAbort(buttons.first().click({ timeout: 5000 }).catch(() => void 0), signal)
      cancelled += 1
      await randomDelay(delayMinSeconds * 1000, delayMaxSeconds * 1000, signal)
    }

    // ---- Unfriend existing friends. ----
    checkAborted(signal)
    progress('Opening friends list...')
    await raceAbort(
      page.goto('https://www.facebook.com/friends/list', { timeout: 30000, waitUntil: 'domcontentloaded' }),
      signal
    )
    await randomDelay(2000, 3000, signal)

    let unfriended = 0
    for (let i = 0; i < maxCount; i++) {
      checkAborted(signal)
      const menuBtn = page.locator(UNFRIEND_MENU_SELECTORS.join(', ')).first()
      const visible = await menuBtn.isVisible().catch(() => false)
      if (!visible) break
      progress(`Unfriending ${unfriended + 1}...`)
      await raceAbort(menuBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
      await randomDelay(600, 1200, signal)

      const unfriendItem = page.locator('div[role="menuitem"]:has-text("Unfriend")').first()
      const itemVisible = await unfriendItem.isVisible().catch(() => false)
      if (!itemVisible) continue
      await raceAbort(unfriendItem.click({ timeout: 5000 }).catch(() => void 0), signal)
      await randomDelay(600, 1200, signal)

      for (const sel of CONFIRM_UNFRIEND_SELECTORS) {
        const confirmBtn = page.locator(sel).first()
        const confirmVisible = await confirmBtn.isVisible().catch(() => false)
        if (confirmVisible) {
          await raceAbort(confirmBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
          unfriended += 1
          break
        }
      }
      await randomDelay(delayMinSeconds * 1000, delayMaxSeconds * 1000, signal)
    }

    return {
      success: cancelled > 0 || unfriended > 0,
      detail: `${cancelled} request(s) cancelled, ${unfriended} friend(s) removed`
    }
  } catch (err) {
    if (err instanceof AbortedError) return { success: false, detail: 'Cancelled by user' }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, detail: `Unfriend error: ${message}` }
  } finally {
    untrackContext(trackKey)
    await context?.close().catch(() => void 0)
  }
}

/** Navigates directly to one group id/slug/URL fragment and clicks Join Group if present. */
async function joinGroupById(page: Page, groupId: string, signal?: AbortSignal): Promise<ActionOutcome> {
  checkAborted(signal)
  const url = /^\d+$/.test(groupId)
    ? `https://www.facebook.com/groups/${groupId}`
    : groupId.includes('facebook.com')
      ? groupId
      : `https://www.facebook.com/groups/${groupId}`
  await raceAbort(page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }), signal)
  await randomDelay(1500, 2500, signal)

  const notFound = await page
    .locator('text=/this content isn.t available|page not found/i')
    .first()
    .isVisible()
    .catch(() => false)
  if (notFound) return { success: false, detail: 'Group not found' }

  for (const sel of JOIN_GROUP_SELECTORS) {
    const btn = page.locator(sel).first()
    const visible = await btn.isVisible().catch(() => false)
    if (!visible) continue
    await raceAbort(btn.click({ timeout: 5000 }), signal)
    await randomDelay(800, 1500, signal)
    return { success: true, detail: 'Join request sent' }
  }

  return { success: false, detail: 'Join Group button not found (already a member or restricted)' }
}

/** Runs joinGroupById across a list of target group ids/URLs for one already-open account. */
export async function runJoinGroupsByIdList(
  account: Account,
  targetGroups: string[],
  options: {
    delayMinSeconds?: number
    delayMaxSeconds?: number
    signal?: AbortSignal
    onProgress?: FriendsGroupsProgressFn
    /** Fired the moment each target resolves (success or failure) — lets a caller consume/strip a target from a saved list the instant it succeeds, without waiting for the whole account's run to finish. */
    onItemDone?: (targetId: string, outcome: ActionOutcome) => void
  } = {}
): Promise<{ success: boolean; detail: string; results: Record<string, ActionOutcome> }> {
  const { delayMinSeconds = 3, delayMaxSeconds = 8, signal, onProgress, onItemDone } = options
  const progress = (label: string): void => onProgress?.(label)
  const trackKey = `groups-join:${account.id}`
  let context: BrowserContext | null = null
  const results: Record<string, ActionOutcome> = {}
  let joined = 0
  // Re-clean the incoming list here too (not just at the modal boundary) —
  // dedupes and extracts a bare id/slug out of a pasted full group URL
  // regardless of which caller assembled the array.
  const groupIds = parseIdList(targetGroups.join('\n'))

  try {
    const opened = await openHeadedContext(account, trackKey)
    context = opened.context
    const page = opened.page

    for (const groupId of groupIds) {
      checkAborted(signal)
      progress(`Joining group ${groupId}...`)
      try {
        const outcome = await joinGroupById(page, groupId, signal)
        results[groupId] = outcome
        if (outcome.success) joined += 1
        onItemDone?.(groupId, outcome)
      } catch (err) {
        if (err instanceof AbortedError) throw err
        const outcome: ActionOutcome = { success: false, detail: err instanceof Error ? err.message : String(err) }
        results[groupId] = outcome
        onItemDone?.(groupId, outcome)
      }
      await randomDelay(delayMinSeconds * 1000, delayMaxSeconds * 1000, signal)
    }

    return { success: joined > 0, detail: `${joined}/${groupIds.length} group(s) joined`, results }
  } catch (err) {
    if (err instanceof AbortedError) return { success: false, detail: 'Cancelled by user', results }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, detail: `Join Groups error: ${message}`, results }
  } finally {
    untrackContext(trackKey)
    await context?.close().catch(() => void 0)
  }
}

/** Opens Facebook's own group discovery/suggestions page and joins up to `maxCount` recommended groups. */
export async function runJoinSuggestedGroups(
  account: Account,
  options: { maxCount?: number; delayMinSeconds?: number; delayMaxSeconds?: number; signal?: AbortSignal; onProgress?: FriendsGroupsProgressFn } = {}
): Promise<ActionOutcome> {
  const { maxCount = 10, delayMinSeconds = 3, delayMaxSeconds = 8, signal, onProgress } = options
  const progress = (label: string): void => onProgress?.(label)
  const trackKey = `groups-suggested:${account.id}`
  let context: BrowserContext | null = null

  try {
    const opened = await openHeadedContext(account, trackKey)
    context = opened.context
    const page = opened.page

    checkAborted(signal)
    progress('Opening group suggestions...')
    await raceAbort(
      page.goto('https://www.facebook.com/groups/discover/', { timeout: 30000, waitUntil: 'domcontentloaded' }),
      signal
    )
    await randomDelay(2000, 3000, signal)

    let joined = 0
    for (let i = 0; i < maxCount; i++) {
      checkAborted(signal)
      const buttons = page.locator(JOIN_GROUP_SELECTORS.join(', '))
      const count = await buttons.count().catch(() => 0)
      if (count === 0) break
      const btn = buttons.first()
      const visible = await btn.isVisible().catch(() => false)
      if (!visible) break
      progress(`Joining suggested group ${joined + 1}/${maxCount}...`)
      await raceAbort(btn.click({ timeout: 5000 }).catch(() => void 0), signal)
      joined += 1
      await randomDelay(delayMinSeconds * 1000, delayMaxSeconds * 1000, signal)
    }

    return { success: joined > 0, detail: `${joined} suggested group(s) joined` }
  } catch (err) {
    if (err instanceof AbortedError) return { success: false, detail: 'Cancelled by user' }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, detail: `Join Suggested Groups error: ${message}` }
  } finally {
    untrackContext(trackKey)
    await context?.close().catch(() => void 0)
  }
}

/** Walks the account's joined-groups list and leaves up to `maxCount` of them. */
export async function runLeaveGroups(
  account: Account,
  options: { maxCount?: number; delayMinSeconds?: number; delayMaxSeconds?: number; signal?: AbortSignal; onProgress?: FriendsGroupsProgressFn } = {}
): Promise<ActionOutcome> {
  const { maxCount = 50, delayMinSeconds = 3, delayMaxSeconds = 8, signal, onProgress } = options
  const progress = (label: string): void => onProgress?.(label)
  const trackKey = `groups-leave:${account.id}`
  let context: BrowserContext | null = null

  try {
    const opened = await openHeadedContext(account, trackKey)
    context = opened.context
    const page = opened.page

    checkAborted(signal)
    progress('Opening joined groups...')
    await raceAbort(
      page.goto('https://www.facebook.com/groups/joins/?nav_source=tab', {
        timeout: 30000,
        waitUntil: 'domcontentloaded'
      }),
      signal
    )
    await randomDelay(2000, 3000, signal)

    let left = 0
    for (let i = 0; i < maxCount; i++) {
      checkAborted(signal)
      const menuBtn = page.locator(LEAVE_GROUP_MENU_SELECTORS.join(', ')).first()
      const visible = await menuBtn.isVisible().catch(() => false)
      if (!visible) break
      progress(`Leaving group ${left + 1}...`)
      await raceAbort(menuBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
      await randomDelay(600, 1200, signal)

      const leaveItem = page.locator('div[role="menuitem"]:has-text("Leave Group")').first()
      const itemVisible = await leaveItem.isVisible().catch(() => false)
      if (!itemVisible) continue
      await raceAbort(leaveItem.click({ timeout: 5000 }).catch(() => void 0), signal)
      await randomDelay(600, 1200, signal)

      const confirmBtn = page.locator('button:has-text("Leave Group"), div[aria-label="Leave Group"]').first()
      const confirmVisible = await confirmBtn.isVisible().catch(() => false)
      if (confirmVisible) {
        await raceAbort(confirmBtn.click({ timeout: 5000 }).catch(() => void 0), signal)
      }
      left += 1
      await randomDelay(delayMinSeconds * 1000, delayMaxSeconds * 1000, signal)
    }

    return { success: left > 0, detail: `${left} group(s) left` }
  } catch (err) {
    if (err instanceof AbortedError) return { success: false, detail: 'Cancelled by user' }
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, detail: `Leave Groups error: ${message}` }
  } finally {
    untrackContext(trackKey)
    await context?.close().catch(() => void 0)
  }
}
