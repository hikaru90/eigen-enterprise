import { describe, expect, it, vi } from 'vitest'
import { decideMany, type DecideDeps } from '$lib/server/decisions/decide'
import { defineDecisionKind } from '$lib/server/decisions/kind'
import { inMemoryDecisionStore } from '$lib/server/decisions/store'
import type { LlmDecideResult } from '$lib/server/llm/llm-decide'
import { COWORKER_EVENT_MINE_DEF, coworkerEventMine } from '../../../../modules/coworkers/decision-kinds'
import { createChannel, postMessage } from '../../../../modules/messages/service'
import { MemoryEventStores, type CoworkerEventRouterDeps } from './events'
import { turnsFixture, type Script } from './test-fixtures'

/**
 * C7 end to end over in-memory Messages and the co-worker turns: a person's message in a
 * channel Marketing is a member of, not mentioning it, is heard on the messages hub (one frame
 * per co-worker) and is routed once: one Jev call, one coworkers.event_mine decision per
 * co-worker switched on, billed to the author. In shadow (as shipped) nothing else happens.
 * With the kind enforced (the promotion), Jev's "yes" queues one 'event' run that answers
 * in the message's thread as the co-worker.
 */

/** Every question of the call gets the same answer. */
const jev = (choice: 'yes' | 'no'): DecideDeps['ask'] =>
  vi.fn(
    async (input: { questions: Record<string, unknown> }): Promise<LlmDecideResult> => ({
      model: 'typesafe/jev-1.13-20260917',
      answers: Object.fromEntries(
        Object.keys(input.questions).map((id) => [id, { choice, confidence: 0.9, distribution: { yes: choice === 'yes' ? 0.9 : 0.1, no: choice === 'no' ? 0.9 : 0.1 } }]),
      ),
      costUsd: 0.000017,
      durationMs: 50,
    }),
  ) as unknown as DecideDeps['ask']

function setup(opts: { enforced?: boolean; choice?: 'yes' | 'no'; script?: Script }) {
  const stores = new MemoryEventStores()
  const decisions = inMemoryDecisionStore()
  const ask = jev(opts.choice ?? 'yes')
  const kind = opts.enforced ? defineDecisionKind({ ...COWORKER_EVENT_MINE_DEF, status: 'enforced' }) : coworkerEventMine
  const events: Omit<CoworkerEventRouterDeps, 'queueRun'> = {
    kind,
    subscriptions: stores,
    observations: stores,
    coworkers: { listEnabled: async () => [...fx.coworkers.values()].filter((c) => c.enabled && !c.removedAt) },
    spentToday: async () => 0,
    authorCapRefusal: async () => null,
    decideMany: (k, items, o) => decideMany(k, items, o, { ask, store: decisions }),
  }
  // Read lazily, once the fixture exists.
  const fx = turnsFixture({ script: opts.script ?? (() => 'I will draft the launch post by Thursday.'), extra: { events } })
  const settle = async () => {
    await fx.settle()
    await fx.handle.events!.idle()
    await fx.settle()
  }
  return { fx, stores, decisions, ask, settle }
}

