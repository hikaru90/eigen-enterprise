import type { Conversation, Person } from '../../../../modules/messages/store'
import type { CoworkerView } from './service'
import type { HeardMessage } from './turns'
import { describe, expect, it, vi } from 'vitest'
import { decide, type DecideDeps } from '$lib/server/decisions/decide'
import { defineDecisionKind } from '$lib/server/decisions/kind'
import { inMemoryDecisionStore } from '$lib/server/decisions/store'
import type { LlmDecideResult } from '$lib/server/llm/llm-decide'
import { COWORKER_EVENT_MINE_DEF, coworkerEventMine } from '../../../../modules/coworkers/decision-kinds'
import {
  ChannelMessageSource,
  channelMessageEvent,
  CoworkerEventObserver,
  EVENT_DECISIONS_PER_HOUR,
  eventRunKey,
  MemoryEventStores,
  type ChannelMessageEvent,
  type CoworkerEventMineInput,
  type EventDecide,
} from './events'
import { MemoryCoworkerRunStore } from './run-store'
import { coworkerEmail } from './service'

/**
 * C7 · event reactions (plan/phase-ai-coworkers.md §8): which messages are a co-worker's
 * events (structure), the subscription, one Jev decision per co-worker and event, the cap and
 * the hourly limit counted and visible, and acting only behind the kind's status.
 */

const people: Person[] = [
  { id: 'bea', name: 'Bea Member', email: 'bea@co.test', kind: 'human' },
  { id: 'cw-mkt', name: 'Marketing', email: coworkerEmail('marketing', 'cw-mkt'), kind: 'coworker' },
  { id: 'cw-gtm', name: 'GTM', email: coworkerEmail('gtm', 'cw-gtm'), kind: 'coworker' },
]
const channel: Conversation = {
  id: 'c-launch',
  kind: 'channel',
  name: 'launch',
  topic: '',
  private: false,
  archived: false,
  dmKey: null,
  createdBy: 'bea',
  createdAt: new Date('2026-11-23T08:00:00Z'),
}
const heard = (over: Partial<HeardMessage> = {}): HeardMessage => ({
  id: 'm1',
  conversationId: channel.id,
  authorId: 'bea',
  body: 'We need the launch post drafted by Friday.',
  parentId: null,
  deleted: false,
  call: null,
  createdAt: '2026-11-23T09:00:00.000Z',
  ...over,
})
const eventFor = (coworkerId: string, message: HeardMessage, over: Partial<Parameters<typeof channelMessageEvent>[0]> = {}) =>
  channelMessageEvent({ coworkerId, message, conversation: channel, people, isMember: true, canRead: true, ...over })

const view = (over: Partial<CoworkerView> = {}): CoworkerView => ({
  id: 'cw-mkt',
  name: 'Marketing',
  email: coworkerEmail('marketing', 'cw-mkt'),
  slug: 'marketing',
  title: 'Marketing Manager',
  accountabilities: ['Launch communication', 'The blog'],
  lens: 'Is it on-brand and on time?',
  modelId: 'anthropic/claude-sonnet-5.5',
  enabled: true,
  dailyCapUsd: 2,
  templateId: null,
  reportsToUserId: 'bea',
  accountableHuman: { id: 'bea', name: 'Bea Member', reason: 'chain' },
  agentId: 'coworker-cw-mkt',
  createdBy: 'bea',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  removedAt: null,
  ...over,
})

function jevSays(choice: 'yes' | 'no', confidence = 0.9): DecideDeps['ask'] {
  return vi.fn(
    async (): Promise<LlmDecideResult> => ({
      model: 'typesafe/jev-1.13-20260917',
      answers: { decision: { choice, confidence, distribution: { yes: choice === 'yes' ? confidence : 1 - confidence, no: choice === 'no' ? confidence : 1 - confidence } } },
      costUsd: 0.000017,
      durationMs: 120,
    }),
  )
}

