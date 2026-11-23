import { describe, expect, it } from 'vitest'
import { coworkerPrincipal } from '$lib/kernel/principals'
import type { ToolContext } from '$lib/kernel/types'
import { canUse, createChannel, listMessages, postMessage } from '../../../../modules/messages/service'
import { createRhythm, runRhythmNow, tickRhythms, type RhythmDeps } from './rhythms'
import { queueTaskWork } from './task-work'
import { turnsFixture, type Script } from './test-fixtures'

/**
 * Co-workers act on their own (plan/phase-ai-coworkers.md C6), over the
 * in-memory Messages, tasks and rhythms with the real messages.* and tasks.*
 * tools and a scripted model:
 * - assignments: tasks.assign to a co-worker queues its turn; it works the
 *   task, answers with a comment and completes it; a person's follow-up
 *   comment queues exactly one more turn;
 * - rhythms: a due slot posts a top-level message, once across two processes;
 *   an off co-worker posts nothing; a co-worker no longer in the conversation
 *   stops with a visible reason;
 * - every finished or stopped run lands in "Needs you" (accountable human,
 *   and the assigner).
 */

const human = (id: string): ToolContext => ({ principal: { id, kind: 'human', roles: ['member'] }, requestId: `r-${id}` })
const asCoworker = (id: string): ToolContext => ({ principal: coworkerPrincipal(id, `coworker-${id}`), requestId: `r-${id}` })

function rhythmDeps(fx: ReturnType<typeof turnsFixture>, at: () => Date): RhythmDeps {
  return {
    store: fx.rhythms,
    runs: fx.runs,
    coworkers: {
      get: async (id) => {
        const c = fx.coworkers.get(id)
        if (!c) throw new Error(`no co-worker ${id}`)
        return c
      },
    },
    targets: {
      coworkerMayPost: async (cw, id) => {
        const c = await fx.deps.store.getConversation(id)
        return c !== null && (await canUse(fx.deps, cw, c, 'edit'))
      },
      titleFor: async (reader, id) => {
        const c = await fx.deps.store.getConversation(id)
        return c && (await canUse(fx.deps, reader, c)) ? `#${c.name}` : null
      },
      listFor: async () => [],
    },
    start: (id) => {
      void fx.handle.turns.work(id)
    },
    ready: () => {},
    now: at,
  }
}

const owner = { id: 'owner', role: 'owner' as const, kind: 'person' as const }

