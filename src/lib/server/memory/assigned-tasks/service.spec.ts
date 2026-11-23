import { describe, expect, it, vi } from 'vitest'
import { memoryAssignedTaskStore } from './memory-store'
import {
  AssignedTaskError,
  assignTask,
  commentOnTask,
  completeTask,
  getTask,
  listAssignees,
  listTasks,
  markTaskSeen,
  needsYouTasks,
  type AssignedTaskDeps,
  type CoworkerTaskEvent,
} from './service'

const people = [
  { id: 'alex', name: 'Alex', email: 'alex@k.co' },
  { id: 'ony', name: 'Ony', email: 'ony@k.co' },
  { id: 'sam', name: 'Sam', email: 'sam@k.co' },
]

function setup() {
  const store = memoryAssignedTaskStore()
  let clock = new Date('2026-11-19T09:00:00Z').getTime()
  let n = 0
  const notify = vi.fn(async () => {})
  const coworkerWork = vi.fn(async (_e: CoworkerTaskEvent) => {})
  const deps: AssignedTaskDeps = {
    store,
    directory: {
      get: async (id) => people.find((p) => p.id === id) ?? null,
      list: async () => people,
    },
    notify,
    coworkerWork,
    now: () => new Date((clock += 60_000)),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  }
  return { deps, store, notify, coworkerWork }
}

const alex = { userId: 'alex', via: 'assistant' as const }
const ony = { userId: 'ony', via: 'person' as const }

