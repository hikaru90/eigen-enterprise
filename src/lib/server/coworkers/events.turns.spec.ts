import { describe, expect, it, vi } from 'vitest'
import { decide, type DecideDeps } from '$lib/server/decisions/decide'
import { defineDecisionKind } from '$lib/server/decisions/kind'
import { inMemoryDecisionStore } from '$lib/server/decisions/store'
import type { LlmDecideResult } from '$lib/server/llm/llm-decide'
import { COWORKER_EVENT_MINE_DEF, coworkerEventMine } from '../../../../modules/coworkers/decision-kinds'
import { createChannel, postMessage } from '../../../../modules/messages/service'
import { MemoryEventStores, type CoworkerEventObserverDeps } from './events'
import { turnsFixture, type Script } from './test-fixtures'

/**
 * C7 end to end over in-memory Messages and the co-worker turns: a person's message in a
 * channel Marketing is a member of, not mentioning it, is heard on the messages hub and
 * becomes one coworkers.event_mine decision. In shadow (as shipped) nothing else happens.
 * With the kind enforced (the promotion), Jev's "yes" queues one 'event' run that answers
 * in the message's thread as the co-worker.
 */

const jev = (choice: 'yes' | 'no'): DecideDeps['ask'] =>
  vi.fn(
    async (): Promise<LlmDecideResult> => ({
      model: 'typesafe/jev-1.13-20260917',
      answers: { decision: { choice, confidence: 0.9, distribution: { yes: choice === 'yes' ? 0.9 : 0.1, no: choice === 'no' ? 0.9 : 0.1 } } },
      costUsd: 0.000017,
      durationMs: 50,
    }),
  )

function setup(opts: { enforced?: boolean; choice?: 'yes' | 'no'; script?: Script }) {
  const stores = new MemoryEventStores()
  const decisions = inMemoryDecisionStore()
  const ask = jev(opts.choice ?? 'yes')
  const kind = opts.enforced ? defineDecisionKind({ ...COWORKER_EVENT_MINE_DEF, status: 'enforced' }) : coworkerEventMine
  const events: Omit<CoworkerEventObserverDeps, 'queueRun'> = {
    kind,
    subscriptions: stores,
    observations: stores,
    coworkers: { get: async (id) => fx.coworkers.get(id)! },
    spentToday: async () => 0,
    decide: (k, input, o) => decide(k, input, o, { ask, store: decisions }),
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
      expect.objectContaining({ kind: 'coworkers.event_mine', status: 'shadow', outcome: 'observed', jevChoice: 'yes', subjectUserId: 'cw-mkt', requestedBy: 'cw-mkt' }),
    ])
    expect(decisions.rows()[0]!.input).toMatchObject({ eventId: message.id, conversationId: launch.id, channel: 'launch' })
    // GTM is a member too (a public channel) but not switched on: it decides nothing.
    expect(decisions.rows().filter((r) => r.subjectUserId === 'cw-gtm')).toHaveLength(0)
    expect(fx.runs.rows).toEqual([])
    expect(fx.calls).toEqual([])
    expect((await fx.thread(message.id)).map((m) => m.authorId)).toEqual(['bea'])
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
