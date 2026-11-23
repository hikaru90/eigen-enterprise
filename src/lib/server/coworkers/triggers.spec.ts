import { describe, expect, it } from 'vitest'
import type { Person } from '../../../../modules/messages/store'
import { createChannel, openDm, postMessage } from '../../../../modules/messages/service'
import { composeCoworkerTurns } from './live-turns'
import { coworkerEmail } from './service'
import { turnsFixture } from './test-fixtures'
import { coworkerSessionId, coworkerTriggerFor, threadRootOf, type TriggerMessage } from './triggers'

/**
 * When a message asks an AI co-worker for a turn (plan/phase-ai-coworkers.md C3):
 * structure only — an @handle token or DM membership — and exactly one turn per
 * (co-worker, message), however often and by however many processes it is heard.
 */

const people: Person[] = [
  { id: 'bea', name: 'Bea Member', email: 'bea@co.test', kind: 'human' },
  { id: 'cw-mkt', name: 'Marketing', email: coworkerEmail('marketing', 'cw-mkt'), kind: 'coworker' },
  { id: 'cw-gtm', name: 'GTM', email: coworkerEmail('gtm', 'cw-gtm'), kind: 'coworker' },
]
const msg = (authorId: string, body: string, extra: Partial<TriggerMessage> = {}): TriggerMessage => ({
  id: 'm1',
  authorId,
  body,
  parentId: null,
  deleted: false,
  isCallLine: false,
  ...extra,
})
const trigger = (coworkerId: string, message: TriggerMessage, kind: 'channel' | 'dm') =>
  coworkerTriggerFor({ coworkerId, message, conversationKind: kind, people })

describe('coworkerTriggerFor (pure)', () => {
  it('a channel message asks the co-workers it @mentions, by slug', () => {
    expect(trigger('cw-mkt', msg('bea', '@marketing plan the launch'), 'channel')).toBe('mention')
    expect(trigger('cw-gtm', msg('bea', '@marketing plan the launch'), 'channel')).toBeNull()
    expect(trigger('cw-gtm', msg('cw-mkt', 'pricing? @gtm'), 'channel')).toBe('mention')
    expect(trigger('cw-mkt', msg('bea', 'marketing should look at this'), 'channel')).toBeNull()
  })

  it('a person’s DM asks every co-worker in it; a co-worker’s DM message only those it @mentions', () => {
    expect(trigger('cw-mkt', msg('bea', 'hi'), 'dm')).toBe('dm')
    expect(trigger('cw-gtm', msg('cw-mkt', 'hi'), 'dm')).toBeNull()
    expect(trigger('cw-gtm', msg('cw-mkt', '@gtm your view?'), 'dm')).toBe('mention')
  })

  it('never its own message, a deleted one, a call line or a former member’s DM', () => {
    expect(trigger('cw-mkt', msg('cw-mkt', '@marketing note to self'), 'channel')).toBeNull()
    expect(trigger('cw-mkt', msg('cw-mkt', 'hi'), 'dm')).toBeNull()
    expect(trigger('cw-mkt', msg('bea', '@marketing', { deleted: true }), 'channel')).toBeNull()
    expect(trigger('cw-mkt', msg('bea', '', { isCallLine: true }), 'dm')).toBeNull()
    expect(trigger('cw-mkt', msg('gone', 'hello'), 'dm')).toBeNull()
  })

  it('a directory without kinds fails loud instead of guessing who is a person', () => {
    expect(() =>
      coworkerTriggerFor({ coworkerId: 'cw-mkt', message: msg('bea', 'hi'), conversationKind: 'dm', people: [{ id: 'bea', name: 'Bea', email: 'b@x' }] }),
    ).toThrow(/no kind/)
  })

  it('threads: a reply answers in its thread, a channel message opens one, a DM message stays in the DM', () => {
    expect(threadRootOf({ id: 'm2', parentId: 'm1' }, 'channel')).toBe('m1')
    expect(threadRootOf({ id: 'm2', parentId: null }, 'channel')).toBe('m2')
    expect(threadRootOf({ id: 'm2', parentId: null }, 'dm')).toBeNull()
    expect(threadRootOf({ id: 'm2', parentId: 'm1' }, 'dm')).toBe('m1')
    expect(coworkerSessionId('cw', 'c', 'r')).toBe('coworker:cw:c:r')
    expect(coworkerSessionId('cw', 'c', null)).toBe('coworker:cw:c:main')
  })
})

