import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { AssignedTaskDeps, AssignedTaskView, TaskActor } from '$lib/server/memory/assigned-tasks/service'
import { liveMemoryWriterOf, requireWriter, type MemoryWriter } from './assistant-writes'
import { TASK_TOOL_NAMES } from './manifest'

/**
 * tasks.* kernel tools (namespace owned by the memory module): one member
 * assigns a task to another member — a company member (tasks.assignees /
 * members.list), never a contact — and both follow it: the assignee completes
 * or comments, the assigner is notified. Who acts is resolved like Memory
 * writes (assistant-writes.ts): a person acts as themself; the company
 * assistant acts for the person it is answering, or fails loud. Not
 * approval-gated: the person asked for it in their own chat, and it only
 * lands with a colleague inside the company (owner decision log, 0159).
 */

export { TASK_TOOL_NAMES }

export type TaskToolDeps = {
  deps?: () => Promise<AssignedTaskDeps>
  writerOf?: (ctx: ToolContext) => Promise<MemoryWriter | null>
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/
const emptyInput = z.object({}).strict()
const assignInput = z
  .object({
    assignee_id: z.string().min(1).describe('The member id (from tasks.assignees), never a contact.'),
    title: z.string().min(1).max(200),
    context: z.string().max(4000).optional().describe('What the assignee needs to know to do it.'),
    due_on: z.string().regex(dayPattern, 'YYYY-MM-DD').optional().describe('Due day as YYYY-MM-DD.'),
  })
  .strict()
const taskInput = z.object({ task_id: z.string().min(1) }).strict()
const commentInput = z.object({ task_id: z.string().min(1), body: z.string().min(1).max(4000) }).strict()

async function liveDeps(): Promise<AssignedTaskDeps> {
  const { assignedTaskDeps } = await import('$lib/server/memory/assigned-tasks/live')
  return assignedTaskDeps()
}

const service = () => import('$lib/server/memory/assigned-tasks/service')
const view = (out: unknown) => out as AssignedTaskView | undefined

export function createTaskTools(opts: TaskToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const writerOf = opts.writerOf ?? liveMemoryWriterOf
  const actor = async (ctx: ToolContext): Promise<TaskActor> => {
    const w = requireWriter(await writerOf(ctx))
    return { userId: w.userId, via: w.kind === 'assistant' ? 'assistant' : 'person' }
  }
  // Every member's own tasks (CB3: the brain reaches them as the member).
  const base: Pick<ToolDescriptor, 'module' | 'permission'> = { module: 'memory', permission: { roles: ['admin', 'member', 'agent'] } }

  return [
    {
      ...base,
      name: 'tasks.assignees',
      summary: "List the company's members a task can be assigned to (id, name, email): members only, never contacts.",
      auditClass: 'read',
      inputSchema: emptyInput,
      handler: async (ctx) => ({ members: await (await service()).listAssignees(await deps(), (await actor(ctx)).userId) }),
    },
    {
      ...base,
      name: 'tasks.assign',
      summary:
        "Assign a task to another member of the company (assignee_id from tasks.assignees): a title, optional context and due day (YYYY-MM-DD). It appears in their Needs you and task list, marked as assigned by the person you work for, who is notified when it is completed or commented on. For the person's own tasks use memory.capture_thought.",
      auditClass: 'mutate',
      activity: (input: z.infer<typeof assignInput>, output: unknown) => {
        const t = view(output)
        return t ? `${t.assigner.name} assigned '${t.title}' to ${t.assignee.name}` : `Assigned '${input.title}'`
      },
      inputSchema: assignInput,
      handler: async (ctx, input) => {
        const i = assignInput.parse(input)
        return (await service()).assignTask(await deps(), await actor(ctx), {
          assigneeId: i.assignee_id,
          title: i.title,
          context: i.context,
          dueOn: i.due_on,
        })
      },
    },
    {
      ...base,
      name: 'tasks.list',
      summary: 'List the tasks assigned to the person you work for (assignedToMe) and by them (assignedByMe), with status, due day, comments and what is new for them.',
      auditClass: 'read',
      inputSchema: emptyInput,
      handler: async (ctx) => (await service()).listTasks(await deps(), (await actor(ctx)).userId),
    },
    {
      ...base,
      name: 'tasks.complete',
      summary: 'Mark a task assigned to the person you work for as done; the assigner is notified.',
      auditClass: 'mutate',
      activity: (_input: z.infer<typeof taskInput>, output: unknown) => {
        const t = view(output)
        return t ? `${t.assignee.name} completed '${t.title}'` : 'Completed an assigned task'
      },
      inputSchema: taskInput,
      handler: async (ctx, input) => (await service()).completeTask(await deps(), await actor(ctx), taskInput.parse(input).task_id),
    },
    {
      ...base,
      name: 'tasks.comment',
      summary: 'Comment on an assigned task (as its assigner or assignee); the other person is notified.',
      auditClass: 'mutate',
      // The comment itself stays out of the audit line.
      activity: (_input: z.infer<typeof commentInput>, output: unknown) => {
        const t = view(output)
        const author = t?.comments.at(-1)?.author.name
        return t && author ? `${author} commented on '${t.title}'` : 'Commented on an assigned task'
      },
      inputSchema: commentInput,
      handler: async (ctx, input) => {
        const i = commentInput.parse(input)
        return (await service()).commentOnTask(await deps(), await actor(ctx), i.task_id, i.body)
      },
    },
  ]
}
