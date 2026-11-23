import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { liveMemoryWriterOf, requireWriter, type MemoryWriter } from './assistant-writes'
import { PROJECT_SCHEDULE_TOOL_NAMES } from './manifest'

/**
 * Registry parity for Memory's projects, scheduled tasks and timeline items
 * (plan/parity-debt.md): every button on the Timeline / project cards,
 * Settings › Scheduled tasks and Memory › Tasks "seen" has a tool here that
 * calls the SAME service function the route calls. Who acts is resolved like
 * every Memory write (assistant-writes.ts): a person acts as themself, the
 * company assistant as the person it answers — never anyone else; an agent
 * working for no one fails loud. All of it touches only the person's own
 * Memory (or a colleague's shared project, which the service refuses as
 * read-only), so none of it is approval-gated.
 */

export { PROJECT_SCHEDULE_TOOL_NAMES }

type Fn<T extends (...args: never[]) => unknown> = T
type ProjectReviewInput = import('$lib/server/memory/project-review').ApplyProjectReviewInput

/** The services the tools call (live: the same functions the routes call). */
export type ProjectScheduleServices = {
  createProject: Fn<(i: { userId: string; label: string; status?: 'active' | 'someday' | 'completed'; visibility: 'private' | 'company' }) => Promise<unknown>>
  renameProject: Fn<(userId: string, entityId: string, label: string) => Promise<unknown>>
  setProjectDeadline: Fn<(i: { userId: string; projectEntityId: string; targetDate: string | null }) => Promise<unknown>>
  setProjectMilestone: Fn<
    (i: { userId: string; projectEntityId: string; label: string; milestoneId?: string; targetDate?: string | null; linkedThoughtId?: string | null; rank?: number; completed?: boolean }) => Promise<unknown>
  >
  dismissProject: Fn<(userId: string, entityId: string) => Promise<void>>
  orderTaskInProject: Fn<(i: { userId: string; projectEntityId: string; thoughtId: string; afterThoughtId?: string | null; rank?: number }) => Promise<unknown>>
  designateNextAction: Fn<(userId: string, entityId: string, thoughtId: string) => Promise<unknown>>
  projectTaskIds: Fn<(userId: string, entityId: string) => Promise<string[]>>
  applyProjectReview: Fn<(i: ProjectReviewInput) => Promise<unknown>>
  listScheduledTasks: Fn<(userId: string) => Promise<unknown[]>>
  setScheduledTaskPaused: Fn<(userId: string, taskId: string, paused: boolean) => Promise<void>>
  runScheduledTaskNow: Fn<(userId: string, taskId: string) => Promise<unknown>>
  stopScheduledTask: Fn<(userId: string, taskId: string) => Promise<unknown>>
  retryFailedScheduledStep: Fn<(userId: string, taskId: string, i: { runId: string; jobId: string }) => Promise<unknown>>
  rescheduleTimelineItem: Fn<(userId: string, eventId: string, i: { startAt: string; endAt: string | null }) => Promise<unknown>>
  snoozeTimelineItem: Fn<(userId: string, eventId: string, snoozedUntil: string) => Promise<unknown>>
  quickTimelineAction: Fn<(userId: string, eventId: string, action: 'mark_done' | 'reopen' | 'archive') => Promise<unknown>>
  markAssignedTaskSeen: Fn<(userId: string, taskId: string) => Promise<void>>
}

export type ProjectScheduleToolDeps = {
  services?: () => Promise<ProjectScheduleServices>
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
}

