import type { Conversation, Person } from '../../../../modules/messages/store'
import type { CoworkerView } from './service'
import type { HeardMessage } from './turns'
import { describe, expect, it, vi } from 'vitest'
import { decideMany, type DecideDeps } from '$lib/server/decisions/decide'
import { defineDecisionKind } from '$lib/server/decisions/kind'
import { inMemoryDecisionStore } from '$lib/server/decisions/store'
import type { LlmDecideResult } from '$lib/server/llm/llm-decide'
import { COWORKER_EVENT_MINE_DEF, coworkerEventMine } from '../../../../modules/coworkers/decision-kinds'
import {
  ChannelMessageSource,
  channelMessageEvent,
  CoworkerEventRouter,
  eventRunKey,
  MemoryEventStores,
  type ChannelMessageEvent,
  type CoworkerEventMineInput,
  type EventDecideMany,
} from './events'
import { MemoryCoworkerRunStore } from './run-store'
import { coworkerEmail } from './service'

/**
 * C7 · event reactions, routed once (plan/phase-ai-coworkers.md §8, owner 2026-11-24): which
 * messages are a co-worker's events (structure), the subscription, ONE Jev call per message for
 * every co-worker it could be for (billed to the author), one decision row and one counted
 * outcome per co-worker, the caps counted and visible, and acting only behind the kind's status.
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
  image: null,
  title: 'Marketing Manager',
  accountabilities: ['Launch communication', 'The blog'],
  lens: 'Is it on-brand and on time?',
  modelId: 'google/gemini-3.8-flash',
  enabled: true,
  dailyCapUsd: 2,
  templateId: null,
  reportsToUserId: 'bea',
  reportsToUserIds: ['bea'],
  accountableHuman: { id: 'bea', name: 'Bea Member', reason: 'chain' },
  accountableHumans: [{ id: 'bea', name: 'Bea Member', reason: 'chain' }],
  agentId: 'coworker-cw-mkt',
  createdBy: 'bea',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  removedAt: null,
  ...over,
})

const mkt = view()
const gtm = view({ id: 'cw-gtm', name: 'GTM', email: coworkerEmail('gtm', 'cw-gtm'), slug: 'gtm', title: 'GTM Lead', accountabilities: ['Pricing'], lens: 'Does it sell?', agentId: 'coworker-cw-gtm' })

/** Jev answers the call's questions q0, q1, … in order (the default: every question "yes"). */
function jevSays(...answers: Array<['yes' | 'no', number]>): DecideDeps['ask'] {
  return vi.fn(
    async (input: { questions: Record<string, unknown> }): Promise<LlmDecideResult> => ({
      model: 'typesafe/jev-1.13-20260917',
      answers: Object.fromEntries(
        Object.keys(input.questions).map((id, n) => {
          const [choice, confidence] = answers[n] ?? answers[0] ?? ['yes', 0.9]
          return [id, { choice, confidence, distribution: { yes: choice === 'yes' ? confidence : 1 - confidence, no: choice === 'no' ? confidence : 1 - confidence } }]
        }),
      ),
      costUsd: 0.000017,
      durationMs: 120,
    }),
  ) as unknown as DecideDeps['ask']
}

