import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import { createChannel, postMessage } from '../../../../modules/messages/service'
import { decideClaim, type CoworkerRunRow } from './run-store'
import { turnsFixture } from './test-fixtures'
import { stopNote, THREAD_TURN_BUDGET } from './turns'

/**
 * The co-worker turn and its budgets (plan/phase-ai-coworkers.md §6, C3): a
 * thread allows THREAD_TURN_BUDGET co-worker turns without a person; the daily
 * cap and a model failure stop a turn. Never silently — a note as the
 * co-worker @mentions its accountable human (here the owner, @olga) — and
 * never retried.
 */

const lastLine = (input: string) => input.split('\n').at(-1) ?? ''

describe('the thread budget', () => {
  it(`a co-worker ping-pong stops after ${THREAD_TURN_BUDGET} turns with one visible note; a person's reply opens the budget again`, async () => {
    const fx = turnsFixture({
      // Each answers by pulling in the other: an endless loop without the budget.
      script: (call, n) => (call.agentId === 'coworker-cw-mkt' ? `ping ${n} @gtm` : `pong ${n} @marketing`),
    })
    await fx.handle.reload()
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    const { message: root } = await postMessage(fx.deps, 'bea', launch.id, '@marketing kick off the launch')
    await fx.settle()

    expect(fx.calls).toHaveLength(THREAD_TURN_BUDGET)
    const thread = await fx.thread(root.id)
    expect(thread.map((m) => m.authorId)).toEqual([
      'bea',
      ...Array.from({ length: THREAD_TURN_BUDGET }, (_, i) => (i % 2 === 0 ? 'cw-mkt' : 'cw-gtm')),
      'cw-mkt',
    ])
    const note = thread.at(-1)!
    expect(note.body).toContain(`this thread had ${THREAD_TURN_BUDGET} AI co-worker turns in a row without a person`)
    expect(note.body).toContain('@olga')
    expect(fx.runs.rows.map((r) => r.status)).toEqual([...Array<string>(THREAD_TURN_BUDGET).fill('done'), 'stopped'])
    expect(fx.runs.rows.at(-1)).toMatchObject({ stopReason: 'thread_budget', error: expect.stringContaining('budget 8') })
    // The turns left, as each prompt said: 8 down to 1.
    expect(fx.calls.map((c) => /This thread has (\d+) co-worker turn/.exec(c.system)![1])).toEqual(['8', '7', '6', '5', '4', '3', '2', '1'])

    // A person steps in: the thread may take co-worker turns again.
    fx.calls.length = 0
    const callsBefore = fx.runs.rows.length
    await postMessage(fx.deps, 'bea', launch.id, '@gtm just the price, please', { parentId: root.id })
    await fx.settle()
    expect(fx.calls.length).toBe(THREAD_TURN_BUDGET)
    expect(fx.runs.rows.length).toBe(callsBefore + THREAD_TURN_BUDGET + 1)
  })

  it('when several turns are over budget at once, the note is posted once', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 3, 9, 0, s))
    const run = (id: string, cw: string, s: number, extra: Partial<CoworkerRunRow>): CoworkerRunRow => ({
      id,
      coworkerUserId: cw,
      triggerKind: 'mention',
      conversationId: 'c',
      threadRootId: 'r',
      triggerMessageId: `m-${id}`,
      requestedByUserId: 'bea',
      status: 'queued',
      stopReason: null,
      costUsd: 0,
      triggeredAt: at(s),
      startedAt: null,
      heartbeatAt: null,
      endedAt: null,
      error: null,
      ...extra,
    })
    const done = Array.from({ length: 8 }, (_, i) => run(`d${i}`, i % 2 ? 'gtm' : 'mkt', 10 + i, { status: 'done', startedAt: at(10 + i) }))
    const input = { now: at(59), staleBefore: at(0), lastHumanAt: at(5), budget: 8 }
    const first = decideClaim([...done, run('q1', 'mkt', 30, {})], { ...input, coworkerUserId: 'mkt' })
    expect(first.next).toMatchObject({ kind: 'over_budget', turnsUsed: 8, noteAlreadyPosted: false })
    const second = decideClaim([...done, run('q1', 'mkt', 30, { status: 'stopped', stopReason: 'thread_budget' }), run('q2', 'gtm', 31, {})], {
      ...input,
      coworkerUserId: 'gtm',
    })
    expect(second.next).toMatchObject({ kind: 'over_budget', noteAlreadyPosted: true })
    // Turns before the person's last message do not count.
    expect(decideClaim([...done, run('q3', 'mkt', 40, {})], { ...input, lastHumanAt: at(20), coworkerUserId: 'mkt' }).next).toMatchObject({ kind: 'claim', turnsUsed: 0 })
  })
})

