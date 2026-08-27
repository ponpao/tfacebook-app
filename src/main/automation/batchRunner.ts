// ---------------------------------------------------------------------------
// batchRunner.ts  — generic bounded-concurrency batch executor shared by
// Auto Post, Auto Share, and Batch Change Info. Mirrors queueRunner.ts's
// worker-pool + AbortController + progress-broadcast pattern so the existing
// renderer listeners (automation:onProgress / onQueueDone) work unchanged
// regardless of which action produced the event.
// ---------------------------------------------------------------------------
import { BrowserWindow } from 'electron'
import type { Account } from '../../types/account'
import * as accountsRepo from '../db/accountsRepo'
import { beginRun, endRun, isCurrentRun, isAnyBatchRunning, stopActiveRun } from './activeRun'

export interface BatchProgressEvent {
  accountId: number
  uid: string | null
  stage: string
  detail?: string
  index: number
  total: number
}

export interface BatchSummary {
  total: number
  succeeded: number
  failed: number
  cancelled: boolean
}

const PROGRESS_CHANNEL = 'automation:onProgress'
const DONE_CHANNEL = 'automation:onQueueDone'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function isBatchRunning(): boolean {
  return isAnyBatchRunning()
}

export function stopActiveBatch(): void {
  stopActiveRun()
}

export interface RunOneResult {
  success: boolean
  detail: string
  /** Extra account fields to persist alongside status/live_status (e.g. new password). */
  patch?: Record<string, unknown>
}

/**
 * Run `runOne` across `accountIds` with bounded concurrency, broadcasting
 * progress/summary on the shared automation channels. `runOne` receives a
 * per-account progress emitter and the run's AbortSignal.
 */
export async function runBatch(
  accountIds: number[],
  concurrency: number,
  runOne: (
    account: Account,
    emit: (stage: string, detail?: string) => void,
    signal: AbortSignal
  ) => Promise<RunOneResult>
): Promise<BatchSummary> {
  const { controller, runId } = beginRun()

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

  const worker = async (): Promise<void> => {
    for (;;) {
      if (controller.signal.aborted) return
      const item = nextAccount()
      if (!item) return
      const { account, index } = item

      const emit = (stage: string, detail?: string): void => {
        if (!isCurrentRun(runId)) return
        broadcast(PROGRESS_CHANNEL, {
          accountId: account.id,
          uid: account.uid,
          stage,
          detail,
          index,
          total
        } satisfies BatchProgressEvent)
        accountsRepo.updateAccount(account.id, {
          live_status: detail ? `${stage} — ${detail}` : stage
        })
      }

      emit('Queued')
      if (controller.signal.aborted) {
        emit('Cancelled')
        return
      }

      try {
        const result = await runOne(account, emit, controller.signal)
        // runOne returning at all (rather than throwing, caught below) means
        // it reached its own definitive completion with a trustworthy result
        // — including the case where Stop was clicked in the narrow window
        // between it finishing and this line running. That result must still
        // be persisted; only the succeeded/failed tally is skipped once the
        // batch has been stopped, so a cancelled run isn't counted as a
        // "success" (mirrors the equivalent fix in queueRunner.ts).
        if (controller.signal.aborted) {
          failed += 1
        } else if (result.success) succeeded += 1
        else failed += 1
        if (result.patch) accountsRepo.updateAccount(account.id, result.patch)
      } catch (err) {
        failed += 1
        const message = err instanceof Error ? err.message : String(err)
        emit('Error', message)
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, Math.max(1, total)) }, () => worker())
  await Promise.all(workers)

  const cancelled = controller.signal.aborted
  endRun(controller)

  const summary: BatchSummary = { total, succeeded, failed, cancelled }
  broadcast(DONE_CHANNEL, summary)
  return summary
}