describe('the trigger listener and the turn queue', () => {
  const answer = () => 'On it.'

  it('an @mention in a channel queues one turn; the reply lands in the thread as the co-worker', async () => {
    const fx = turnsFixture({ script: answer })
    await fx.handle.reload()
    expect(fx.handle.listener.listening()).toEqual(['cw-gtm', 'cw-mkt'])
    const launch = await createChannel(fx.deps, 'owner', { name: 'launch', private: false })
    const { message } = await postMessage(fx.deps, 'bea', launch.id, '@marketing plan the launch')
    await fx.settle()
    expect(fx.runs.rows).toEqual([
      expect.objectContaining({
        coworkerUserId: 'cw-mkt',
        triggerKind: 'mention',
        conversationId: launch.id,
        threadRootId: message.id,
        triggerMessageId: message.id,
        requestedByUserId: 'bea',
        status: 'done',
      }),
    ])
    expect(await fx.thread(message.id)).toEqual([
      { authorId: 'bea', body: '@marketing plan the launch' },
      { authorId: 'cw-mkt', body: 'On it.' },
    ])
    expect(fx.calls.map((c) => [c.agentId, c.sessionId, c.requestedBy])).toEqual([
      ['coworker-cw-mkt', `coworker:cw-mkt:${launch.id}:${message.id}`, 'bea'],
    ])
  })

  it('a DM to a co-worker queues its turn and it answers in the DM itself', async () => {
    const fx = turnsFixture({ script: answer })
    await fx.handle.reload()
    const dm = await openDm(fx.deps, 'bea', ['cw-gtm'])
    const { message } = await postMessage(fx.deps, 'bea', dm.id, 'what do we charge?')
    await fx.settle()
    expect(fx.runs.rows).toEqual([expect.objectContaining({ coworkerUserId: 'cw-gtm', triggerKind: 'dm', threadRootId: null, triggerMessageId: message.id })])
    const page = await fx.store.listMessagesBefore(dm.id, null, 10)
    expect(page.map((m) => [m.authorId, m.body, m.parentId])).toEqual([
      ['cw-gtm', 'On it.', null],
      ['bea', 'what do we charge?', null],
    ])
  })

  it('ignores its own messages, unmentioned co-workers and private channels it is not in', async () => {
    const fx = turnsFixture({ script: answer })
    await fx.handle.reload()
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const lead = await createChannel(fx.deps, 'owner', { name: 'leadership', private: true, userIds: ['bea'] })
    await postMessage(fx.deps, 'cw-mkt', general.id, '@marketing reminder to myself')
    await postMessage(fx.deps, 'bea', general.id, 'nobody is mentioned here')
    await postMessage(fx.deps, 'bea', lead.id, '@marketing can you see this?')
    await fx.settle()
    expect(fx.runs.rows).toEqual([])
    expect(fx.calls).toEqual([])
  })

  it('a switched-off co-worker is not asked, even by a process that still listens as it', async () => {
    const fx = turnsFixture({ script: answer })
    await fx.handle.reload()
    fx.coworkers.get('cw-mkt')!.enabled = false
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    await postMessage(fx.deps, 'bea', general.id, '@marketing hello?')
    await fx.settle()
    expect(fx.runs.rows).toEqual([])
    await fx.handle.reload()
    expect(fx.handle.listener.listening()).toEqual(['cw-gtm'])
  })

  it('the same message heard twice, and by two processes, queues exactly one turn', async () => {
    const fx = turnsFixture({ script: answer })
    await fx.handle.reload()
    // A second app process: its own turns and listener on the same hub, the same queue.
    const other = composeCoworkerTurns({
      registry: fx.registry,
      runtime: fx.runtime,
      messages: fx.deps,
      hub: fx.hub,
      coworkers: {
        get: async (id) => fx.coworkers.get(id)!,
        orgChart: async () => ({ people: [] }),
        listEnabled: async () => [...fx.coworkers.values()],
      },
      runs: fx.runs,
      company: async () => ({ name: null, profile: null, brandVoice: null }),
      turnCost: async () => 0,
      inTrace: (_id, fn) => fn(),
      now: fx.deps.now,
      staleAfterMs: 3_600_000,
    })
    await other.reload()
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(fx.deps, 'bea', general.id, '@gtm price it')
    // A LISTEN reconnect re-dispatches the event: heard again by both.
    await fx.hub.dispatch(await fx.store.latestEventId())
    await fx.settle()
    await other.turns.idle()
    expect(fx.runs.rows.filter((r) => r.triggerMessageId === message.id)).toHaveLength(1)
    expect(fx.calls).toHaveLength(1)
    expect((await fx.thread(message.id)).filter((m) => m.authorId === 'cw-gtm')).toHaveLength(1)
    other.stop()
  })

  it('turns of one co-worker in one thread run one at a time, in trigger order', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let running = 0
    let most = 0
    const fx = turnsFixture({
      script: async (call, n) => {
        running += 1
        most = Math.max(most, running)
        if (n === 1) await gate
        running -= 1
        return `answer ${n} to ${call.input.split('\n').at(-1)}`
      },
    })
    await fx.handle.reload()
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    const { message: root } = await postMessage(fx.deps, 'bea', general.id, '@marketing first')
    await new Promise((r) => setTimeout(r, 0))
    await postMessage(fx.deps, 'carl', general.id, '@marketing second', { parentId: root.id })
    await postMessage(fx.deps, 'bea', general.id, '@marketing third', { parentId: root.id })
    await new Promise((r) => setTimeout(r, 10))
    release()
    await fx.settle()
    expect(most).toBe(1)
    expect((await fx.thread(root.id)).filter((m) => m.authorId === 'cw-mkt').map((m) => m.body)).toEqual([
      'answer 1 to @marketing first',
      'answer 2 to @marketing second',
      'answer 3 to @marketing third',
    ])
  })

  it('stop: nothing new is heard or claimed', async () => {
    const fx = turnsFixture({ script: answer })
    await fx.handle.reload()
    fx.handle.stop()
    expect(fx.handle.listener.listening()).toEqual([])
    const general = await createChannel(fx.deps, 'owner', { name: 'general', private: false })
    await postMessage(fx.deps, 'bea', general.id, '@marketing anyone?')
    await fx.settle()
    expect(fx.runs.rows).toEqual([])
  })
})
