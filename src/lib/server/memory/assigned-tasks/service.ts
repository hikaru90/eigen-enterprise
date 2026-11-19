import type { AssignedTask, AssignedTaskComment, AssignedTaskStore, AssigneeUpdate, AssignerUpdate, TaskSide } from './store'

/**
 * Assigned tasks: one member gives another member a task (Contribute: "assign
 * a task to another organization member"). Memory is private per person, so
 * an assigned task is not a thought in anyone's Memory: it is a company-level
 * record (migration 0159) that exactly two people read — the assigner and the
 * assignee. The assignee sees its title, context and due date, never the
 * assigner's Memory. People come from the company's members (the directory),
 * never from contacts.
 *
 * The assignee finds it under Needs you (while open) and in Memory › Tasks;
 * the assigner finds it in Memory › Tasks as "assigned by you", and under
 * Needs you while the assignee's completion or comment is unseen. Each change
 * notifies the other person (push, and email for the assignment and the
 * completion); a failed notification is logged and never fails the change.
 */

export type TaskPerson = { id: string; name: string; email: string }

export type TaskDirectory = {
  get(id: string): Promise<TaskPerson | null>
  list(): Promise<TaskPerson[]>
}

export type TaskNotification = {
  title: string
  body: string
  url: string
  tag: string
  /** Mirror the push to the person's email (only for the assignment and the completion). */
  email: boolean
}

export type AssignedTaskDeps = {
  store: AssignedTaskStore
  directory: TaskDirectory
  notify: (userId: string, n: TaskNotification) => Promise<void>
  now?: () => Date
  newId?: () => string
}

/** Who acts: the person themself, or their assistant on their word in chat. */
export type TaskActor = { userId: string; via: 'person' | 'assistant' }

export type AssignedTaskView = {
  id: string
  title: string
  context: string
  dueOn: string | null
  status: 'open' | 'done'
  createdVia: 'person' | 'assistant'
  createdAt: string
  completedAt: string | null
  assigner: { id: string; name: string }
  assignee: { id: string; name: string }
  /** The viewer's side of the task. */
  role: TaskSide
  /** What happened for the viewer that they have not acknowledged yet; null = nothing new. */
  update: { kind: AssigneeUpdate | AssignerUpdate; at: string } | null
  comments: Array<{ id: string; author: { id: string; name: string }; body: string; at: string }>
}

export type TaskLists = { assignedToMe: AssignedTaskView[]; assignedByMe: AssignedTaskView[] }
/** Needs you: the open tasks given to me, and what happened on the tasks I gave out. */
export type NeedsYouTasks = { assignedToMe: AssignedTaskView[]; updates: AssignedTaskView[] }

export class AssignedTaskError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found' | 'forbidden' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'AssignedTaskError'
  }
}

export const TASKS_URL = '/m/memory/tasks#assigned'
export const FORMER_MEMBER = 'A former member'
const TITLE_MAX = 200
const CONTEXT_MAX = 4000
const COMMENT_MAX = 4000

const nowOf = (d: AssignedTaskDeps) => (d.now ? d.now() : new Date())
const newIdOf = (d: AssignedTaskDeps) => (d.newId ? d.newId() : crypto.randomUUID())

