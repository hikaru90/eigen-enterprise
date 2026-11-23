import type { CoworkerTurnsHandle } from './live-turns'
import type { CoworkerRunRow, CoworkerRunStore, NewCoworkerRun } from './run-store'
import type { AssignedTaskView, CoworkerTaskEvent } from '$lib/server/memory/assigned-tasks/service'
import { taskAssignedKey, taskCommentKey } from './triggers'

/**
 * Assignments (plan/phase-ai-coworkers.md C6): a task given to an AI co-worker
 * (tasks.assign) queues one 'assignment' run, and each person's comment on it
 * while it is open queues one more — once per assignment and per comment
 * (trigger_key task:<id> / task-comment:<id>, unique per co-worker). The run is
 * started in the process that queued it; a sweep picks up what a stopped
 * process left (turns.resume).
 */

/** The run a task event queues (pure). */
export function taskEventRun(e: CoworkerTaskEvent): NewCoworkerRun {
  return {
    coworkerUserId: e.coworkerId,
    triggerKind: 'assignment',
    conversationId: null,
    threadRootId: null,
    triggerMessageId: null,
    requestedByUserId: e.byUserId,
    triggeredAt: e.at,
    rhythmId: null,
    taskId: e.taskId,
    triggerKey: e.kind === 'assigned' ? taskAssignedKey(e.taskId) : taskCommentKey(e.commentId),
  }
}

/** Queues the run of a task event and starts it; null when another process (or a redelivery) already queued it. */
export async function queueTaskWork(deps: { runs: CoworkerRunStore; start(runId: string): void }, e: CoworkerTaskEvent): Promise<CoworkerRunRow | null> {
  const run = await deps.runs.enqueue(taskEventRun(e))
  if (run) deps.start(run.id)
  return run
}

/** globalThis: boot keeps this process's co-worker turns there (src/lib/server/boot.ts). */
const host = globalThis as { __eeCoworkerTurns?: CoworkerTurnsHandle }

/** This process's running co-worker turns; fails loud when boot has not started them. */
export function runningCoworkerTurns(): CoworkerTurnsHandle {
  const handle = host.__eeCoworkerTurns
  if (!handle) throw new Error('the AI co-worker turns are not running in this process (boot starts them); nothing can be queued for a co-worker here')
  return handle
}

/** Starts a queued work run in this process's turns; the turn runs in the background, a failure is logged loud. */
export function startCoworkerWork(runId: string): void {
  runningCoworkerTurns()
    .turns.work(runId)
    .catch((err: unknown) => console.error('[coworkers] a co-worker work run failed', { runId, err }))
}

/** Live AssignedTaskDeps.coworkerWork: the database queue and this process's turns. */
export async function liveCoworkerTaskWork(e: CoworkerTaskEvent): Promise<void> {
  // Fail before queuing when this process cannot run it (a queued run would wait for another process's sweep).
  runningCoworkerTurns()
  const { liveCoworkerRunStore } = await import('./db-run-store')
  await queueTaskWork({ runs: liveCoworkerRunStore, start: startCoworkerWork }, e)
}

/** A task as the co-worker reads it: the live tasks service; null when it is gone or not the co-worker's. */
export async function liveReadTask(coworkerId: string, taskId: string): Promise<AssignedTaskView | null> {
  const [{ assignedTaskDeps }, { getTask, AssignedTaskError }] = await Promise.all([
    import('$lib/server/memory/assigned-tasks/live'),
    import('$lib/server/memory/assigned-tasks/service'),
  ])
  try {
    return await getTask(await assignedTaskDeps(), coworkerId, taskId)
  } catch (err) {
    if (err instanceof AssignedTaskError && err.code === 'not_found') return null
    throw err
  }
}
