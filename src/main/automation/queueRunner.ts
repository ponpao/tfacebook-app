// ---------------------------------------------------------------------------
// queueRunner.ts  — multi-thread queue manager for running auto-login across
// many accounts at once.
//   * configurable concurrency (worker pool)
//   * cooperative cancellation via AbortController — Stop closes all running
//     browsers and drops anything still queued
//   * live progress broadcast to the renderer over IPC
// ---------------------------------------------------------------------------
import { BrowserWindow } from 'electron'
import type { Page } from 'playwright'
import type { Account } from '../../types/account'
import type { Scenario, ScenarioStep } from '../../types/scenario'
import { runAutoLogin, AbortedError, type ProgressStage } from './autoLogin'
import { closeAll as closeAllBrowserWindows } from './browserContext'
import {
  scrollNewsfeed,
  likeRandomPosts,
  watchReelsOrVideos,
  viewStories,
  viewPhotoPosts,
  visitProfile,
  randomDelay,
  safeBackToFeed,
  type ScenarioStepContext,
  type ScenarioActionResult
} from './scenarios'
import * as accountsRepo from '../db/accountsRepo'
import * as scenariosRepo from '../db/scenariosRepo'
import { getAppSettings } from '../db/settingsRepo'
import {
  beginRun,
  endRun,
  isCurrentRun,
  isAnyBatchRunning,
  stopActiveRun
} from './activeRun'

export interface QueueProgressEvent {
  accountId: number
  uid: string | null
  stage: ProgressStage
  detail?: string
  /** Index of this account's position in the run (1-based) + total queued. */
  index: number
  total: number
}

export interface QueueSummary {
  total: number
  succeeded: number
  failed: number
  cancelled: boolean
}

const PROGRESS_CHANNEL = 'automation:onProgress'
const ACCOUNT_UPDATED_CHANNEL = 'automation:onAccountUpdated'
const DONE_CHANNEL = 'automation:onQueueDone'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/**
 * Re-reads the account row right after a DB write and broadcasts the full,
 * current record — the renderer's store patches this straight into its
 * in-memory row (applyAccountUpdate) so Friends/Groups/Followers/Pages/
 * Cookie/Token/Avatar/locations/Created Date/Status all render live as each
 * account finishes, instead of only becoming visible after a manual
 * refresh(). Re-reading rather than broadcasting the write payload directly
 * keeps this immune to whichever subset of fields a given call happened to
 * patch — the row broadcast is always the complete, authoritative record.
 */
function broadcastAccountUpdate(accountId: number): void {
  const fresh = accountsRepo.getAccount(accountId)
  if (fresh) broadcast(ACCOUNT_UPDATED_CHANNEL, fresh)
}

/** Integer in [min, max], swapped if given out of order. */
function randInt(min: number, max: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return Math.round(lo + Math.random() * (hi - lo))
}

/**
 * Execute one scenario step against an already-logged-in page. Each step
 * type maps to its scenarios.ts implementation with min/max params resolved
 * to a single randomized value per run.
 */
async function runScenarioStep(step: ScenarioStep, ctx: ScenarioStepContext): Promise<ScenarioActionResult> {
  switch (step.type) {
    case 'scroll_newsfeed':
      return scrollNewsfeed(
        ctx,
        randInt(step.minSeconds, step.maxSeconds),
        step.scrollMode ?? 'down_and_up'
      )
    case 'like_random_posts':
      return likeRandomPosts(ctx, randInt(step.minCount, step.maxCount))
    case 'watch_reels':
      return watchReelsOrVideos(
        ctx,
        randInt(step.minCount, step.maxCount),
        randInt(step.minDurationSeconds, step.maxDurationSeconds)
      )
    case 'view_stories':
      return viewStories(ctx, randInt(step.minCount, step.maxCount))
    case 'view_photo_post':
      return viewPhotoPosts(
        ctx,
        randInt(step.minCount, step.maxCount),
        randInt(step.minDurationSeconds, step.maxDurationSeconds)
      )
    case 'visit_profile':
      return visitProfile(ctx, randInt(step.minSeconds, step.maxSeconds))
    case 'random_delay':
      return randomDelay(ctx, step.minSeconds, step.maxSeconds)
  }
}

