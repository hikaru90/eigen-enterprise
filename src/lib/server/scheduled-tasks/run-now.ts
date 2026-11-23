import { randomUUID } from 'node:crypto'
import { getHeartbeatJobPlan } from '$lib/consolidation/heartbeat-job-plan'
import { loadActiveHeartbeatRun } from '$lib/server/consolidation/heartbeat-run-ledger'
import {
  OVERNIGHT_CONSOLIDATION_JOB,
  drainUserJobQueue,
  enqueueUserJob,
  hasActiveJobForUser,
} from '$lib/server/job-queue'
import { recoverOrphanedOvernightState, stopOvernightHeartbeat } from '$lib/server/job-queue/recover-overnight'
import { SLEEP_CONSOLIDATION_TASK_ID } from './constants'

/**
 * Run now / stop for a person's scheduled task (today: the overnight heartbeat).
 * One service for the Settings › Scheduled tasks buttons (api/scheduled-tasks/[taskId])
 * and the memory.scheduled_task_* registry tools — same effect either way.
 */

export class UnknownScheduledTaskError extends Error {
  constructor(taskId: string) {
    super(`Unknown scheduled task: ${taskId}`)
    this.name = 'UnknownScheduledTaskError'
  }
}

export type RunScheduledTaskNowResult =
  | { ok: true; jobId: string; plannedJobs: string[]; status: 'queued'; message: string }
  | { ok: false; status: 'running' | 'queued'; error: string; runId?: string }

function requireKnownTask(taskId: string): void {
  if (taskId !== SLEEP_CONSOLIDATION_TASK_ID) throw new UnknownScheduledTaskError(taskId)
}

export async function runScheduledTaskNow(userId: string, taskId: string): Promise<RunScheduledTaskNowResult> {
  requireKnownTask(taskId)
  // Clear stale orphans from a prior crash/reload before checking active work.
  await recoverOrphanedOvernightState(userId).catch(() => {})

  if (await hasActiveJobForUser(userId, OVERNIGHT_CONSOLIDATION_JOB)) {
    const active = await loadActiveHeartbeatRun(userId).catch(() => null)
    return { ok: false, status: 'running', error: 'A heartbeat is already running.', ...(active?.runId ? { runId: active.runId } : {}) }
  }

  const outcome = await enqueueUserJob({
    userId,
    jobType: OVERNIGHT_CONSOLIDATION_JOB,
    runAfter: new Date(),
    dedupeKey: `manual:${randomUUID()}`,
    payload: { manual: true },
  })
  if (!outcome.enqueued) return { ok: false, status: 'queued', error: 'A heartbeat is already queued.' }

  // Drain in the background so the caller can show Stop and poll progress.
  void drainUserJobQueue({ userId, limit: 1 }).catch((err) => {
    console.error('[scheduled-tasks] background drain failed', {
      userId,
      jobId: outcome.jobId,
      message: err instanceof Error ? err.message : String(err),
    })
  })

  return { ok: true, jobId: outcome.jobId, plannedJobs: getHeartbeatJobPlan(), status: 'queued', message: 'Heartbeat started.' }
}

/** Stop the running task (the UI's delete): soft-cancels the active run and clears stuck jobs. */
export async function stopScheduledTask(userId: string, taskId: string) {
  requireKnownTask(taskId)
  return stopOvernightHeartbeat(userId)
}