async function liveServices(): Promise<ProjectScheduleServices> {
  const [created, list, timeline, sequence, nextAction, review, scheduled, runNow, temporal, assigned, assignedLive] = await Promise.all([
    import('$lib/server/memory/create-user-project'),
    import('$lib/server/memory/project-list'),
    import('$lib/server/memory/project-timeline'),
    import('$lib/server/memory/project-task-sequence'),
    import('$lib/server/memory/project-next-action'),
    import('$lib/server/memory/project-review'),
    import('$lib/server/scheduled-tasks/service'),
    import('$lib/server/scheduled-tasks/run-now'),
    import('$lib/server/memory/temporal-event-service'),
    import('$lib/server/memory/assigned-tasks/service'),
    import('$lib/server/memory/assigned-tasks/live'),
  ])
  return {
    createProject: (i) => created.createUserDeclaredProject(i),
    renameProject: (u, id, label) => list.updateProjectLabel(u, id, label),
    setProjectDeadline: (i) => timeline.setProjectDeadline(i),
    setProjectMilestone: (i) => timeline.setProjectMilestone(i),
    dismissProject: (u, id) => list.dismissProject(u, id),
    orderTaskInProject: (i) => sequence.orderTaskInProject(i),
    designateNextAction: (u, id, t) => nextAction.designateNextAction(u, id, t),
    projectTaskIds: async (u, id) => (await review.loadProjectTaskReviewInput(u, id)).allowedThoughtIds,
    applyProjectReview: (i) => review.applyProjectReview(i),
    listScheduledTasks: (u) => scheduled.listScheduledTasks(u),
    setScheduledTaskPaused: (u, t, p) => scheduled.setUserScheduledTaskPaused(u, t, p),
    runScheduledTaskNow: (u, t) => runNow.runScheduledTaskNow(u, t),
    stopScheduledTask: (u, t) => runNow.stopScheduledTask(u, t),
    retryFailedScheduledStep: async (u, t, i) => {
      const { SLEEP_CONSOLIDATION_TASK_ID } = await import('$lib/server/scheduled-tasks/constants')
      if (t !== SLEEP_CONSOLIDATION_TASK_ID) throw new runNow.UnknownScheduledTaskError(t)
      return scheduled.retryFailedHeartbeatJob(u, i)
    },
    rescheduleTimelineItem: (u, e, i) => temporal.applyStructuredRescheduleAction(u, e, i),
    snoozeTimelineItem: (u, e, until) => temporal.applyStructuredSnoozeAction(u, e, until),
    quickTimelineAction: (u, e, a) => temporal.applyQuickTemporalEventAction(u, e, a),
    markAssignedTaskSeen: async (u, t) => assigned.markTaskSeen(await assignedLive.assignedTaskDeps(), u, t),
  }
}

const id = (what: string) => z.string().min(1).describe(what)
const projectId = id('The project entity id (from memory.list_projects).')
const thoughtId = id('A task (thought) id in the project (from memory.get_project_timeline).')
const scheduledTaskId = id('The scheduled task id (from memory.list_scheduled_tasks).')
const eventId = id('The timeline item id (from memory.get_project_timeline).')
const iso = (what: string) => z.string().min(1).describe(`${what} as an ISO-8601 timestamp.`)

const createProjectInput = z
  .object({
    label: z.string().trim().min(1).max(200),
    status: z.enum(['active', 'someday', 'completed']).optional(),
    private: z.boolean().optional().describe('true = only the person sees it and its tasks; default false = shared with everyone.'),
  })
  .strict()
const renameInput = z.object({ project_entity_id: projectId, label: z.string().trim().min(1).max(200) }).strict()
const deadlineInput = z.object({ project_entity_id: projectId, target_date: iso('The deadline').nullable().describe('ISO-8601 date, or null to clear it.') }).strict()
const milestoneInput = z
  .object({
    project_entity_id: projectId,
    label: z.string().trim().min(1).max(200),
    milestone_id: z.string().min(1).optional().describe('Change this milestone instead of adding one.'),
    target_date: z.string().nullable().optional(),
    linked_thought_id: z.string().nullable().optional(),
    rank: z.number().int().optional(),
    completed: z.boolean().optional(),
  })
  .strict()
const projectOnly = z.object({ project_entity_id: projectId }).strict()
const orderInput = z
  .object({
    project_entity_id: projectId,
    thought_id: thoughtId,
    after_thought_id: z.string().min(1).nullable().optional().describe('Place it after this task; null = first.'),
    rank: z.number().int().optional(),
    as_next_action: z.boolean().optional().describe('Also make it the project’s next action.'),
  })
  .strict()
const reviewInput = z
  .object({
    project_entity_id: projectId,
    mark_done: z.array(z.string().min(1)).optional(),
    archive: z.array(z.string().min(1)).optional(),
    deadlines: z.array(z.object({ thought_id: z.string().min(1), target_date: z.string().min(1) }).strict()).optional(),
    order: z.array(z.string().min(1)).optional().describe('The project’s task ids in their new order.'),
    project_deadline: z.string().nullable().optional().describe('Leave out to keep it; null clears it.'),
    new_tasks: z
      .array(
        z
          .object({
            summary: z.string().trim().min(1).max(500),
            kind: z.string().min(1).nullable().optional(),
            suggested_start_at: z.string().nullable().optional(),
            suggested_end_at: z.string().nullable().optional(),
          })
          .strict(),
      )
      .optional(),
    next_action_thought_id: z.string().min(1).nullable().optional(),
    next_action_new_task_index: z.number().int().min(0).nullable().optional(),
  })
  .strict()