describe('assignments: a task given to a co-worker', () => {
  it('queues its turn; it works the task as itself, answers with a comment and completes it; the result reaches Needs you', async () => {
    const script: Script = async (call) => {
      expect(call.agentId).toBe('coworker-cw-mkt')
      const taskId = /Task id: (\S+)/.exec(call.system)![1]!
      await fx.registry.execute('tasks.complete', { task_id: taskId }, asCoworker('cw-mkt'))
      return 'Draft: "Calm software, now for teams." Done.'
    }
    const fx = turnsFixture({ script })
    await fx.handle.reload()
    const task = (await fx.registry.execute(
      'tasks.assign',
      { assignee_id: 'cw-mkt', title: 'Draft the launch email', context: 'For the December list.' },
      human('bea'),
    )) as { id: string }
    await fx.settle()

    expect(fx.calls).toHaveLength(1)
    expect(fx.calls[0]!.sessionId).toBe(`coworker:cw-mkt:task:${task.id}`)
    expect(fx.calls[0]!.system).toContain('# The task assigned to you\nTitle: Draft the launch email')
    expect(fx.calls[0]!.system).toContain('What they told you:\nFor the December list.')
    expect(fx.calls[0]!.system).toContain('Bea Member (@bea, person) assigned you the task above.')
    expect(fx.calls[0]!.requestedBy).toBe('bea')

    const { listTasks } = await import('$lib/server/memory/assigned-tasks/service')
    const [seen] = (await listTasks(fx.taskDeps, 'bea')).assignedByMe
    expect(seen).toMatchObject({ status: 'done', comments: [{ author: { id: 'cw-mkt' }, body: expect.stringContaining('Calm software') }] })
    // The assigner hears about the completion and the comment (push); the co-worker got no push.
    expect(fx.notified.map((n) => n.userId)).toEqual(['bea', 'bea'])

    expect(fx.runs.rows).toEqual([
      expect.objectContaining({ triggerKind: 'assignment', taskId: task.id, triggerKey: `task:${task.id}`, status: 'done', conversationId: null }),
    ])
    // Needs you: the accountable human (the owner) and the assigner.
    expect(fx.runs.notices.map((n) => n.userId).sort()).toEqual(['bea', 'owner'])
  })

  it("blocked: it comments what it needs and leaves the task open; the assigner's answer queues exactly one more turn", async () => {
    const script: Script = async (call, n) => {
      if (n === 1) return 'Blocked: which price do we announce? @bea'
      const taskId = /Task id: (\S+)/.exec(call.system)![1]!
      await fx.registry.execute('tasks.complete', { task_id: taskId }, asCoworker('cw-mkt'))
      return 'Done, with $12 per seat.'
    }
    const fx = turnsFixture({ script })
    await fx.handle.reload()
    const task = (await fx.registry.execute('tasks.assign', { assignee_id: 'cw-mkt', title: 'Draft the launch email' }, human('bea'))) as { id: string }
    await fx.settle()
    const { getTask } = await import('$lib/server/memory/assigned-tasks/service')
    expect(await getTask(fx.taskDeps, 'bea', task.id)).toMatchObject({ status: 'open', comments: [{ body: 'Blocked: which price do we announce? @bea' }] })

    const answered = (await fx.registry.execute('tasks.comment', { task_id: task.id, body: '$12 per seat.' }, human('bea'))) as {
      comments: { id: string }[]
    }
    await fx.settle()
    expect(fx.calls).toHaveLength(2)
    expect(fx.calls[1]!.sessionId).toBe(fx.calls[0]!.sessionId)
    expect(fx.calls[1]!.system).toContain('Bea Member (@bea, person) commented on the task:\n$12 per seat.')
    expect(fx.calls[1]!.system).toContain('Blocked: which price do we announce?')
    expect(await getTask(fx.taskDeps, 'bea', task.id)).toMatchObject({ status: 'done' })

    // Idempotent per comment: hearing the same comment again (another process, a redelivery) queues nothing.
    const again = await queueTaskWork(
      { runs: fx.runs, start: () => {} },
      { kind: 'commented', taskId: task.id, coworkerId: 'cw-mkt', byUserId: 'bea', commentId: answered.comments.at(-1)!.id, at: new Date() },
    )
    expect(again).toBeNull()
    expect(fx.runs.rows.map((r) => [r.triggerKey, r.status])).toEqual([
      [`task:${task.id}`, 'done'],
      [`task-comment:${answered.comments.at(-1)!.id}`, 'done'],
    ])
  })

  it('a switched-off co-worker stops visibly: unavailable, with a notice; nothing runs', async () => {
    const fx = turnsFixture({ script: () => 'never' })
    await fx.handle.reload()
    fx.coworkers.get('cw-mkt')!.enabled = false
    await fx.registry.execute('tasks.assign', { assignee_id: 'cw-mkt', title: 'Draft the launch email' }, human('bea'))
    await fx.settle()
    expect(fx.calls).toHaveLength(0)
    expect(fx.runs.rows[0]).toMatchObject({ status: 'stopped', stopReason: 'unavailable' })
    expect(fx.runs.notices.map((n) => n.userId).sort()).toEqual(['bea', 'owner'])
  })

  it('a model failure is a comment on the task @mentioning the accountable human, and a failed run', async () => {
    const fx = turnsFixture({
      script: () => {
        throw new Error('upstream 502')
      },
    })
    await fx.handle.reload()
    const task = (await fx.registry.execute('tasks.assign', { assignee_id: 'cw-mkt', title: 'Draft the launch email' }, human('bea'))) as { id: string }
    await fx.settle()
    const { getTask } = await import('$lib/server/memory/assigned-tasks/service')
    const t = await getTask(fx.taskDeps, 'bea', task.id)
    expect(t.status).toBe('open')
    expect(t.comments[0]!.body).toContain("I couldn't answer this: my model call failed (upstream 502). @olga")
    expect(fx.runs.rows[0]).toMatchObject({ status: 'failed', stopReason: 'model_error' })
  })
})