describe('a turn that cannot answer says so and is not retried', () => {
  it('the daily cap refuses: stopped (daily_cap), a note with the cap, @accountable human', async () => {
    const fx = turnsFixture({
      script: () => {
        throw new KernelError('budget_exceeded', 'agent coworker-cw-mkt reached its daily spend cap (5.01 >= 5 USD today, UTC)')
      },
    })
    await fx.handle.reload()
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(fx.deps, 'bea', general.id, '@marketing one more thing')
    await fx.settle()
    expect(fx.calls).toHaveLength(1)
    expect(fx.runs.rows).toEqual([expect.objectContaining({ status: 'stopped', stopReason: 'daily_cap', error: expect.stringContaining('daily spend cap') })])
    expect((await fx.thread(message.id)).at(-1)).toEqual({
      authorId: 'cw-mkt',
      body: "I've reached my daily AI budget ($5.00), so I can't answer this today. @olga, raise my cap or pick this up tomorrow.",
    })
  })

  it('a model failure: failed (model_error) with the error, a note, the cost so far on the run', async () => {
    const fx = turnsFixture({
      script: () => {
        throw new Error('gateway: upstream 502 from the provider')
      },
    })
    await fx.handle.reload()
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(fx.deps, 'bea', general.id, '@gtm price it')
    await fx.settle()
    expect(fx.calls).toHaveLength(1)
    expect(fx.runs.rows).toEqual([expect.objectContaining({ status: 'failed', stopReason: 'model_error', error: 'gateway: upstream 502 from the provider' })])
    const note = (await fx.thread(message.id)).at(-1)!
    expect(note.authorId).toBe('cw-gtm')
    expect(note.body).toContain('my model call failed (gateway: upstream 502 from the provider)')
    expect(note.body).toContain('@olga')
    expect(note.body).toContain("I won't retry")
  })

  it('an empty answer is a model failure too, never an empty post', async () => {
    const fx = turnsFixture({ script: () => '   ' })
    await fx.handle.reload()
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(fx.deps, 'bea', general.id, '@gtm hello')
    await fx.settle()
    expect(fx.runs.rows).toEqual([expect.objectContaining({ status: 'failed', stopReason: 'model_error', error: 'the model answered with no text' })])
    expect((await fx.thread(message.id)).map((m) => m.authorId)).toEqual(['bea', 'cw-gtm'])
  })

  it('a turn whose process died is recovered as interrupted (with a note); the turn behind it runs', async () => {
    const fx = turnsFixture({ script: (call) => `answer to ${lastLine(call.input)}`, staleAfterMs: 60_000 })
    await fx.handle.reload()
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const { message: root } = await postMessage(fx.deps, 'bea', general.id, 'kick-off')
    const lost = await fx.runs.enqueue({
      coworkerUserId: 'cw-mkt',
      triggerKind: 'mention',
      conversationId: general.id,
      threadRootId: root.id,
      triggerMessageId: root.id,
      requestedByUserId: 'bea',
      triggeredAt: new Date(root.createdAt),
    })
    const longAgo = new Date(new Date(root.createdAt).getTime() - 3_600_000)
    await fx.runs.update(lost!.id, { status: 'running', startedAt: longAgo, heartbeatAt: longAgo })
    await postMessage(fx.deps, 'carl', general.id, '@marketing and now?', { parentId: root.id })
    await fx.settle()
    expect(fx.runs.rows.map((r) => [r.status, r.stopReason])).toEqual([
      ['failed', 'interrupted'],
      ['done', null],
    ])
    const thread = await fx.thread(root.id)
    expect(thread.map((m) => m.authorId)).toEqual(['bea', 'carl', 'cw-mkt', 'cw-mkt'])
    expect(thread[2]!.body).toContain('My turn here was interrupted')
    expect(thread[3]!.body).toBe('answer to @marketing and now?')
  })

  it('resume() after a restart runs the turns queued before it', async () => {
    const fx = turnsFixture({ script: () => 'late but here' })
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(fx.deps, 'bea', general.id, '@marketing are you there?')
    await fx.runs.enqueue({
      coworkerUserId: 'cw-mkt',
      triggerKind: 'mention',
      conversationId: general.id,
      threadRootId: message.id,
      triggerMessageId: message.id,
      requestedByUserId: 'bea',
      triggeredAt: new Date(message.createdAt),
    })
    await fx.handle.reload()
    await fx.handle.turns.resume()
    await fx.settle()
    expect((await fx.thread(message.id)).at(-1)).toEqual({ authorId: 'cw-mkt', body: 'late but here' })
  })

  it('switched off between queue and claim: stopped (unavailable), nothing posted', async () => {
    const fx = turnsFixture({ script: () => 'should not be posted' })
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(fx.deps, 'bea', general.id, '@marketing hi')
    await fx.runs.enqueue({
      coworkerUserId: 'cw-mkt',
      triggerKind: 'mention',
      conversationId: general.id,
      threadRootId: message.id,
      triggerMessageId: message.id,
      requestedByUserId: 'bea',
      triggeredAt: new Date(message.createdAt),
    })
    fx.coworkers.get('cw-mkt')!.enabled = false
    await fx.handle.turns.resume()
    await fx.settle()
    expect(fx.runs.rows).toEqual([expect.objectContaining({ status: 'stopped', stopReason: 'unavailable' })])
    expect(fx.calls).toEqual([])
    expect(await fx.thread(message.id)).toHaveLength(1)
  })
})