const emptyInput = z.object({}).strict()
const scheduledOnly = z.object({ task_id: scheduledTaskId }).strict()
const retryInput = z.object({ task_id: scheduledTaskId, run_id: z.string().trim().min(1), job_id: z.string().trim().min(1) }).strict()
const rescheduleInput = z.object({ event_id: eventId, start_at: iso('The new start'), end_at: z.string().nullable().optional() }).strict()
const snoozeInput = z.object({ event_id: eventId, snoozed_until: iso('Snooze until') }).strict()
const statusInput = z
  .object({ event_id: eventId, action: z.enum(['mark_done', 'reopen', 'archive']).describe('mark_done completes it, reopen undoes that, archive hides it.') })
  .strict()
const seenInput = z.object({ task_id: id('The assigned task id (from tasks.list).') }).strict()

type Name = (typeof PROJECT_SCHEDULE_TOOL_NAMES)[number]

export function createProjectScheduleTools(opts: ProjectScheduleToolDeps = {}): ToolDescriptor[] {
  const services = opts.services ?? liveServices
  const writerOf = opts.writerOf ?? liveMemoryWriterOf

  const tool = <S extends z.ZodTypeAny>(
    name: Name,
    summary: string,
    inputSchema: S,
    run: (s: ProjectScheduleServices, userId: string, input: z.infer<S>) => Promise<unknown>,
    activity?: string,
  ): ToolDescriptor => ({
    name,
    module: 'memory',
    summary,
    auditClass: activity === undefined ? 'read' : 'mutate',
    ...(activity === undefined ? {} : { activity: () => activity }),
    permission: { roles: ['admin', 'member', 'agent'] },
    inputSchema,
    handler: async (ctx, input) => {
      const userId = requireWriter(await writerOf(ctx)).userId
      try {
        return await run(await services(), userId, inputSchema.parse(input))
      } catch (err) {
        // A colleague's shared project is read-only: say so as a permission error.
        const { isMemoryReadOnlyError } = await import('$lib/server/memory/memory-read-only')
        if (isMemoryReadOnlyError(err)) throw new KernelError('permission_denied', err.message)
        throw err
      }
    },
  })

  return [
    tool(
      'memory.create_project',
      'Create a project in the person’s Memory (shared with everyone unless private is true).',
      createProjectInput,
      (s, userId, i) => s.createProject({ userId, label: i.label, ...(i.status ? { status: i.status } : {}), visibility: i.private === true ? 'private' : 'company' }),
      'Created a project',
    ),
    tool('memory.rename_project', 'Rename one of the person’s projects.', renameInput, (s, u, i) => s.renameProject(u, i.project_entity_id, i.label), 'Renamed a project'),
    tool(
      'memory.set_project_deadline',
      'Set (ISO-8601) or clear (null) a project’s target deadline.',
      deadlineInput,
      (s, userId, i) => s.setProjectDeadline({ userId, projectEntityId: i.project_entity_id, targetDate: i.target_date }),
      'Set a project deadline',
    ),
    tool(
      'memory.set_project_milestone',
      'Add a milestone to a project, or change one (milestone_id): label, target date, linked task, rank, completed.',
      milestoneInput,
      (s, userId, i) =>
        s.setProjectMilestone({
          userId,
          projectEntityId: i.project_entity_id,
          label: i.label,
          ...(i.milestone_id ? { milestoneId: i.milestone_id } : {}),
          ...(i.target_date !== undefined ? { targetDate: i.target_date } : {}),
          ...(i.linked_thought_id !== undefined ? { linkedThoughtId: i.linked_thought_id } : {}),
          ...(i.rank !== undefined ? { rank: i.rank } : {}),
          ...(i.completed !== undefined ? { completed: i.completed } : {}),
        }),
      'Set a project milestone',
    ),
    tool(
      'memory.dismiss_project',
      'Dismiss one of the person’s projects (it leaves the project list).',
      projectOnly,
      async (s, u, i) => {
        await s.dismissProject(u, i.project_entity_id)
        return { ok: true, summary: 'Project dismissed.' }
      },
      'Dismissed a project',
    ),
    tool(
      'memory.order_project_task',
      'Move a task within a project’s order (after another task, or first), optionally making it the next action.',
      orderInput,
      async (s, userId, i) => {
        const result = await s.orderTaskInProject({
          userId,
          projectEntityId: i.project_entity_id,
          thoughtId: i.thought_id,
          ...(i.after_thought_id !== undefined ? { afterThoughtId: i.after_thought_id } : {}),
          ...(i.rank !== undefined ? { rank: i.rank } : {}),
        })
        if (i.as_next_action === true) await s.designateNextAction(userId, i.project_entity_id, i.thought_id)
        return result
      },
      'Reordered a project’s tasks',
    ),
    tool(
      'memory.apply_project_review',
      'Apply a project review in one go: mark tasks done or archived, set task deadlines, reorder, set the project deadline, add new tasks and pick the next action. Only the project’s own tasks can be changed.',
      reviewInput,
      async (s, userId, i) => {
        const { temporalEventKindEnum } = await import('$lib/server/db/brain.schema')
        for (const t of i.new_tasks ?? []) {
          if (t.kind != null && !(temporalEventKindEnum as readonly string[]).includes(t.kind)) {
            throw new KernelError('invalid_input', `new_tasks kind must be one of ${temporalEventKindEnum.join(', ')}`)
          }
        }
        return s.applyProjectReview({
          userId,
          projectEntityId: i.project_entity_id,
          markDone: i.mark_done ?? [],
          archive: i.archive ?? [],
          deadlines: (i.deadlines ?? []).map((d) => ({ thoughtId: d.thought_id, targetDate: d.target_date })),
          order: i.order ?? [],
          ...(i.project_deadline !== undefined ? { projectDeadline: i.project_deadline } : {}),
          newTasks: (i.new_tasks ?? []).map((t) => ({
            summary: t.summary,
            kind: (t.kind ?? null) as ProjectReviewInput['newTasks'][number]['kind'],
            suggestedStartAt: t.suggested_start_at ?? null,
            suggestedEndAt: t.suggested_end_at ?? null,
          })),
          nextActionThoughtId: i.next_action_thought_id ?? null,
          nextActionNewTaskIndex: i.next_action_new_task_index ?? null,
          allowedThoughtIds: await s.projectTaskIds(userId, i.project_entity_id),
        })
      },
      'Applied a project review',
    ),
    tool(
      'memory.list_scheduled_tasks',
      'List the person’s scheduled tasks (today: the overnight heartbeat) with schedule, paused state, last run, failed steps and any active run.',
      emptyInput,
      async (s, u) => ({ tasks: await s.listScheduledTasks(u) }),
    ),
    tool('memory.pause_scheduled_task', 'Pause one of the person’s scheduled tasks.', scheduledOnly, async (s, u, i) => {
      await s.setScheduledTaskPaused(u, i.task_id, true)
      return { ok: true, paused: true }
    }, 'Paused a scheduled task'),
    tool('memory.resume_scheduled_task', 'Resume a paused scheduled task.', scheduledOnly, async (s, u, i) => {
      await s.setScheduledTaskPaused(u, i.task_id, false)
      return { ok: true, paused: false }
    }, 'Resumed a scheduled task'),
    tool(
      'memory.run_scheduled_task',
      'Run a scheduled task now (queued in the background; refused while one is already running or queued).',
      scheduledOnly,
      (s, u, i) => s.runScheduledTaskNow(u, i.task_id),
      'Ran a scheduled task now',
    ),
    tool(
      'memory.stop_scheduled_task',
      'Stop a scheduled task’s current run (the Stop/delete button): cancels the active run and clears stuck jobs; the schedule stays.',
      scheduledOnly,
      (s, u, i) => s.stopScheduledTask(u, i.task_id),
      'Stopped a scheduled task',
    ),
    tool(
      'memory.retry_scheduled_task_step',
      'Re-run one failed step (job_id) of a finished run (run_id, from memory.list_scheduled_tasks) without repeating the whole run.',
      retryInput,
      (s, u, i) => s.retryFailedScheduledStep(u, i.task_id, { runId: i.run_id, jobId: i.job_id }),
      'Retried a failed scheduled step',
    ),
    tool(
      'memory.reschedule_timeline_item',
      'Move a timeline item to a new start (and optional end) time.',
      rescheduleInput,
      (s, u, i) => s.rescheduleTimelineItem(u, i.event_id, { startAt: i.start_at, endAt: i.end_at ?? null }),
      'Rescheduled a timeline item',
    ),
    tool('memory.snooze_timeline_item', 'Snooze a timeline item until a time.', snoozeInput, (s, u, i) => s.snoozeTimelineItem(u, i.event_id, i.snoozed_until), 'Snoozed a timeline item'),
    tool(
      'memory.set_timeline_item_status',
      'Complete a timeline item (mark_done), reopen it, or archive it.',
      statusInput,
      (s, u, i) => s.quickTimelineAction(u, i.event_id, i.action),
      'Changed a timeline item',
    ),
    tool('tasks.mark_seen', 'Mark a task assigned to the person as seen (clears it from what is new for them).', seenInput, async (s, u, i) => {
      await s.markAssignedTaskSeen(u, i.task_id)
      return { ok: true }
    }, 'Marked an assigned task seen'),
  ]
}