function setup(
  opts: {
    ask?: DecideDeps['ask']
    enforced?: boolean
    spent?: Record<string, number>
    spentFails?: boolean
    authorRefusal?: string
    views?: Record<string, Partial<CoworkerView>>
  } = {},
) {
  const stores = new MemoryEventStores()
  const decisions = inMemoryDecisionStore()
  const runs = new MemoryCoworkerRunStore()
  const ask = opts.ask ?? jevSays()
  const started: string[] = []
  const kind = opts.enforced ? defineDecisionKind({ ...COWORKER_EVENT_MINE_DEF, status: 'enforced' }) : coworkerEventMine
  const clock = new Date('2026-11-23T09:00:00Z')
  const decideFn: EventDecideMany = (k, items, o) => decideMany(k, items, o, { ask, store: decisions })
  const make = () =>
    new CoworkerEventRouter({
      kind,
      subscriptions: stores,
      observations: stores,
      coworkers: { listEnabled: async () => [mkt, gtm].map((v) => ({ ...v, ...opts.views?.[v.id] })) },
      spentToday: async (id) => {
        if (opts.spentFails) throw new Error('ledger down')
        return opts.spent?.[id] ?? 0
      },
      authorCapRefusal: async () => opts.authorRefusal ?? null,
      decideMany: decideFn,
      queueRun: async (run) => {
        const row = await runs.enqueue(run)
        if (row) started.push(row.id)
        return row
      },
      now: () => clock,
    })
  return {
    stores,
    decisions,
    runs,
    ask,
    started,
    router: make(),
    /** A second app process: its own router over the same stores. */
    otherProcess: make(),
    subscribe: async (...ids: string[]) => {
      for (const id of ids) await stores.set(id, ['channel_message'], 'bea', clock)
    },
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

  it('routed (batch): the event is the one shared state, the role card each co-worker’s question', () => {
    const batch = coworkerEventMine.batch!
    const state = batch.state(input(ev('m1')))
    expect(state).toContain('#launch')
    expect(state).toContain('We need the launch post drafted by Friday.')
    expect(state).not.toContain('Marketing Manager')
    expect(batch.state({ ...input(ev('m1')), coworker: { ...input(ev('m1')).coworker, id: 'cw-gtm', title: 'GTM Lead' } })).toBe(state)
    const question = batch.question(input(ev('m1')))
    expect(question).toContain('Title: Marketing Manager')
    expect(question).toContain('- Launch communication')
    expect(question).not.toContain('Friday')
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

describe('CoworkerEventRouter: the assistant routes each event once', () => {
  it('nobody switched on: nothing listens, nothing is asked', async () => {
    const s = setup()
    expect(await s.router.listening('channel_message')).toEqual([])
    expect(s.ask).not.toHaveBeenCalled()
  })

  it('listening: only the enabled co-workers switched on for the kind', async () => {
    const s = setup({ views: { 'cw-gtm': { enabled: false } } })
    await s.subscribe('cw-mkt', 'cw-gtm')
    expect((await s.router.listening('channel_message')).map((v) => v.id)).toEqual(['cw-mkt'])
  })

  it('shadow: ONE Jev call for every candidate, billed to the author; one observed decision row per co-worker; nothing queued', async () => {
    const s = setup({ ask: jevSays(['yes', 0.82], ['no', 0.7]) })
    await s.subscribe('cw-mkt', 'cw-gtm')
    const out = await s.router.route(ev('m1'), [mkt, gtm])
    expect(out).toMatchObject({ outcome: 'decided', coworkers: { 'cw-mkt': { outcome: 'observed', runId: null }, 'cw-gtm': { outcome: 'observed', runId: null } } })
    expect(s.ask).toHaveBeenCalledTimes(1)
    const call = (s.ask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { userId: string; state: string; questions: Record<string, { instructions: string }> }
    expect(call.userId).toBe('bea')
    expect(call.state).toContain('We need the launch post drafted by Friday.')
    expect(call.state).not.toContain('Marketing Manager')
    expect(Object.keys(call.questions)).toEqual(['q0', 'q1'])
    expect(call.questions.q0!.instructions).toContain('Title: Marketing Manager')
    expect(call.questions.q1!.instructions).toContain('Title: GTM Lead')

    const rows = s.decisions.rows()
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'coworkers.event_mine', status: 'shadow', outcome: 'observed', jevChoice: 'yes', jevConfidence: 0.82, requestedBy: 'bea', subjectUserId: 'cw-mkt', usedChoice: null }),
      expect.objectContaining({ kind: 'coworkers.event_mine', status: 'shadow', outcome: 'observed', jevChoice: 'no', requestedBy: 'bea', subjectUserId: 'cw-gtm' }),
    ])
    expect(rows[0]!.input).toMatchObject({ coworkerUserId: 'cw-mkt', eventId: 'm1', excerpt: 'We need the launch post drafted by Friday.' })
    expect(s.stores.routes).toEqual([expect.objectContaining({ eventId: 'm1', authorUserId: 'bea', outcome: 'decided', candidates: 2, questions: 2 })])
    expect(s.stores.observations.map((o) => [o.coworkerUserId, o.outcome, o.decisionId, o.routeId])).toEqual([
      ['cw-mkt', 'observed', rows[0]!.id, s.stores.routes[0]!.id],
      ['cw-gtm', 'observed', rows[1]!.id, s.stores.routes[0]!.id],
    ])
    expect(s.runs.rows).toHaveLength(0)
    expect(s.started).toHaveLength(0)
  })

  it('once across two processes and redeliveries: one route, one call, one row per co-worker', async () => {
    const s = setup({ ask: jevSays(['yes', 0.9], ['no', 0.9]) })
    await s.subscribe('cw-mkt', 'cw-gtm')
    const [a, b] = await Promise.all([s.router.route(ev('m1'), [mkt, gtm]), s.otherProcess.route(ev('m1'), [mkt, gtm])])
    expect([a.outcome, b.outcome].sort()).toEqual(['decided', 'duplicate'])
    expect(await s.router.route(ev('m1'), [mkt, gtm])).toEqual({ outcome: 'duplicate' })
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.decisions.rows()).toHaveLength(2)
    expect(s.stores.observations).toHaveLength(2)
  })

  it('there is no hourly limit any more: every message is routed', async () => {
    const s = setup({ ask: jevSays(['no', 0.9]) })
    await s.subscribe('cw-mkt')
    for (let n = 0; n < 25; n++) expect(await s.router.route(ev(`m${n}`), [mkt])).toMatchObject({ outcome: 'decided' })
    expect(s.ask).toHaveBeenCalledTimes(25)
    expect(await s.stores.counts('cw-mkt', new Date(0))).toMatchObject({ observed: 25, skipped_rate_limit: 0 })
  })

  it('a co-worker whose own daily cap is spent is left out of the question set and counted skipped_daily_cap', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = setup({ ask: jevSays(['yes', 0.9]), spent: { 'cw-mkt': 2.5 } })
    await s.subscribe('cw-mkt', 'cw-gtm')
    const out = await s.router.route(ev('m1'), [mkt, gtm])
    expect(out).toMatchObject({ outcome: 'decided', coworkers: { 'cw-mkt': { outcome: 'skipped_daily_cap', decisionId: null }, 'cw-gtm': { outcome: 'observed' } } })
    const call = (s.ask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { questions: Record<string, { instructions: string }> }
    expect(Object.keys(call.questions)).toEqual(['q0'])
    expect(call.questions.q0!.instructions).toContain('GTM Lead')
    expect(s.decisions.rows().map((r) => r.subjectUserId)).toEqual(['cw-gtm'])
    expect(s.stores.observations.find((o) => o.coworkerUserId === 'cw-mkt')).toMatchObject({ outcome: 'skipped_daily_cap', error: 'the daily AI budget is spent (2.5 >= 2 USD today, UTC)' })
    expect(s.stores.routes[0]).toMatchObject({ candidates: 2, questions: 1 })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('every candidate capped: no call, each counted, the route says why; never retried', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = setup({ spent: { 'cw-mkt': 9, 'cw-gtm': 9 } })
    await s.subscribe('cw-mkt', 'cw-gtm')
    expect(await s.router.route(ev('m1'), [mkt, gtm])).toMatchObject({ outcome: 'skipped_daily_cap' })
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.stores.observations.map((o) => o.outcome)).toEqual(['skipped_daily_cap', 'skipped_daily_cap'])
    expect(await s.router.route(ev('m1'), [mkt, gtm])).toEqual({ outcome: 'duplicate' })
    error.mockRestore()
  })

  it('the author’s daily AI cap spent: the route is skipped, every candidate counted skipped_author_cap, logged loud', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = setup({ authorRefusal: 'today’s 1 USD are spent' })
    await s.subscribe('cw-mkt', 'cw-gtm')
    expect(await s.router.route(ev('m1'), [mkt, gtm])).toMatchObject({ outcome: 'skipped_author_cap', coworkers: { 'cw-mkt': { outcome: 'skipped_author_cap' }, 'cw-gtm': { outcome: 'skipped_author_cap' } } })
    expect(s.ask).not.toHaveBeenCalled()
    expect(s.decisions.rows()).toHaveLength(0)
    expect(s.stores.routes[0]).toMatchObject({ outcome: 'skipped_author_cap', error: 'the author’s daily AI budget is spent: today’s 1 USD are spent' })
    expect(s.stores.observations.every((o) => o.error === 'the author’s daily AI budget is spent: today’s 1 USD are spent')).toBe(true)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('a Jev failure in shadow is logged on every co-worker’s decision row and counted failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = setup({ ask: vi.fn(async () => { throw new Error('gateway down') }) })
    await s.subscribe('cw-mkt', 'cw-gtm')
    expect(await s.router.route(ev('m1'), [mkt, gtm])).toMatchObject({ outcome: 'decided', coworkers: { 'cw-mkt': { outcome: 'failed' }, 'cw-gtm': { outcome: 'failed' } } })
    expect(s.decisions.rows().map((r) => [r.outcome, r.jevError])).toEqual([['observed', 'Error: gateway down'], ['observed', 'Error: gateway down']])
    expect(s.runs.rows).toHaveLength(0)
    error.mockRestore()
  })

  it('a failure outside the decision (the store, the ledger) marks every unfinished co-worker and the route failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = setup({ spentFails: true })
    await s.subscribe('cw-mkt')
    expect(await s.router.route(ev('m1'), [mkt])).toMatchObject({ outcome: 'failed', coworkers: { 'cw-mkt': { outcome: 'failed' } } })
    expect(s.stores.routes[0]).toMatchObject({ outcome: 'failed', error: 'ledger down' })
    expect(s.stores.observations[0]).toMatchObject({ outcome: 'failed', error: 'ledger down' })
    error.mockRestore()
  })

  it('enforced (the promotion): each "yes" queues exactly one event run in the event’s thread; a "no" queues nothing', async () => {
    const s = setup({ enforced: true, ask: jevSays(['yes', 0.9], ['no', 0.9]) })
    await s.subscribe('cw-mkt', 'cw-gtm')
    const out = await s.router.route(ev('m1'), [mkt, gtm])
    expect(out).toMatchObject({ outcome: 'decided', coworkers: { 'cw-mkt': { outcome: 'queued' }, 'cw-gtm': { outcome: 'observed' } } })
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
    expect(s.decisions.rows().map((r) => [r.subjectUserId, r.status, r.outcome, r.usedChoice, r.usedSource])).toEqual([
      ['cw-mkt', 'enforced', 'decided', 'yes', 'jev'],
      ['cw-gtm', 'enforced', 'decided', 'no', 'jev'],
    ])
  })

  it('refuses an event with no candidate (the source routes only when someone could be its)', async () => {
    const s = setup()
    await expect(s.router.route(ev('m1'), [])).rejects.toThrow(/at least one candidate/)
  })
})

