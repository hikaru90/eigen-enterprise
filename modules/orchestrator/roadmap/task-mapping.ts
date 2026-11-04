import type { RoadmapItem, RoadmapKind, RoadmapStatus } from './store'
import type { LifecycleStatus, TaskKind } from '$lib/server/db/schema'

/**
 * The roadmap vocabulary on the Memory task model (P-4, drizzle/0120). A
 * roadmap item is a task of the system project "Roadmap":
 *
 *   planned     ⇄ lifecycle open,      task_started_at NULL
 *   in_progress ⇄ lifecycle open,      task_started_at set
 *   shipped     ⇄ lifecycle completed, lifecycle_completed_at = shipped at
 *   archived    → not on the roadmap (Memory's soft removal)
 *
 * kind ⇄ task_kind; a task added to the project in Memory without a kind reads
 * as a feature (the roadmap's own default). position ⇄ task_position (0 when
 * unset, the roadmap's default). Pure — the store does the I/O.
 */

/** The task columns a roadmap item is read from. */
export type RoadmapTaskRow = {
  id: string
  title: string
  detail: string
  lifecycleStatus: LifecycleStatus
  lifecycleCompletedAt: Date | null
  taskKind: TaskKind | null
  taskStartedAt: Date | null
  taskPosition: number | null
  createdAt: Date
  updatedAt: Date
}

/** The task columns a roadmap status writes. */
export type TaskStateForStatus = {
  lifecycleStatus: Extract<LifecycleStatus, 'open' | 'completed'>
  lifecycleCompletedAt: Date | null
  lifecycleUpdatedAt: Date
  taskStartedAt: Date | null
}

/** The roadmap status of a task, or null when the task is archived (off the roadmap). */
export function roadmapStatusOfTask(task: {
  lifecycleStatus: LifecycleStatus
  taskStartedAt: Date | null
}): RoadmapStatus | null {
  if (task.lifecycleStatus === 'archived') return null
  if (task.lifecycleStatus === 'completed') return 'shipped'
  return task.taskStartedAt ? 'in_progress' : 'planned'
}

/**
 * Task state for a roadmap status. Entering shipped stamps `now` as the
 * completion; leaving it clears it. In progress keeps an earlier start (a
 * reopened item was started before) and planned clears it.
 */
export function taskStateForStatus(
  status: RoadmapStatus,
  now: Date,
  current: { taskStartedAt: Date | null } = { taskStartedAt: null },
): TaskStateForStatus {
  switch (status) {
    case 'planned':
      return {
        lifecycleStatus: 'open',
        lifecycleCompletedAt: null,
        lifecycleUpdatedAt: now,
        taskStartedAt: null,
      }
    case 'in_progress':
      return {
        lifecycleStatus: 'open',
        lifecycleCompletedAt: null,
        lifecycleUpdatedAt: now,
        taskStartedAt: current.taskStartedAt ?? now,
      }
    case 'shipped':
      return {
        lifecycleStatus: 'completed',
        lifecycleCompletedAt: now,
        lifecycleUpdatedAt: now,
        taskStartedAt: current.taskStartedAt,
      }
  }
}

export function roadmapKindOfTask(taskKind: TaskKind | null): RoadmapKind {
  return taskKind ?? 'feature'
}

/** The roadmap item a project task reads as, or null when it is archived. */
export function roadmapItemFromTask(task: RoadmapTaskRow): RoadmapItem | null {
  const status = roadmapStatusOfTask(task)
  if (!status) return null
  return {
    id: task.id,
    title: task.title,
    detail: task.detail,
    status,
    kind: roadmapKindOfTask(task.taskKind),
    position: task.taskPosition ?? 0,
    shippedAt:
      status === 'shipped' && task.lifecycleCompletedAt
        ? task.lifecycleCompletedAt.toISOString()
        : null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}