function setup(opts: { ask?: DecideDeps['ask']; enforced?: boolean; spent?: number; hourlyLimit?: number; coworker?: Partial<CoworkerView> } = {}) {
  const stores = new MemoryEventStores()
  const decisions = inMemoryDecisionStore()
  const runs = new MemoryCoworkerRunStore()
  const ask = opts.ask ?? jevSays('yes')
  const started: string[] = []
  const kind = opts.enforced ? defineDecisionKind({ ...COWORKER_EVENT_MINE_DEF, status: 'enforced' }) : coworkerEventMine
  let clock = new Date('2026-11-23T09:00:00Z')
  const decideFn: EventDecide = (k, input, o) => decide(k, input, o, { ask, store: decisions })
  const make = () =>
    new CoworkerEventObserver({
      kind,
      subscriptions: stores,
      observations: stores,
      coworkers: { get: async () => view(opts.coworker) },
      spentToday: async () => opts.spent ?? 0,
      decide: decideFn,
      queueRun: async (run) => {
        const row = await runs.enqueue(run)
        if (row) started.push(row.id)
        return row
      },
      now: () => clock,
      ...(opts.hourlyLimit === undefined ? {} : { hourlyLimit: opts.hourlyLimit }),
    })
  return {
    stores,
    decisions,
    runs,
    ask,
    started,
    observer: make(),
    /** A second app process: its own observer over the same stores. */
    otherProcess: make(),
    tick: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    subscribe: () => stores.set('cw-mkt', ['channel_message'], 'bea', clock),
  }
}

const ev = (id: string, body = 'We need the launch post drafted by Friday.') => eventFor('cw-mkt', heard({ id, body }))!

describe('channelMessageEvent (pure): which new messages are a co-worker’s events', () => {
  it('a person’s message in a channel the co-worker is a member of and may read, not @mentioning it', () => {
    const e = eventFor('cw-mkt', heard())
    expect(e).toMatchObject({ kind: 'channel_message', id: 'm1', conversationId: 'c-launch', channelName: 'launch', threadRootId: 'm1', isReply: false, authorId: 'bea', authorName: 'Bea Member' })
    expect(eventFor('cw-mkt', heard({ id: 'r1', parentId: 'm1' }))).toMatchObject({ threadRootId: 'm1', isReply: true })
  })

  it('not when it @mentions the co-worker (that is a C3 turn), but yes when it mentions another', () => {
    expect(eventFor('cw-mkt', heard({ body: '@marketing draft the launch post' }))).toBeNull()
    expect(eventFor('cw-mkt', heard({ body: '@gtm what is the price?' }))).not.toBeNull()
  })

  it('not by an AI co-worker, not its own, not a former member’s', () => {
    expect(eventFor('cw-mkt', heard({ authorId: 'cw-gtm' }))).toBeNull()
    expect(eventFor('cw-mkt', heard({ authorId: 'cw-mkt' }))).toBeNull()
    expect(eventFor('cw-mkt', heard({ authorId: 'gone' }))).toBeNull()
  })

  it('not outside its membership or read access, not in a DM or an archived channel', () => {
    expect(eventFor('cw-mkt', heard(), { isMember: false })).toBeNull()
    expect(eventFor('cw-mkt', heard(), { canRead: false })).toBeNull()
    expect(eventFor('cw-mkt', heard(), { conversation: { ...channel, kind: 'dm', name: null } })).toBeNull()
    expect(eventFor('cw-mkt', heard(), { conversation: { ...channel, archived: true } })).toBeNull()
  })

  it('not a deleted message or a call line', () => {
    expect(eventFor('cw-mkt', heard({ deleted: true }))).toBeNull()
    expect(eventFor('cw-mkt', heard({ call: { outcome: 'ended', durationSeconds: 60 } as HeardMessage['call'] }))).toBeNull()
  })
})