describe('ChannelMessageSource', () => {
  const source = (router: CoworkerEventRouter, over: { access?: (id: string) => { read: boolean; member: boolean } } = {}) =>
    new ChannelMessageSource(
      {
        getConversation: async (id) => (id === channel.id ? channel : null),
        listPeople: async () => people,
        access: async (id) => over.access?.(id) ?? { read: true, member: true },
      },
      router,
    )

  it('a heard message is routed once to the co-workers it is an event for; a mention or no access leaves a co-worker out', async () => {
    const s = setup({ ask: jevSays(['yes', 0.9], ['no', 0.9]) })
    await s.subscribe('cw-mkt', 'cw-gtm')
    const src = source(s.router)
    expect(await src.onMessage(heard())).toMatchObject({ outcome: 'decided', coworkers: { 'cw-mkt': {}, 'cw-gtm': {} } })
    // @gtm: a C3 turn for GTM, still an event for Marketing.
    expect(await src.onMessage(heard({ id: 'm2', body: '@gtm what is the price?' }))).toMatchObject({ coworkers: { 'cw-mkt': {} } })
    expect(s.stores.observations.filter((o) => o.eventId === 'm2').map((o) => o.coworkerUserId)).toEqual(['cw-mkt'])
    expect(await source(s.router, { access: (id) => ({ read: true, member: id !== 'cw-mkt' }) }).onMessage(heard({ id: 'm3' }))).toMatchObject({ coworkers: { 'cw-gtm': {} } })
    expect(await source(s.router, { access: () => ({ read: false, member: true }) }).onMessage(heard({ id: 'm4' }))).toBeNull()
    expect(await src.onMessage(heard({ id: 'm5', body: '@marketing @gtm both of you' }))).toBeNull()
    expect(await src.onMessage(heard({ id: 'm6', authorId: 'cw-gtm' }))).toBeNull()
    expect(s.stores.routes.map((r) => r.eventId)).toEqual(['m1', 'm2', 'm3'])
  })

  it('every co-worker’s frame of one message: one route, one call (one process)', async () => {
    const s = setup({ ask: jevSays(['yes', 0.9], ['no', 0.9]) })
    await s.subscribe('cw-mkt', 'cw-gtm')
    const src = source(s.router)
    const [a, b] = await Promise.all([src.onMessage(heard()), src.onMessage(heard())])
    expect(a).toBe(b)
    expect(await src.onMessage(heard())).toBe(a)
    await src.idle()
    expect(s.ask).toHaveBeenCalledTimes(1)
    expect(s.stores.routes).toHaveLength(1)
  })

  it('nobody switched on: the message is not even looked at', async () => {
    const s = setup()
    const getConversation = vi.fn(async () => channel)
    const src = new ChannelMessageSource({ getConversation, listPeople: async () => people, access: async () => ({ read: true, member: true }) }, s.router)
    expect(await src.onMessage(heard())).toBeNull()
    expect(getConversation).not.toHaveBeenCalled()
    expect(s.ask).not.toHaveBeenCalled()
  })
})