describe('rhythms: scheduled check-ins', () => {
  // Monday 2026-11-23, 08:00 UTC = 09:00 Europe/Berlin (CET).
  const slot = new Date('2026-11-23T08:00:00Z')

  async function withRhythm(script: Script = () => 'Standup: launch email drafted; pricing next; no blockers.') {
    const fx = turnsFixture({ script })
    await fx.handle.reload()
    const marketing = await createChannel(fx.deps, 'owner', { name: 'marketing', private: false })
    let now = new Date('2026-11-22T12:00:00Z')
    const deps = rhythmDeps(fx, () => now)
    const rhythm = await createRhythm(deps, owner, {
      coworkerUserId: 'cw-mkt',
      weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'],
      time: '09:00',
      timeZone: 'Europe/Berlin',
      instruction: 'Post the marketing standup: yesterday, today, blockers.',
      targetConversationId: marketing.id,
    })
    return { fx, deps, rhythm, marketing, at: (d: Date) => (now = d) }
  }

  it('at the due slot it posts a top-level message, exactly once across two processes; the accountable human gets the result', async () => {
    const { fx, deps, rhythm, marketing, at } = await withRhythm()
    expect(rhythm.nextAt).toBe(slot.toISOString())
    at(new Date(slot.getTime() - 60_000))
    expect(await tickRhythms(deps)).toEqual([])

    at(new Date(slot.getTime() + 30_000))
    // Two app processes tick at once: one takes the slot.
    const [a, b] = await Promise.all([tickRhythms(deps), tickRhythms({ ...deps })])
    expect(a.length + b.length).toBe(1)
    await fx.settle()

    expect(fx.calls).toHaveLength(1)
    expect(fx.calls[0]!.system).toContain('It is time for your scheduled check-in, which Olga Owner (@olga, person) set up:\nPost the marketing standup')
    expect(fx.calls[0]!.system).toContain('posted for you as a new message in #marketing')
    const { messages } = await listMessages(fx.deps, 'owner', marketing.id, { limit: 10 })
    expect(messages.map((m) => [m.authorId, m.parentId, m.body])).toEqual([['cw-mkt', null, 'Standup: launch email drafted; pricing next; no blockers.']])
    expect(fx.runs.rows).toEqual([
      expect.objectContaining({
        triggerKind: 'rhythm',
        rhythmId: rhythm.id,
        status: 'done',
        conversationId: marketing.id,
        threadRootId: messages[0]!.id,
        triggerKey: `rhythm:${rhythm.id}:${slot.toISOString()}`,
        triggeredAt: slot,
      }),
    ])
    expect(fx.runs.notices.map((n) => n.userId)).toEqual(['owner'])

    // The same slot is never posted twice; the next is Tuesday's.
    expect(await tickRhythms(deps)).toEqual([])
    expect((await fx.rhythms.get(rhythm.id))!.lastSlotAt).toEqual(slot)
  })

  it('missed slots are not replayed: after downtime only the latest due slot posts', async () => {
    const { fx, deps, at } = await withRhythm()
    at(new Date('2026-11-26T08:10:00Z'))
    const queued = await tickRhythms(deps)
    await fx.settle()
    expect(queued.map((r) => r.triggeredAt.toISOString())).toEqual(['2026-11-26T08:00:00.000Z'])
    expect(fx.calls).toHaveLength(1)
  })

  it('a switched-off or removed co-worker takes no turn: the slot passes without a run', async () => {
    const { fx, deps, rhythm, at } = await withRhythm()
    fx.coworkers.get('cw-mkt')!.enabled = false
    at(new Date(slot.getTime() + 30_000))
    expect(await tickRhythms(deps)).toEqual([])
    fx.coworkers.get('cw-mkt')!.enabled = true
    fx.coworkers.get('cw-mkt')!.removedAt = '2026-11-23T08:00:10.000Z'
    at(new Date('2026-11-24T08:00:30Z'))
    expect(await tickRhythms(deps)).toEqual([])
    await fx.settle()
    expect(fx.runs.rows).toEqual([])
    expect(fx.calls).toHaveLength(0)
    expect((await fx.rhythms.get(rhythm.id))!.lastSlotAt).toEqual(new Date('2026-11-24T08:00:00Z'))
  })

  it('a switched-off rhythm runs no slot', async () => {
    const { fx, deps, rhythm, at } = await withRhythm()
    await fx.rhythms.update(rhythm.id, { enabled: false, updatedAt: new Date() })
    at(new Date(slot.getTime() + 30_000))
    expect(await tickRhythms(deps)).toEqual([])
  })

  it('a co-worker no longer in the conversation stops with not_member: no post, a visible reason, a notice', async () => {
    const fx = turnsFixture({ script: () => 'never posted' })
    await fx.handle.reload()
    const team = await createChannel(fx.deps, 'owner', { name: 'team', private: true, userIds: ['cw-mkt'] })
    let now = new Date('2026-11-22T12:00:00Z')
    const deps = rhythmDeps(fx, () => now)
    await createRhythm(deps, owner, {
      coworkerUserId: 'cw-mkt',
      weekdays: ['MO'],
      time: '09:00',
      timeZone: 'Europe/Berlin',
      instruction: 'Post the team update.',
      targetConversationId: team.id,
    })
    // It leaves the private channel.
    const key = `channel:${team.id}`
    fx.access.grants.set(key, fx.access.grants.get(key)!.filter((g) => !(g.subject.kind === 'user' && g.subject.userId === 'cw-mkt')))
    now = new Date(slot.getTime() + 30_000)
    expect(await tickRhythms(deps)).toHaveLength(1)
    await fx.settle()
    expect(fx.calls).toHaveLength(0)
    expect(fx.runs.rows[0]).toMatchObject({ status: 'stopped', stopReason: 'not_member', error: expect.stringContaining('not a member') })
    expect(fx.runs.notices.map((n) => n.userId)).toEqual(['owner'])
    expect((await listMessages(fx.deps, 'owner', team.id, { limit: 10 })).messages).toEqual([])
  })

  it('is refused at create time when the co-worker is not a member of the conversation', async () => {
    const fx = turnsFixture({ script: () => 'x' })
    const secret = await createChannel(fx.deps, 'owner', { name: 'secret', private: true })
    const deps = rhythmDeps(fx, () => new Date('2026-11-22T12:00:00Z'))
    await expect(
      createRhythm(deps, owner, { coworkerUserId: 'cw-mkt', weekdays: ['MO'], time: '09:00', timeZone: 'Europe/Berlin', instruction: 'x', targetConversationId: secret.id }),
    ).rejects.toMatchObject({ code: 'not_member' })
  })

  it('run now posts outside the schedule and leaves it untouched; replies to the post are a thread like any other', async () => {
    const { fx, deps, rhythm, marketing } = await withRhythm((_call, n) => (n === 1 ? 'Standup now.' : 'Thanks, noted.'))
    const run = await runRhythmNow(deps, owner, rhythm.id)
    await fx.settle()
    expect(run.triggerKey).toMatch(new RegExp(`^rhythm:${rhythm.id}:now:`))
    expect((await fx.rhythms.get(rhythm.id))!.lastSlotAt).toEqual(new Date('2026-11-22T12:00:00Z'))
    const post = (await listMessages(fx.deps, 'owner', marketing.id, { limit: 10 })).messages[0]!
    expect(post).toMatchObject({ authorId: 'cw-mkt', body: 'Standup now.' })
    // A person answers in the post's thread with an @mention: an ordinary thread turn (C3).
    await postMessage(fx.deps, 'bea', marketing.id, '@marketing what about pricing?', { parentId: post.id })
    await fx.settle()
    expect(fx.calls.map((c) => c.sessionId)).toEqual([`coworker:cw-mkt:run:${run.id}`, `coworker:cw-mkt:${marketing.id}:${post.id}`])
  })

  it('only the owner or an admin manages rhythms; the schedule is validated', async () => {
    const { deps, marketing } = await withRhythm()
    const base = { coworkerUserId: 'cw-mkt', weekdays: ['MO'], time: '09:00', timeZone: 'Europe/Berlin', instruction: 'x', targetConversationId: marketing.id }
    await expect(createRhythm(deps, { id: 'bea', role: 'member', kind: 'person' }, base)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(createRhythm(deps, { id: 'cw-gtm', role: 'member', kind: 'coworker' }, base)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(createRhythm(deps, owner, { ...base, weekdays: ['XX'] })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createRhythm(deps, owner, { ...base, time: '25:00' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createRhythm(deps, owner, { ...base, timeZone: 'Mars/Olympus' })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(createRhythm(deps, owner, { ...base, instruction: '   ' })).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('the rhythm schedule reuses the reminders’ weekly math (DST-safe)', () => {
  it('09:00 Europe/Berlin is 08:00 UTC in winter and 07:00 UTC in summer', async () => {
    const fx = turnsFixture({ script: () => 'ok' })
    const marketing = await createChannel(fx.deps, 'owner', { name: 'marketing', private: false })
    let now = new Date('2026-03-27T12:00:00Z')
    const deps = rhythmDeps(fx, () => now)
    const r = await createRhythm(deps, owner, {
      coworkerUserId: 'cw-mkt',
      weekdays: ['MO'],
      time: '09:00',
      timeZone: 'Europe/Berlin',
      instruction: 'x',
      targetConversationId: marketing.id,
    })
    // The clocks go forward on Sunday 2026-03-29: Monday's 09:00 is 07:00 UTC.
    expect(r.nextAt).toBe('2026-03-30T07:00:00.000Z')
    now = new Date('2026-03-30T07:00:00Z')
    expect((await tickRhythms(deps)).map((x) => x.triggeredAt.toISOString())).toEqual(['2026-03-30T07:00:00.000Z'])
    await fx.settle()
  })
})