describe('coworkers.event_mine (the kind)', () => {
  const input = (e: ChannelMessageEvent): CoworkerEventMineInput => ({
    coworker: { id: 'cw-mkt', name: 'Marketing', title: 'Marketing Manager', accountabilities: ['Launch communication'], lens: 'On brand?', accountableHumanId: 'bea' },
    event: e,
  })

  it('Jev reads the role card and the event', () => {
    const state = coworkerEventMine.state(input(ev('m1')))
    expect(state).toContain('Title: Marketing Manager')
    expect(state).toContain('- Launch communication')
    expect(state).toContain('Lens: On brand?')
    expect(state).toContain('#launch')
    expect(state).toContain('We need the launch post drafted by Friday.')
  })

  it('the log keeps metadata and a short excerpt for a public channel, and no text at all for a private one', () => {
    const pub = coworkerEventMine.logInput(input(ev('m1', 'x'.repeat(500))))
    expect(pub).toMatchObject({ coworkerUserId: 'cw-mkt', eventKind: 'channel_message', eventId: 'm1', conversationId: 'c-launch', channel: 'launch', privateChannel: false, bodyChars: 500 })
    expect((pub.excerpt as string).length).toBeLessThanOrEqual(201)
    const priv = coworkerEventMine.logInput(input({ ...ev('m2', 'secret salary numbers'), privateChannel: true }))
    expect(priv).not.toHaveProperty('excerpt')
    expect(JSON.stringify(priv)).not.toContain('salary')
  })
})

describe('CoworkerEventObserver', () => {
  it('a co-worker not switched on for the kind: no decision, no row', async () => {
    const s = setup()
    expect(await s.observer.observe('cw-mkt', ev('m1'))).toEqual({ outcome: 'not_subscribed' })
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.decisions.rows()).toHaveLength(0)
    expect(s.stores.observations).toHaveLength(0)
  })

  it('a switched-off co-worker decides nothing', async () => {
    const s = setup({ coworker: { enabled: false } })
    await s.subscribe()
    expect(await s.observer.observe('cw-mkt', ev('m1'))).toEqual({ outcome: 'unavailable' })
    expect(s.ask).not.toHaveBeenCalled()
  })

  it('shadow: Jev’s "yes" is logged as observed — no run is queued', async () => {
    const s = setup({ ask: jevSays('yes', 0.82) })
    await s.subscribe()
    const out = await s.observer.observe('cw-mkt', ev('m1'))
    expect(out).toMatchObject({ outcome: 'observed', runId: null })
    const [row] = s.decisions.rows()
    expect(row).toMatchObject({ kind: 'coworkers.event_mine', status: 'shadow', outcome: 'observed', jevChoice: 'yes', jevConfidence: 0.82, requestedBy: 'cw-mkt', subjectUserId: 'cw-mkt', usedChoice: null })
    expect(row!.input).toMatchObject({ eventId: 'm1', excerpt: 'We need the launch post drafted by Friday.' })
    expect(s.stores.observations[0]).toMatchObject({ outcome: 'observed', decisionId: row!.id })
    expect(s.runs.rows).toHaveLength(0)
    expect(s.started).toHaveLength(0)
  })

  it('one decision per co-worker per event, across two processes and redeliveries', async () => {
    const s = setup()
    await s.subscribe()
    const [a, b] = await Promise.all([s.observer.observe('cw-mkt', ev('m1')), s.otherProcess.observe('cw-mkt', ev('m1'))])
    expect([a.outcome, b.outcome].sort()).toEqual(['duplicate', 'observed'])
    expect(await s.observer.observe('cw-mkt', ev('m1'))).toEqual({ outcome: 'duplicate' })
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.decisions.rows()).toHaveLength(1)
  })

  it('past the hourly limit an event is skipped with a counted reason, and the next hour decides again', async () => {
    expect(EVENT_DECISIONS_PER_HOUR).toBe(20)
    const s = setup({ hourlyLimit: 2 })
    await s.subscribe()
    await s.observer.observe('cw-mkt', ev('m1'))
    await s.observer.observe('cw-mkt', ev('m2'))
    expect(await s.observer.observe('cw-mkt', ev('m3'))).toMatchObject({ outcome: 'skipped_rate_limit', decisionId: null })
    expect(s.ask).toHaveBeenCalledTimes(2)
    expect(s.stores.observations.find((r) => r.eventId === 'm3')).toMatchObject({ outcome: 'skipped_rate_limit', error: 'over 2 event decisions in the last hour' })
    expect(await s.stores.counts('cw-mkt', new Date(0))).toMatchObject({ observed: 2, skipped_rate_limit: 1 })
    s.tick(3_600_001)
    expect(await s.observer.observe('cw-mkt', ev('m4'))).toMatchObject({ outcome: 'observed' })
  })

  it('a spent daily cap: no decision, counted skipped_daily_cap, logged loud, never retried', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = setup({ spent: 2.5 })
    await s.subscribe()
    expect(await s.observer.observe('cw-mkt', ev('m1'))).toMatchObject({ outcome: 'skipped_daily_cap', decisionId: null })
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.decisions.rows()).toHaveLength(0)
    expect(s.stores.observations[0]).toMatchObject({ outcome: 'skipped_daily_cap', error: 'the daily AI budget is spent (2.5 >= 2 USD today, UTC)' })
    expect(error).toHaveBeenCalled()
    expect(await s.observer.observe('cw-mkt', ev('m1'))).toEqual({ outcome: 'duplicate' })
    error.mockRestore()
  })

  it('a Jev failure in shadow is logged in the decision log and counted failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = setup({ ask: vi.fn(async () => { throw new Error('gateway down') }) })
    await s.subscribe()
    expect(await s.observer.observe('cw-mkt', ev('m1'))).toMatchObject({ outcome: 'failed' })
    expect(s.decisions.rows()[0]).toMatchObject({ outcome: 'observed', jevError: 'Error: gateway down' })
    expect(s.runs.rows).toHaveLength(0)
    error.mockRestore()
  })

  it('enforced (the promotion): a "yes" queues exactly one event run in the event’s thread', async () => {
    const s = setup({ enforced: true, ask: jevSays('yes') })
    await s.subscribe()
    const out = await s.observer.observe('cw-mkt', ev('m1'))
    expect(out).toMatchObject({ outcome: 'queued' })
    expect(s.runs.rows).toHaveLength(1)
    expect(s.runs.rows[0]).toMatchObject({
      coworkerUserId: 'cw-mkt',
      triggerKind: 'event',
      conversationId: 'c-launch',
      threadRootId: 'm1',
      triggerMessageId: 'm1',
      requestedByUserId: 'bea',
      triggerKey: eventRunKey({ kind: 'channel_message', id: 'm1' }),
      status: 'queued',
    })
    expect(s.started).toEqual([s.runs.rows[0]!.id])
    expect(s.decisions.rows()[0]).toMatchObject({ status: 'enforced', outcome: 'decided', usedChoice: 'yes', usedSource: 'jev' })
  })

  it('enforced: a "no" queues nothing', async () => {
    const s = setup({ enforced: true, ask: jevSays('no') })
    await s.subscribe()
    expect(await s.observer.observe('cw-mkt', ev('m1'))).toMatchObject({ outcome: 'observed' })
    expect(s.runs.rows).toHaveLength(0)
  })
})