describe('assigned tasks', () => {
  it('assigning lands with the member: in their Needs you with title, context and due date, and who assigned it', async () => {
    const { deps, notify } = setup()
    const task = await assignTask(deps, alex, {
      assigneeId: 'ony',
      title: 'Send the Q4 deck',
      context: 'The client wants it before the call.',
      dueOn: '2026-11-21',
    })
    expect(task).toMatchObject({
      title: 'Send the Q4 deck',
      context: 'The client wants it before the call.',
      dueOn: '2026-11-21',
      status: 'open',
      createdVia: 'assistant',
      assigner: { id: 'alex', name: 'Alex' },
      assignee: { id: 'ony', name: 'Ony' },
    })
    const needs = await needsYouTasks(deps, 'ony')
    expect(needs.assignedToMe.map((t) => t.title)).toEqual(['Send the Q4 deck'])
    expect(needs.assignedToMe[0]).toMatchObject({ role: 'assignee', update: { kind: 'assigned' } })
    expect(needs.updates).toEqual([])
    // The assigner has nothing waiting until Ony does something.
    expect(await needsYouTasks(deps, 'alex')).toEqual({ assignedToMe: [], updates: [] })
    expect(notify).toHaveBeenCalledWith('ony', expect.objectContaining({
      title: 'Alex assigned you a task',
      body: 'Send the Q4 deck · due 2026-11-21',
      url: '/m/memory/tasks#assigned',
      email: true,
    }))
  })

  it('the task list holds it for both: assigned to me for the assignee, assigned by me for the assigner; nobody else sees it', async () => {
    const { deps } = setup()
    await assignTask(deps, alex, { assigneeId: 'ony', title: 'Book the venue' })
    expect((await listTasks(deps, 'ony')).assignedToMe.map((t) => t.title)).toEqual(['Book the venue'])
    expect((await listTasks(deps, 'ony')).assignedByMe).toEqual([])
    expect((await listTasks(deps, 'alex')).assignedByMe.map((t) => t.title)).toEqual(['Book the venue'])
    expect(await listTasks(deps, 'sam')).toEqual({ assignedToMe: [], assignedByMe: [] })
  })

  it('only members can be assigned (never a contact or an unknown id), and not yourself', async () => {
    const { deps } = setup()
    await expect(assignTask(deps, alex, { assigneeId: 'contact-42', title: 'X' })).rejects.toThrow(/not a member/)
    await expect(assignTask(deps, alex, { assigneeId: 'alex', title: 'X' })).rejects.toThrow(/Memory/)
    await expect(assignTask(deps, alex, { assigneeId: 'ony', title: '  ' })).rejects.toThrow(/title/)
    await expect(assignTask(deps, alex, { assigneeId: 'ony', title: 'X', dueOn: '2026-02-30' })).rejects.toThrow(/due date/)
    await expect(assignTask(deps, alex, { assigneeId: 'ony', title: 'X', dueOn: 'Friday' })).rejects.toThrow(/due date/)
    await expect(assignTask(deps, { userId: 'ghost', via: 'person' }, { assigneeId: 'ony', title: 'X' })).rejects.toThrow(/not a member/)
  })

  it('completing notifies the assigner and shows in their Needs you until they mark it seen', async () => {
    const { deps, notify } = setup()
    const task = await assignTask(deps, alex, { assigneeId: 'ony', title: 'Send the Q4 deck' })
    notify.mockClear()
    const done = await completeTask(deps, ony, task.id)
    expect(done.status).toBe('done')
    expect(notify).toHaveBeenCalledWith('alex', expect.objectContaining({ title: "Ony completed 'Send the Q4 deck'", email: true }))
    expect((await needsYouTasks(deps, 'ony')).assignedToMe).toEqual([])
    const updates = (await needsYouTasks(deps, 'alex')).updates
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ role: 'assigner', status: 'done', update: { kind: 'completed' } })
    await markTaskSeen(deps, 'alex', task.id)
    expect((await needsYouTasks(deps, 'alex')).updates).toEqual([])
    // Still in the assigner's list, done.
    expect((await listTasks(deps, 'alex')).assignedByMe[0]).toMatchObject({ status: 'done', update: null })
  })

  it('a task assigned and completed in the same millisecond still shows the assigner the news', async () => {
    const { deps } = setup()
    const frozen = new Date('2026-11-23T10:00:00Z')
    const same: AssignedTaskDeps = { ...deps, now: () => frozen }
    const task = await assignTask(same, alex, { assigneeId: 'ony', title: 'Send the Q4 deck' })
    await completeTask(same, ony, task.id)
    expect((await needsYouTasks(same, 'alex')).updates).toMatchObject([{ update: { kind: 'completed' } }])
  })

  it('only the assignee completes; twice is refused; strangers get not found', async () => {
    const { deps } = setup()
    const task = await assignTask(deps, alex, { assigneeId: 'ony', title: 'X' })
    await expect(completeTask(deps, { userId: 'alex', via: 'person' }, task.id)).rejects.toThrow(/Only Ony/)
    await expect(completeTask(deps, { userId: 'sam', via: 'person' }, task.id)).rejects.toThrow(AssignedTaskError)
    await expect(completeTask(deps, { userId: 'sam', via: 'person' }, task.id)).rejects.toThrow(/not found/)
    await completeTask(deps, ony, task.id)
    await expect(completeTask(deps, ony, task.id)).rejects.toThrow(/already done/)
  })

  it('a comment by the assignee reaches the assigner (push + Needs you); a reply reaches the assignee', async () => {
    const { deps, notify } = setup()
    const task = await assignTask(deps, alex, { assigneeId: 'ony', title: 'Send the Q4 deck' })
    await markTaskSeen(deps, 'ony', task.id)
    notify.mockClear()
    await commentOnTask(deps, ony, task.id, 'Which version — with or without pricing?')
    expect(notify).toHaveBeenCalledWith('alex', expect.objectContaining({
      title: "Ony commented on 'Send the Q4 deck'",
      body: 'Which version — with or without pricing?',
      email: false,
    }))
    const updates = (await needsYouTasks(deps, 'alex')).updates
    expect(updates[0]).toMatchObject({ update: { kind: 'commented' } })
    expect(updates[0].comments.map((c) => [c.author.name, c.body])).toEqual([['Ony', 'Which version — with or without pricing?']])

    await commentOnTask(deps, { userId: 'alex', via: 'person' }, task.id, 'With pricing.')
    // Replying counts as having seen it.
    expect((await needsYouTasks(deps, 'alex')).updates).toEqual([])
    expect(notify).toHaveBeenLastCalledWith('ony', expect.objectContaining({ title: "Alex commented on 'Send the Q4 deck'" }))
    expect((await needsYouTasks(deps, 'ony')).assignedToMe[0].update).toMatchObject({ kind: 'commented' })
    await expect(commentOnTask(deps, { userId: 'sam', via: 'person' }, task.id, 'hi')).rejects.toThrow(/not found/)
    await expect(commentOnTask(deps, ony, task.id, '   ')).rejects.toThrow(/comment/)
  })

  it('a failed notification never fails the change', async () => {
    const { deps, notify } = setup()
    notify.mockRejectedValue(new Error('push down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const task = await assignTask(deps, alex, { assigneeId: 'ony', title: 'X' })
    expect(task.status).toBe('open')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('a member who left still shows by name as a former member', async () => {
    const { deps, store } = setup()
    const task = await assignTask(deps, alex, { assigneeId: 'ony', title: 'X' })
    store.tasks.get(task.id)!.assignerId = 'left'
    expect((await listTasks(deps, 'ony')).assignedToMe[0].assigner).toEqual({ id: 'left', name: 'A former member' })
  })

  it('lists the members you can assign to: everyone but you', async () => {
    const { deps } = setup()
    expect(await listAssignees(deps, 'alex')).toEqual([
      { id: 'ony', name: 'Ony', email: 'ony@k.co' },
      { id: 'sam', name: 'Sam', email: 'sam@k.co' },
    ])
  })
})

describe('a task given to an AI co-worker (plan/phase-ai-coworkers.md C6)', () => {
  const withCoworker = [
    { id: 'alex', name: 'Alex', email: 'alex@k.co', kind: 'human' as const },
    { id: 'cw-mkt', name: 'Marketing', email: 'marketing.cwmkt000@coworker.invalid', kind: 'coworker' as const },
  ]
  function coworkerSetup() {
    const s = setup()
    const deps: AssignedTaskDeps = {
      ...s.deps,
      directory: { get: async (id) => withCoworker.find((p) => p.id === id) ?? null, list: async () => withCoworker },
    }
    return { ...s, deps }
  }
  const me = { userId: 'alex', via: 'person' as const }
  const cw = { userId: 'cw-mkt', via: 'person' as const }

  it('assigning queues its turn instead of a push: co-workers get no notifications', async () => {
    const { deps, notify, coworkerWork } = coworkerSetup()
    const task = await assignTask(deps, me, { assigneeId: 'cw-mkt', title: 'Draft the launch email' })
    expect(notify).not.toHaveBeenCalled()
    expect(coworkerWork).toHaveBeenCalledTimes(1)
    expect(coworkerWork).toHaveBeenCalledWith({ kind: 'assigned', taskId: task.id, coworkerId: 'cw-mkt', byUserId: 'alex', at: expect.any(Date) })
  })

  it("a person's comment on the open task asks for one more turn; the co-worker's own comment notifies the person", async () => {
    const { deps, notify, coworkerWork } = coworkerSetup()
    const task = await assignTask(deps, me, { assigneeId: 'cw-mkt', title: 'Draft the launch email' })
    coworkerWork.mockClear()
    const after = await commentOnTask(deps, me, task.id, 'Add the price, please.')
    expect(coworkerWork).toHaveBeenCalledWith({
      kind: 'commented',
      taskId: task.id,
      coworkerId: 'cw-mkt',
      byUserId: 'alex',
      commentId: after.comments.at(-1)!.id,
      at: expect.any(Date),
    })
    coworkerWork.mockClear()
    await commentOnTask(deps, cw, task.id, 'Here is the draft.')
    expect(coworkerWork).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('alex', expect.objectContaining({ title: "Marketing commented on 'Draft the launch email'" }))
  })

  it('a comment on a task the co-worker completed asks for no turn', async () => {
    const { deps, coworkerWork } = coworkerSetup()
    const task = await assignTask(deps, me, { assigneeId: 'cw-mkt', title: 'Draft the launch email' })
    await completeTask(deps, cw, task.id)
    coworkerWork.mockClear()
    await commentOnTask(deps, me, task.id, 'Thanks!')
    expect(coworkerWork).not.toHaveBeenCalled()
  })

  it('getTask: the task as its assignee sees it; anyone else gets not found', async () => {
    const { deps } = coworkerSetup()
    const task = await assignTask(deps, me, { assigneeId: 'cw-mkt', title: 'Draft the launch email' })
    expect((await getTask(deps, 'cw-mkt', task.id)).role).toBe('assignee')
    await expect(getTask(deps, 'sam', task.id)).rejects.toMatchObject({ code: 'not_found' })
  })
})