/** Run every enabled step of a scenario, in order (or randomized), against a logged-in page. */
async function runScenario(
  scenario: Scenario,
  page: Page,
  signal: AbortSignal,
  onProgress: (label: string) => void,
  uid?: string | null
): Promise<void> {
  const ctx: ScenarioStepContext = { page, signal, onProgress, uid: uid ?? undefined }
  let stepsToRun = scenario.steps.filter((s) => s.enabled)
  if (scenario.randomize_order) {
    // Fisher-Yates shuffle steps per account
    stepsToRun = [...stepsToRun]
    for (let i = stepsToRun.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const temp = stepsToRun[i]
      stepsToRun[i] = stepsToRun[j]
      stepsToRun[j] = temp
    }
  }
  for (const step of stepsToRun) {
    if (signal.aborted) throw new AbortedError()
    try {
      const result = await runScenarioStep(step, ctx)
      if (!result.success) {
        onProgress(`${step.type}: ${result.reason || 'skipped'}`)
      }
    } catch (err) {
      if (err instanceof AbortedError) throw err
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[Scenario][${uid || 'unknown'}] ${step.type} error: ${message}`)
      onProgress(`${step.type} error — recovering`)
      try {
        await safeBackToFeed(page, signal)
      } catch {
        /* recovery is best-effort */
      }
    }
  }
  onProgress('Warm-up Completed')
}

export function isQueueRunning(): boolean {
  return isAnyBatchRunning()
}

/**
 * Cancel the currently running queue (or any other active batch) and
 * forcefully close every tracked browser window immediately — Stop must not
 * leave zombie windows running while workers unwind cooperatively.
 */
export function stopQueue(): void {
  stopActiveRun()
  void closeAllBrowserWindows()
}

/**
 * Run auto-login across a list of accounts with bounded concurrency.
 * Progress is broadcast to every open window; the queue can be stopped at
 * any time via stopQueue(). When `scenarioId` is set, its enabled steps run
 * against each account's page immediately after a successful login.
 */
export async function runQueue(
  accountIds: number[],
  concurrency: number,
  scenarioId?: number
): Promise<QueueSummary> {
  const { controller, runId } = beginRun()

  const scenario = scenarioId != null ? scenariosRepo.getScenario(scenarioId) : null
  const settings = getAppSettings()
  // Browser Mode and View Mode are independent: Headed + App View must open
  // a real phone-sized Chrome window, Headless + App View stays off-screen
  // (Browser Windows screencast). Do not force headless just because App
  // View is on — that made Start/Run look like a no-op when the user picked
  // Headed.
  const headless = settings.browserMode === 'headless'

  const limit = Math.max(1, Math.min(10, Math.floor(concurrency) || 1))
  const total = accountIds.length
  let cursor = 0
  let succeeded = 0
  let failed = 0

  const nextAccount = (): { account: Account; index: number } | null => {
    if (cursor >= accountIds.length) return null
    const index = cursor + 1
    const id = accountIds[cursor]
    cursor += 1
    const account = accountsRepo.getAccount(id)
    if (!account) return nextAccount()
    return { account, index }
  }

  const worker = async (slotIndex: number): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted) return
      const item = nextAccount()
      if (!item) return
      const { account, index } = item

      const emit = (stage: ProgressStage, detail?: string): void => {
        // Ignore stale progress from a superseded run.
        if (!isCurrentRun(runId)) return
        broadcast(PROGRESS_CHANNEL, {
          accountId: account.id,
          uid: account.uid,
          stage,
          detail,
          index,
          total
        } satisfies QueueProgressEvent)
        // Keep the grid's live columns in sync as we go.
        const patch: Record<string, string> = { live_status: detail ? `${stage} — ${detail}` : stage }
        if (stage === 'Live' || stage === 'Checkpoint' || stage === 'Die' || stage === 'Changed Pass') {
          patch.status = stage
          patch.status_detail = detail ?? stage
        }
        accountsRepo.updateAccount(account.id, patch)
      }

      emit('Queued')
      if (controller.signal.aborted) {
        emit('Cancelled')
        return
      }

      let scenarioRan = false
      try {
        const result = await runAutoLogin(account, {
          headless,
          slotIndex,
          signal: controller.signal,
          onProgress: emit,
          // Runs after autoLogin.ts confirms a live session (warm-session
          // check or a completed login) — navigates to this account's saved
          // Target URL first (see AccountContextMenu.tsx's "Assign Target
          // URL"), then the scenario warm-up if one is configured. Neither
          // branch touches autoLogin.ts's own login/cookie/DB logic; this is
          // purely what happens with the page once it's already logged in.
          onLoggedIn: account.target_url?.trim() || scenario
            ? async (page) => {
                if (account.target_url?.trim()) {
                  emit('Warm-up', `Navigating to Target URL: ${account.target_url}`)
                  await page
                    .goto(account.target_url.trim(), { timeout: 45000, waitUntil: 'domcontentloaded' })
                    .catch(() => void 0)
                }
                if (scenario) {
                  scenarioRan = true
                  await runScenario(scenario, page, controller.signal, (label) =>
                    emit('Warm-up', label), account.uid)
                }
              }
            : undefined
        })

        // runAutoLogin returning at all (rather than throwing AbortedError,
        // caught below) means it reached one of its own definitive `return`
        // statements with a fully-formed result — including the case where
        // Stop was clicked in the narrow window between extraction finishing
        // and this line running. That result is complete and trustworthy, so
        // it must still be persisted; only a run that never got far enough to
        // return (an actual thrown AbortedError) has partial/untrustworthy
        // data worth discarding. Only the succeeded/failed tally — not the
        // DB write — is skipped once the queue has been stopped, so the
        // summary doesn't count a cancelled run as a "success".
        if (controller.signal.aborted) {
          failed += 1
        } else if (result.success) succeeded += 1
        else failed += 1

        accountsRepo.updateAccount(account.id, {
          status: result.status,
          status_detail: result.detail,
          // Keep "Warm-up Completed" visible as the final activity status
          // instead of letting the login-classification detail overwrite it.
          live_status: scenarioRan ? 'Warm-up Completed' : result.detail,
          ...(settings.autoSaveCookies && result.cookie ? { cookie: result.cookie } : {}),
          ...(settings.autoSaveCookies && result.token ? { token: result.token } : {}),
          ...(result.name ? { name: result.name } : {}),
          ...(result.friendsCount != null ? { friends_count: result.friendsCount } : {}),
          ...(result.groupsCount != null ? { groups_count: result.groupsCount } : {}),
          ...(result.pagesCount != null ? { pages_count: result.pagesCount } : {}),
          ...(result.friendsList ? { friends_list: JSON.stringify(result.friendsList) } : {}),
          ...(result.followers ? { followers: result.followers } : {}),
          ...(result.following ? { following: result.following } : {}),
          ...(result.currentLocation ? { current_location: result.currentLocation } : {}),
          ...(result.dtsgToken ? { dtsg_token: result.dtsgToken } : {}),
          ...(result.location ? { location: result.location } : {}),
          ...(result.createdDate ? { created_date: result.createdDate } : {}),
          ...(result.notes ? { notes: result.notes } : {}),
          last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
        })
        // Real-time row update: the renderer patches this account's full
        // row in place the instant this one account finishes, independent
        // of whatever else is still running in the other worker slots.
        broadcastAccountUpdate(account.id)
      } catch (err) {
        failed += 1
        const message = err instanceof Error ? err.message : String(err)
        emit('Error', message)
        // Persist the exact failure reason to the account's Status column —
        // without this, a scenario/navigation error that isn't one of
        // autoLogin's own classified outcomes (Live/Checkpoint/Die/...)
        // would flash briefly in the progress toast and then vanish,
        // leaving no record of why this account's run actually failed.
        accountsRepo.updateAccount(account.id, {
          status_detail: `Error: ${message}`,
          last_active: new Date().toISOString().slice(0, 19).replace('T', ' ')
        })
        broadcastAccountUpdate(account.id)
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, Math.max(1, total)) }, (_, slotIndex) =>
    worker(slotIndex)
  )
  await Promise.all(workers)

  const cancelled = controller.signal.aborted
  endRun(controller)

  const summary: QueueSummary = { total, succeeded, failed, cancelled }
  broadcast(DONE_CHANNEL, summary)
  return summary
}