describe('ChannelMessageSource', () => {
  const source = (observer: CoworkerEventObserver, over: { member?: boolean; canRead?: boolean } = {}) =>
    new ChannelMessageSource(
      {
        getConversation: async (id) => (id === channel.id ? channel : null),
        listPeople: async () => people,
        access: async () => ({ read: over.canRead ?? true, member: over.member ?? true }),
      },
      observer,
    )

  it('a heard message becomes one decision when the co-worker is switched on and it is its event', async () => {
    const s = setup()
    await s.subscribe()
    const src = source(s.observer)
    expect(await src.onMessage('cw-mkt', heard())).toMatchObject({ outcome: 'observed' })
    expect(await src.onMessage('cw-mkt', heard({ id: 'm2', body: '@marketing do it' }))).toBeNull()
    expect(await source(s.observer, { member: false }).onMessage('cw-mkt', heard({ id: 'm3' }))).toBeNull()
    expect(await source(s.observer, { canRead: false }).onMessage('cw-mkt', heard({ id: 'm4' }))).toBeNull()
    expect(s.decisions.rows()).toHaveLength(1)
  })

  it('not switched on: the message is not even looked at', async () => {
    const s = setup()
    const getConversation = vi.fn(async () => channel)
    const src = new ChannelMessageSource({ getConversation, listPeople: async () => people, access: async () => ({ read: true, member: true }) }, s.observer)
    expect(await src.onMessage('cw-mkt', heard())).toBeNull()
    expect(getConversation).not.toHaveBeenCalled()
    expect(s.ask).not.toHaveBeenCalled()
  })
})