describe('event reactions through the messages hub (C7)', () => {
  it('shadow (as shipped): an unmentioned message is one logged decision, and nothing is acted on', async () => {
    const { fx, stores, decisions, ask, settle } = setup({})
    await fx.handle.reload()
    await stores.set('cw-mkt', ['channel_message'], 'owner', new Date())
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    const { message } = await postMessage(fx.deps, 'bea', launch.id, 'We need the launch post drafted by Friday.')
    await settle()

    expect(ask).toHaveBeenCalledTimes(1)
    expect(decisions.rows()).toEqual([
      expect.objectContaining({ kind: 'coworkers.event_mine', status: 'shadow', outcome: 'observed', jevChoice: 'yes', subjectUserId: 'cw-mkt', requestedBy: 'bea' }),
    ])
    expect(decisions.rows()[0]!.input).toMatchObject({ eventId: message.id, conversationId: launch.id, channel: 'launch' })
    // GTM is a member too (a public channel) but not switched on: it decides nothing.
    expect(decisions.rows().filter((r) => r.subjectUserId === 'cw-gtm')).toHaveLength(0)
    expect(fx.runs.rows).toEqual([])
    expect(fx.calls).toEqual([])
    expect((await fx.thread(message.id)).map((m) => m.authorId)).toEqual(['bea'])
  })

  it('two co-workers switched on: every frame of the message routes it once — one call, one row each', async () => {
    const { fx, stores, decisions, ask, settle } = setup({})
    await fx.handle.reload()
    await stores.set('cw-mkt', ['channel_message'], 'owner', new Date())
    await stores.set('cw-gtm', ['channel_message'], 'owner', new Date())
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    const { message } = await postMessage(fx.deps, 'bea', launch.id, 'What should the launch price be?')
    await settle()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(Object.keys((ask as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].questions)).toHaveLength(2)
    expect(decisions.rows().map((r) => r.subjectUserId).sort()).toEqual(['cw-gtm', 'cw-mkt'])
    expect(stores.routes).toEqual([expect.objectContaining({ eventId: message.id, outcome: 'decided', candidates: 2, questions: 2, authorUserId: 'bea' })])
    expect(fx.runs.rows).toEqual([])
  })

  it('a mention is a C3 turn, never an event; a co-worker’s message is never an event', async () => {
    const { fx, stores, decisions, settle } = setup({})
    await fx.handle.reload()
    await stores.set('cw-mkt', ['channel_message'], 'owner', new Date())
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    await postMessage(fx.deps, 'bea', launch.id, '@marketing draft the post')
    await postMessage(fx.deps, 'cw-gtm', launch.id, 'pricing is $12 per seat')
    await settle()
    expect(decisions.rows()).toEqual([])
    expect(fx.runs.rows.map((r) => r.triggerKind)).toEqual(['mention'])
  })

  it('a private channel the co-worker was not invited to is not its event', async () => {
    const { fx, stores, decisions, settle } = setup({})
    await fx.handle.reload()
    await stores.set('cw-mkt', ['channel_message'], 'owner', new Date())
    const lead = await createChannel(fx.deps, 'owner', { name: 'leadership', private: true, userIds: ['bea'] })
    const cw = await createChannel(fx.deps, 'owner', { name: 'campaigns', private: true, userIds: ['bea', 'cw-mkt'] })
    await postMessage(fx.deps, 'bea', lead.id, 'Salary bands for next year.')
    const { message } = await postMessage(fx.deps, 'bea', cw.id, 'The Q1 campaign brief is due.')
    await settle()
    expect(decisions.rows().map((r) => r.input.eventId)).toEqual([message.id])
    // A private channel's text is not kept in the log.
    expect(decisions.rows()[0]!.input).toMatchObject({ privateChannel: true })
    expect(decisions.rows()[0]!.input).not.toHaveProperty('excerpt')
  })

  it('switched off: the message is heard and no decision is made', async () => {
    const { fx, decisions, ask, settle } = setup({})
    await fx.handle.reload()
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    await postMessage(fx.deps, 'bea', launch.id, 'We need the launch post drafted by Friday.')
    await settle()
    expect(ask).not.toHaveBeenCalled()
    expect(decisions.rows()).toEqual([])
  })

  it('enforced (the promotion): Jev’s "yes" queues one event run that answers in the thread as the co-worker', async () => {
    const { fx, stores, settle } = setup({ enforced: true, choice: 'yes' })
    await fx.handle.reload()
    await stores.set('cw-mkt', ['channel_message'], 'owner', new Date())
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    const { message } = await postMessage(fx.deps, 'bea', launch.id, 'We need the launch post drafted by Friday.')
    await settle()

    expect(fx.runs.rows).toEqual([
      expect.objectContaining({ coworkerUserId: 'cw-mkt', triggerKind: 'event', triggerKey: `event:channel_message:${message.id}`, threadRootId: message.id, status: 'done' }),
    ])
    expect(fx.calls).toHaveLength(1)
    expect(fx.calls[0]!.sessionId).toBe(`coworker:cw-mkt:run:${fx.runs.rows[0]!.id}`)
    expect(fx.calls[0]!.system).toContain('Nobody @mentioned you; you noticed it because it looks like yours to act on:\nWe need the launch post drafted by Friday.')
    expect(fx.calls[0]!.system).toContain('posted for you as a reply in this thread')
    expect(await fx.thread(message.id)).toEqual([
      { authorId: 'bea', body: 'We need the launch post drafted by Friday.' },
      { authorId: 'cw-mkt', body: 'I will draft the launch post by Thursday.' },
    ])
    // Its reply is not an event for itself; the run reached the accountable human's Needs you.
    expect(fx.runs.rows).toHaveLength(1)
    expect(fx.runs.notices.map((n) => n.userId)).toEqual(['owner'])
  })

  it('enforced: a "no" queues nothing', async () => {
    const { fx, stores, settle } = setup({ enforced: true, choice: 'no' })
    await fx.handle.reload()
    await stores.set('cw-mkt', ['channel_message'], 'owner', new Date())
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    await postMessage(fx.deps, 'bea', launch.id, 'Thanks all, great week!')
    await settle()
    expect(fx.runs.rows).toEqual([])
    expect(fx.calls).toEqual([])
  })
})
