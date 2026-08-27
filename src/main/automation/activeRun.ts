// ---------------------------------------------------------------------------
// activeRun.ts  — the single shared "what's running right now" registry.
// Only one batch (login queue, Auto Post, Auto Share, Change Info) runs at a
// time across the whole app; starting a new one aborts whatever was running.
// Both queueRunner.ts and batchRunner.ts coordinate through this module so
// [⏹ Stop] and the "queue running" state are consistent no matter which
// action is currently in flight.
// ---------------------------------------------------------------------------

let activeController: AbortController | null = null
let activeRunId = 0

/** True while any batch (login queue, post, share, change-info) is running. */
export function isAnyBatchRunning(): boolean {
  return activeController != null
}

/** Abort whatever batch is currently running, if any. Idempotent. */
export function stopActiveRun(): void {
  activeController?.abort()
}

/**
 * Claim the "active run" slot for a new batch, aborting any previous one.
 * Returns the controller to use and a run id — pass the id to `isCurrentRun`
 * so late progress events from a superseded run are dropped, and call
 * `release(controller)` when the batch finishes.
 */
export function beginRun(): { controller: AbortController; runId: number } {
  if (activeController) activeController.abort()
  const controller = new AbortController()
  activeController = controller
  activeRunId += 1
  return { controller, runId: activeRunId }
}

export function isCurrentRun(runId: number): boolean {
  return runId === activeRunId
}

export function endRun(controller: AbortController): void {
  if (activeController === controller) activeController = null
}
