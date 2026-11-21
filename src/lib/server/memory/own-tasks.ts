import type { CaptureSource, LifecycleStatus } from '$lib/server/db/schema'
import type { AssignThoughtProjectInput } from '$lib/server/memory/assign-thought-project'
import type { DeleteThoughtResult } from '$lib/server/memory/delete-thought'
import type { TemporalEventListItem } from '$lib/server/memory/temporal-event-list'

/**
 * Memory › Tasks for the registry (memory.*_task tools, modules/memory/own-task-tools.ts):
 * the person's own rows of the Tasks page — task thoughts (`task:<thoughtId>`) and dates read
 * from thoughts (a temporal_event id). Every operation is the one the page itself runs:
 * add = capture with the category 'task' (Tasks › Add a task), edit = the Memory edit of the
 * thought (its words, re-read by enrichment), reschedule = the row's reschedule, project =
 * Assign to project, complete = Mark done, remove = the row's Delete (for good).
 * Everything runs as the given person, under their row-level security.
 */

export type OwnTaskStatusFilter = 'open' | 'done' | 'all'

export type OwnTaskView = {
  /** The row id every other memory.*_task tool takes. */
  id: string
  thoughtId: string
  /** 'task' = an undated task thought; 'event' = a dated item read from a thought. */
  kind: 'task' | 'event'
  title: string
  status: LifecycleStatus
  /** ISO start of a dated item; null for an undated task. */
  dueAt: string | null
  project: { id: string; label: string } | null
  createdAt: string
}

export type OwnTaskService = {
  list(userId: string, status: OwnTaskStatusFilter): Promise<OwnTaskView[]>
  get(userId: string, taskId: string): Promise<OwnTaskView | null>
  create(userId: string, input: { text: string; source: CaptureSource }): Promise<{ taskId: string }>
  edit(userId: string, taskId: string, change: string): Promise<void>
  reschedule(userId: string, taskId: string, dueAt: string): Promise<void>
  setProject(userId: string, taskId: string, target: AssignThoughtProjectInput): Promise<void>
  complete(userId: string, taskId: string): Promise<void>
  remove(userId: string, taskId: string): Promise<DeleteThoughtResult>
}

export function ownTaskView(item: TemporalEventListItem): OwnTaskView {
  return {
    id: item.id,
    thoughtId: item.thoughtId,
    kind: item.itemType === 'task' ? 'task' : 'event',
    title: item.semanticSummary,
    status: item.lifecycleStatus,
    dueAt: item.startAt,
    project: item.projectEntityId && item.projectLabel ? { id: item.projectEntityId, label: item.projectLabel } : null,
    createdAt: item.createdAt,
  }
}

const STATUS_OF: Record<Exclude<OwnTaskStatusFilter, 'all'>, LifecycleStatus> = { open: 'open', done: 'completed' }

async function thoughtIdOf(userId: string, taskId: string): Promise<string> {
  const { thoughtIdOfTimelineItem } = await import('$lib/server/memory/delete-thought')
  const thoughtId = await thoughtIdOfTimelineItem(userId, taskId)
  if (!thoughtId) throw new Error('That task is not in your Memory (anymore).')
  return thoughtId
}

/** The live service over the Tasks page's own server functions (imported at call time). */
export function liveOwnTaskService(): OwnTaskService {
  return {
    async list(userId, status) {
      const { loadUnifiedTimeline } = await import('$lib/server/memory/timeline-unified')
      // The Tasks page's own query: the person's items (author scope 'user'), newest first.
      const { items } = await loadUnifiedTimeline({ userId, author: 'user', orderBy: 'ingest', sortDirection: 'desc' })
      return items.filter((i) => status === 'all' || i.lifecycleStatus === STATUS_OF[status]).map(ownTaskView)
    },
    async get(userId, taskId) {
      const { getTemporalEventListItemById } = await import('$lib/server/memory/temporal-event-list')
      const item = await getTemporalEventListItemById(userId, taskId)
      return item ? ownTaskView(item) : null
    },
    async create(userId, input) {
      const [{ queueCapture }, { taskItemId }] = await Promise.all([
        import('$lib/server/capture/queue-capture'),
        import('$lib/server/memory/temporal-event-list'),
      ])
      const queued = await queueCapture(userId, input.text, { source: input.source, category: 'task' })
      return { taskId: taskItemId(queued.thoughtId) }
    },
    async edit(userId, taskId, change) {
      const thoughtId = await thoughtIdOf(userId, taskId)
      const { editStoredThought } = await import('$lib/server/capture/service')
      const result = await editStoredThought(userId, thoughtId, change)
      if (!result.ok) throw new Error('That task is not in your Memory (anymore).')
    },
    async reschedule(userId, taskId, dueAt) {
      const { applyStructuredRescheduleAction } = await import('$lib/server/memory/temporal-event-service')
      await applyStructuredRescheduleAction(userId, taskId, { startAt: dueAt })
    },
    async setProject(userId, taskId, target) {
      const thoughtId = await thoughtIdOf(userId, taskId)
      const { assignThoughtToProject } = await import('$lib/server/memory/assign-thought-project')
      await assignThoughtToProject(userId, thoughtId, target)
    },
    async complete(userId, taskId) {
      const { applyQuickTemporalEventAction } = await import('$lib/server/memory/temporal-event-service')
      await applyQuickTemporalEventAction(userId, taskId, 'mark_done')
    },
    async remove(userId, taskId) {
      const { deleteTimelineItemForUser } = await import('$lib/server/memory/delete-thought')
      return deleteTimelineItemForUser(userId, taskId)
    },
  }
}