describe('what a turn carries', () => {
  it('on eigenInference a stored pick (a Sonnet chosen before) does not run: the turn names no model, so the pool’s chat pick runs', async () => {
    const fx = turnsFixture({ script: () => 'On it.', extra: { aiSource: async () => 'eigeninference' } })
    await fx.handle.reload()
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    await postMessage(fx.deps, 'bea', launch.id, '@marketing plan the launch')
    await fx.settle()
    expect(fx.calls.length).toBeGreaterThan(0)
    expect(fx.calls[0]!.modelId).toBeUndefined()
  })

  it('its own model, its own prompt with the thread, the cost of its trace on the run; agents reloaded each turn', async () => {
    const fx = turnsFixture({ script: (call) => (call.agentId === 'coworker-cw-mkt' ? 'Story first. @gtm what price?' : '$12 per seat. @marketing') })
    await fx.handle.reload()
    // Each run's cost, as the gateway's cost log reports it for the run's trace.
    const cost = { 'cw-mkt': 0.0031, 'cw-gtm': 0.0007 }
    const original = fx.runs.update.bind(fx.runs)
    fx.runs.update = async (id, patch) => {
      const row = fx.runs.rows.find((r) => r.id === id)!
      if (patch.status === 'running') fx.costs.set(id, cost[row.coworkerUserId as keyof typeof cost])
      return original(id, patch)
    }
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    await postMessage(fx.deps, 'bea', launch.id, '@marketing plan the launch')
    await fx.settle()
    // Marketing pulls in GTM, GTM answers Marketing, Marketing pulls in GTM … until the budget.
    const [mkt, gtm] = fx.calls
    expect(mkt!.modelId).toBe('google/gemini-3.8-flash')
    expect(gtm!.modelId).toBe('google/gemini-3.8-flash')
    expect(mkt!.system).toContain('You are Marketing (@marketing)')
    expect(gtm!.system).toContain('You are GTM (@gtm)')
    expect(gtm!.system).toContain('Marketing (@marketing, AI co-worker):\nStory first. @gtm what price?')
    expect(gtm!.system).toContain('Name: Kindred Labs')
    expect(gtm!.input).toBe('Marketing (@marketing, AI co-worker):\nStory first. @gtm what price?')
    const byCoworker = Object.fromEntries(fx.runs.rows.filter((r) => r.status === 'done').map((r) => [r.coworkerUserId, r.costUsd]))
    expect(byCoworker).toMatchObject(cost)
    expect(fx.loads()).toBeGreaterThanOrEqual(1 + fx.calls.length)
  })

  it('stopNote: every reason names the accountable human', () => {
    for (const reason of ['thread_budget', 'daily_cap', 'model_error', 'post_error', 'turn_error', 'interrupted'] as const) {
      expect(stopNote({ reason, humanHandle: 'olga', budget: 8, dailyCapUsd: 2.5, detail: 'x' })).toContain('@olga')
    }
    const multi = stopNote({ reason: 'daily_cap', humanHandle: 'olga', humanHandles: ['olga', 'bea'], budget: 8, dailyCapUsd: 2.5 })
    expect(multi).toContain('@olga @bea')
  })

  it('mentions all accountable humans in stop notes when a coworker reports to multiple humans', async () => {
    const fx = turnsFixture({
      script: () => {
        throw new Error('upstream 503')
      },
    })
    const mkt = fx.coworkers.get('cw-mkt')!
    mkt.reportsToUserId = 'owner'
    mkt.reportsToUserIds = ['owner', 'bea']
    mkt.accountableHumans = [
      { id: 'owner', name: 'Olga Owner', reason: 'chain' },
      { id: 'bea', name: 'Bea Member', reason: 'chain' },
    ]
    await fx.handle.reload()
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(fx.deps, 'carl', general.id, '@marketing check this')
    await fx.settle()
    const note = (await fx.thread(message.id)).at(-1)!
    expect(note.body).toContain('@olga')
    expect(note.body).toContain('@bea')
  })
})

