import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { OwnTaskService, OwnTaskView } from '$lib/server/memory/own-tasks'
import { liveMemoryWriterOf, requireWriter, type MemoryWriter } from './assistant-writes'
import { OWN_TASK_TOOL_NAMES } from './manifest'

/**
 * The person's own Memory › Tasks as registry tools (Contribute e9490497: "add and delete
 * memory tasks via the AI assistant"): list, create, update, complete and delete — each the
 * same operation the Tasks page runs (src/lib/server/memory/own-tasks.ts). Who acts is
 * resolved like every Memory write (assistant-writes.ts): a person acts as themself; the
 * company assistant acts for the person it answers, in THEIR Memory, or fails loud.
 *
 * The assistant may change any of the person's tasks (not only those it added): tasks are
 * the person's to-do list, they asked in their own chat, and nothing leaves their Memory.
 *
 * Deleting is for good (the row's trash icon), so it declares approvalRisk 'destructive' —
 * but it is NOT on the approval list: approvals are decided by the owner/admins, and a
 * member's private Memory is never theirs to see or decide on (memory-access spec). The
 * person's own word in their chat is the decision; the summary makes the assistant confirm
 * first and points to marking it done as the undoable alternative.
 *
 * Activity lines never carry the task's words: the audit trail is the owner's, Memory is not.
 */

export { OWN_TASK_TOOL_NAMES }

export type OwnTaskToolDeps = {
  service?: () => Promise<OwnTaskService>
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
}

const NOT_YOURS = 'That task is not in your Memory (anymore). List the tasks (memory.list_tasks) for current ids.'

const taskId = z.string().min(1).describe('The task id from memory.list_tasks (task:… or a dated item id).')
const isoInstant = z.string().datetime({ offset: true, message: 'an ISO date-time, e.g. 2026-11-25T10:00:00+01:00' })

const listInput = z
  .object({ status: z.enum(['open', 'done', 'all']).optional().describe('open (default), done, or all.') })
  .strict()
const createInput = z
  .object({
    title: z
      .string()
      .min(1)
      .max(2000)
      .describe('The task in the person’s words. Say when it is due in the words ("…by Friday"): Memory reads the date from them.'),
    project_entity_id: z.string().min(1).optional().describe('An existing project (memory.list_projects).'),
    project_label: z.string().min(1).max(200).optional().describe('A project by name; created when the person has none by that name.'),
  })
  .strict()
  .refine((i) => !(i.project_entity_id && i.project_label), 'project_entity_id or project_label, not both')