function snippet(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

async function requireMember(d: AssignedTaskDeps, id: string, who: string): Promise<TaskPerson> {
  const person = await d.directory.get(id)
  if (!person) throw new AssignedTaskError('invalid', `${who} is not a member of this company. Pick a member (tasks.assignees), not a contact.`)
  return person
}

/** A task the person may see: theirs as assigner or assignee; anyone else gets "not found". */
async function visibleTask(d: AssignedTaskDeps, userId: string, taskId: string): Promise<{ task: AssignedTask; side: TaskSide }> {
  const task = await d.store.get(taskId)
  if (task && task.assigneeId === userId) return { task, side: 'assignee' }
  if (task && task.assignerId === userId) return { task, side: 'assigner' }
  throw new AssignedTaskError('not_found', 'Assigned task not found.')
}

async function send(d: AssignedTaskDeps, userId: string, n: TaskNotification): Promise<void> {
  try {
    await d.notify(userId, n)
  } catch (err) {
    console.error('[assigned-tasks] notification failed', { userId, tag: n.tag, error: err instanceof Error ? err.message : String(err) })
  }
}

function unseen(updateAt: Date | null, seenAt: Date | null): boolean {
  return updateAt !== null && (seenAt === null || seenAt.getTime() < updateAt.getTime())
}

async function views(d: AssignedTaskDeps, viewerId: string, tasks: AssignedTask[]): Promise<AssignedTaskView[]> {
  if (tasks.length === 0) return []
  const comments = await d.store.comments(tasks.map((t) => t.id))
  const ids = new Set<string>()
  for (const t of tasks) ids.add(t.assignerId).add(t.assigneeId)
  for (const c of comments) ids.add(c.authorId)
  const names = new Map<string, string>()
  for (const id of ids) names.set(id, (await d.directory.get(id))?.name ?? FORMER_MEMBER)
  const person = (id: string) => ({ id, name: names.get(id) ?? FORMER_MEMBER })
  const byTask = new Map<string, AssignedTaskComment[]>()
  for (const c of comments) byTask.set(c.taskId, [...(byTask.get(c.taskId) ?? []), c])
  return tasks.map((t) => {
    const role: TaskSide = t.assigneeId === viewerId ? 'assignee' : 'assigner'
    const update =
      role === 'assignee'
        ? unseen(t.assigneeUpdateAt, t.assigneeSeenAt) && t.assigneeUpdate
          ? { kind: t.assigneeUpdate, at: t.assigneeUpdateAt!.toISOString() }
          : null
        : unseen(t.assignerUpdateAt, t.assignerSeenAt) && t.assignerUpdate
          ? { kind: t.assignerUpdate, at: t.assignerUpdateAt!.toISOString() }
          : null
    return {
      id: t.id,
      title: t.title,
      context: t.context,
      dueOn: t.dueOn,
      status: t.status,
      createdVia: t.createdVia,
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
      assigner: person(t.assignerId),
      assignee: person(t.assigneeId),
      role,
      update,
      comments: (byTask.get(t.id) ?? []).map((c) => ({ id: c.id, author: person(c.authorId), body: c.body, at: c.createdAt.toISOString() })),
    }
  })
}

async function viewOne(d: AssignedTaskDeps, viewerId: string, task: AssignedTask): Promise<AssignedTaskView> {
  return (await views(d, viewerId, [task]))[0]
}

/** The members a person can give a task to: everyone in the company but themself. */
export async function listAssignees(d: AssignedTaskDeps, userId: string): Promise<TaskPerson[]> {
  return (await d.directory.list()).filter((p) => p.id !== userId).map((p) => ({ id: p.id, name: p.name, email: p.email }))
}

export async function assignTask(
  d: AssignedTaskDeps,
  actor: TaskActor,
  input: { assigneeId: string; title: string; context?: string; dueOn?: string | null },
): Promise<AssignedTaskView> {
  const title = input.title.trim()
  if (!title || title.length > TITLE_MAX) throw new AssignedTaskError('invalid', `A task needs a title of 1 to ${TITLE_MAX} characters.`)
  const context = (input.context ?? '').trim()
  if (context.length > CONTEXT_MAX) throw new AssignedTaskError('invalid', `The context is longer than ${CONTEXT_MAX} characters.`)
  const dueOn = input.dueOn?.trim() || null
  if (dueOn !== null && !validDay(dueOn)) throw new AssignedTaskError('invalid', `The due date must be a calendar day as YYYY-MM-DD (got "${dueOn}").`)
  const assigner = await requireMember(d, actor.userId, 'The assigner')
  if (input.assigneeId === actor.userId) {
    throw new AssignedTaskError('invalid', 'That is your own task: capture it in your Memory instead (memory.capture_thought). Assigning is for another member.')
  }
  const assignee = await requireMember(d, input.assigneeId, `"${input.assigneeId}"`)
  const at = nowOf(d)
  const task: AssignedTask = {
    id: newIdOf(d),
    assignerId: assigner.id,
    assigneeId: assignee.id,
    title,
    context,
    dueOn,
    status: 'open',
    createdVia: actor.via,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    assigneeUpdate: 'assigned',
    assigneeUpdateAt: at,
    assigneeSeenAt: null,
    assignerUpdate: null,
    assignerUpdateAt: null,
    assignerSeenAt: at,
  }
  await d.store.insert(task)
  await send(d, assignee.id, {
    title: `${assigner.name} assigned you a task`,
    body: snippet(dueOn ? `${title} · due ${dueOn}` : title),
    url: TASKS_URL,
    tag: `assigned-task-${task.id}`,
    email: true,
  })
  return viewOne(d, actor.userId, task)
}

export async function listTasks(d: AssignedTaskDeps, userId: string): Promise<TaskLists> {
  const all = await views(d, userId, await d.store.listFor(userId))
  return {
    assignedToMe: all.filter((t) => t.role === 'assignee'),
    assignedByMe: all.filter((t) => t.role === 'assigner'),
  }
}

export async function needsYouTasks(d: AssignedTaskDeps, userId: string): Promise<NeedsYouTasks> {
  const { assignedToMe, assignedByMe } = await listTasks(d, userId)
  return {
    assignedToMe: assignedToMe.filter((t) => t.status === 'open'),
    updates: assignedByMe.filter((t) => t.update !== null),
  }
}

export async function completeTask(d: AssignedTaskDeps, actor: TaskActor, taskId: string): Promise<AssignedTaskView> {
  const { task, side } = await visibleTask(d, actor.userId, taskId)
  if (side !== 'assignee') {
    const name = (await d.directory.get(task.assigneeId))?.name ?? FORMER_MEMBER
    throw new AssignedTaskError('forbidden', `Only ${name} can mark this task done: it is assigned to them.`)
  }
  const done = await d.store.complete(task.id, nowOf(d))
  if (!done) throw new AssignedTaskError('conflict', `'${task.title}' is already done.`)
  const assignee = (await d.directory.get(task.assigneeId))?.name ?? FORMER_MEMBER
  await send(d, task.assignerId, {
    title: `${assignee} completed '${snippet(task.title, 80)}'`,
    body: snippet(task.title),
    url: TASKS_URL,
    tag: `assigned-task-${task.id}`,
    email: true,
  })
  return viewOne(d, actor.userId, done)
}

export async function commentOnTask(d: AssignedTaskDeps, actor: TaskActor, taskId: string, body: string): Promise<AssignedTaskView> {
  const { task, side } = await visibleTask(d, actor.userId, taskId)
  const text = body.trim()
  if (!text || text.length > COMMENT_MAX) throw new AssignedTaskError('invalid', `A comment needs 1 to ${COMMENT_MAX} characters.`)
  const updated = await d.store.addComment({ id: newIdOf(d), taskId: task.id, authorId: actor.userId, body: text, createdAt: nowOf(d) }, side)
  const author = (await d.directory.get(actor.userId))?.name ?? FORMER_MEMBER
  await send(d, side === 'assignee' ? task.assignerId : task.assigneeId, {
    title: `${author} commented on '${snippet(task.title, 80)}'`,
    body: snippet(text),
    url: TASKS_URL,
    tag: `assigned-task-${task.id}`,
    email: false,
  })
  return viewOne(d, actor.userId, updated)
}

/** The person acknowledged what happened on the task (the "Got it" on Needs you). */
export async function markTaskSeen(d: AssignedTaskDeps, userId: string, taskId: string): Promise<void> {
  const { task, side } = await visibleTask(d, userId, taskId)
  await d.store.markSeen(task.id, side, nowOf(d))
}