describe('"is typing…" while a turn runs (Contribute 14aea69d)', () => {
  it('the co-worker shows as writing in the thread while its model answers, and not once the reply is posted', async () => {
    let seen: unknown = null
    const fx = turnsFixture({
      script: () => {
        seen = fx.typing.list()
        return 'on it'
      },
    })
    await fx.handle.reload()
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    const { message: root } = await postMessage(fx.deps, 'bea', launch.id, '@marketing draft the post')
    await fx.settle()
    expect(seen).toEqual([{ conversationId: launch.id, typists: [{ userId: 'cw-mkt', threadRootId: root.id }] }])
    expect(fx.typing.list()).toEqual([])
    expect((await fx.thread(root.id)).at(-1)).toEqual({ authorId: 'cw-mkt', body: 'on it' })
  })

  it('a failed model call ends the typing too', async () => {
    const fx = turnsFixture({
      script: () => {
        throw new Error('provider down')
      },
    })
    await fx.handle.reload()
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    await postMessage(fx.deps, 'bea', launch.id, '@marketing draft the post')
    await fx.settle()
    expect(fx.runs.rows[0]).toMatchObject({ status: 'failed', stopReason: 'model_error' })
    expect(fx.typing.list()).toEqual([])
    expect(fx.typing.busy('cw-mkt')).toBe(false)
  })
})