const updateInput = z
  .object({
    task_id: taskId,
    change: z
      .string()
      .min(1)
      .max(2000)
      .optional()
      .describe('What to change in the task, in plain words ("rename it to Call the bank", "due next Friday"); Memory rewrites and re-reads it.'),
    due_at: isoInstant.optional().describe('A new start for a DATED item (kind "event"). An undated task gets its day through change.'),
    project_entity_id: z.string().min(1).optional(),
    project_label: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((i) => !(i.project_entity_id && i.project_label), 'project_entity_id or project_label, not both')
  .refine(
    (i) => i.change !== undefined || i.due_at !== undefined || i.project_entity_id !== undefined || i.project_label !== undefined,
    'give change, due_at, project_entity_id or project_label',
  )
const taskInput = z.object({ task_id: taskId }).strict()

async function liveService(): Promise<OwnTaskService> {
  const { liveOwnTaskService } = await import('$lib/server/memory/own-tasks')
  return liveOwnTaskService()
}

type ProjectFields = { project_entity_id?: string; project_label?: string }
const projectTarget = (i: ProjectFields) =>
  i.project_entity_id ? { projectEntityId: i.project_entity_id } : i.project_label ? { projectLabel: i.project_label } : null

export function createOwnTaskTools(opts: OwnTaskToolDeps = {}): ToolDescriptor[] {
  const service = opts.service ?? liveService
  const writerOf = opts.writerOf ?? liveMemoryWriterOf
  const writer = async (ctx: ToolContext) => requireWriter(await writerOf(ctx))
  const base: Pick<ToolDescriptor, 'module' | 'permission'> = { module: 'memory', permission: { roles: ['admin', 'member', 'agent'] } }

  /** The person's row, or a loud refusal: nothing runs on a row that is not theirs. */
  const ownRow = async (svc: OwnTaskService, userId: string, id: string): Promise<OwnTaskView> => {
    const row = await svc.get(userId, id)
    if (!row) throw new Error(NOT_YOURS)
    return row
  }
  const reread = async (svc: OwnTaskService, userId: string, id: string) => ({ task: await ownRow(svc, userId, id) })

  return [
    {
      ...base,
      name: 'memory.list_tasks',
      summary:
        'List the person’s own tasks in Memory › Tasks (their to-do list: undated tasks and dated items), newest first: id, title, kind, status, due time, project. status: open (default), done or all. Tasks assigned between members are tasks.list.',
      auditClass: 'read',
      inputSchema: listInput,
      handler: async (ctx, input) => {
        const { userId } = await writer(ctx)
        return { tasks: await (await service()).list(userId, listInput.parse(input).status ?? 'open') }
      },
    },
    {
      ...base,
      name: 'memory.create_task',
      summary:
        'Add a task to the person’s own Memory › Tasks (like Tasks › Add a task), optionally into a project. Say a due day in the words; Memory reads it. Working for a person it lands in their Memory as theirs. To give a task to a colleague use tasks.assign.',
      auditClass: 'mutate',
      activity: () => 'Added a task to Memory',
      inputSchema: createInput,
      handler: async (ctx, input) => {
        const i = createInput.parse(input)
        const w = await writer(ctx)
        const svc = await service()
        const { taskId: id } = await svc.create(w.userId, { text: i.title, source: w.kind === 'assistant' ? 'agent' : 'api' })
        const target = projectTarget(i)
        if (target) await svc.setProject(w.userId, id, target)
        return reread(svc, w.userId, id)
      },
    },
    {
      ...base,
      name: 'memory.update_task',
      summary:
        'Change one of the person’s own tasks (task_id from memory.list_tasks): change = what to change in plain words (its title, or its due day for an undated task); due_at = a new ISO start for a dated item; project_entity_id or project_label = move it into a project.',
      auditClass: 'mutate',
      activity: () => 'Changed a task in Memory',
      inputSchema: updateInput,
      handler: async (ctx, input) => {
        const i = updateInput.parse(input)
        const { userId } = await writer(ctx)
        const svc = await service()
        const row = await ownRow(svc, userId, i.task_id)
        if (i.due_at !== undefined && row.kind === 'task') {
          throw new Error('This task has no date of its own, so due_at cannot move it: say the new due day in change instead.')
        }
        if (i.change !== undefined) await svc.edit(userId, i.task_id, i.change)
        if (i.due_at !== undefined) await svc.reschedule(userId, i.task_id, i.due_at)
        const target = projectTarget(i)
        if (target) await svc.setProject(userId, i.task_id, target)
        return reread(svc, userId, i.task_id)
      },
    },
    {
      ...base,
      name: 'memory.complete_task',
      summary: 'Mark one of the person’s own tasks as done (task_id from memory.list_tasks), like the Tasks page’s Mark done.',
      auditClass: 'mutate',
      activity: () => 'Completed a task in Memory',
      inputSchema: taskInput,
      handler: async (ctx, input) => {
        const { task_id } = taskInput.parse(input)
        const { userId } = await writer(ctx)
        const svc = await service()
        await ownRow(svc, userId, task_id)
        await svc.complete(userId, task_id)
        return reread(svc, userId, task_id)
      },
    },
    {
      ...base,
      name: 'memory.delete_task',
      summary:
        'Delete one of the person’s own tasks for good (task_id from memory.list_tasks): the thought behind it goes, with its dates and links — it cannot be undone. Confirm with the person which task first; to put a task away without losing it, mark it done instead.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: () => 'Deleted a task from Memory',
      inputSchema: taskInput,
      handler: async (ctx, input) => {
        const { task_id } = taskInput.parse(input)
        const { userId } = await writer(ctx)
        const result = await (await service()).remove(userId, task_id)
        if (result.ok) return { deleted: true, taskId: task_id }
        if (result.reason === 'system_project_task') {
          throw new KernelError(
            'permission_denied',
            `This task belongs to the company’s “${result.projectLabel}” project: change it there.`,
          )
        }
        throw new Error(NOT_YOURS)
      },
    },
  ]
}
