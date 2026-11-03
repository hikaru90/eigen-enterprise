import { describe, expect, it } from 'vitest'
import { MessagesHub, messagesStreamResponse, parseLastEventId, type StreamFrame } from './hub'
import { createChannel, markRead, openDm, postMessage } from './service'
import { fixture } from './test-fixtures'

/** A hub wired the way the live listener does it: every appended event is "NOTIFY"-ed into dispatch. */
function liveFixture() {
  const f = fixture()
  const hub = new MessagesHub(f.deps)
  const pending: Promise<void>[] = []
  f.store.onEvent = (id) => pending.push(hub.dispatch(id))
  const settle = async () => {
    while (pending.length) await pending.shift()
  }
  const inbox = (userId: string) => {
    const frames: StreamFrame[] = []
    hub.subscribe(userId, (fr) => frames.push(fr))
    return frames
  }
  return { ...f, hub, settle, inbox }
}

describe('MessagesHub fan-out', () => {
  it('delivers a new message to everyone who may see the channel, with their unread count', async () => {
    const { deps, settle, inbox } = liveFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const owner = inbox('owner')
    const bea = inbox('bea')
    await postMessage(deps, 'bea', ch.id, 'hi all')
    await settle()
    const ownerMsg = owner.find((f) => f.event === 'message')
    expect(ownerMsg).toMatchObject({ data: { action: 'created', unread: 1, message: { body: 'hi all', authorName: 'Bea Member' } } })
    expect(bea.find((f) => f.event === 'message')).toMatchObject({ data: { unread: 0 } })
  })

  it('filters by access per event: private channels and DMs reach their members only', async () => {
    const { deps, settle, inbox } = liveFixture()
    const bea = inbox('bea')
    const carl = inbox('carl')
    const owner = inbox('owner')
    const lead = await createChannel(deps, 'owner', { name: 'leadership', private: true, userIds: ['carl'] })
    await postMessage(deps, 'owner', lead.id, 'secret plan')
    const dm = await openDm(deps, 'carl', ['bea'])
    await postMessage(deps, 'carl', dm.id, 'dm text')
    await settle()
    const bodies = (frames: StreamFrame[]) =>
      frames.flatMap((f) => (f.event === 'message' ? [f.data.message.body] : []))
    expect(bodies(bea)).toEqual(['dm text'])
    expect(bodies(carl)).toEqual(['secret plan', 'dm text'])
    expect(bodies(owner)).toEqual(['secret plan']) // admins never see others' DMs
    expect(bea.filter((f) => f.event === 'conversation').map((f) => f.event === 'conversation' && f.data.conversation.id)).toEqual([dm.id])
  })

  it('sends read-state changes to that person only', async () => {
    const { deps, settle, inbox } = liveFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    await postMessage(deps, 'owner', ch.id, 'x')
    const bea = inbox('bea')
    const carl = inbox('carl')
    await markRead(deps, 'bea', ch.id)
    await settle()
    expect(bea).toEqual([{ id: expect.any(Number), event: 'read', data: { conversationId: ch.id, unread: 0 } }])
    expect(carl).toEqual([])
  })

  it('catch-up after Last-Event-ID replays only what that person may see', async () => {
    const { deps, hub, store } = liveFixture()
    const general = await createChannel(deps, 'owner', { name: 'general', private: false })
    const mark = await store.latestEventId()
    const lead = await createChannel(deps, 'owner', { name: 'leadership', private: true })
    await postMessage(deps, 'owner', lead.id, 'secret')
    await postMessage(deps, 'owner', general.id, 'public news')
    const frames = await hub.catchUp('bea', mark)
    expect(frames.map((f) => (f.event === 'message' ? f.data.message.body : f.event))).toEqual(['public news'])
    expect(frames.every((f) => f.id > mark)).toBe(true)
  })

  it('resync after a listener reconnect dispatches events committed meanwhile', async () => {
    const { deps, hub, store, inbox } = liveFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    await hub.dispatch(await store.latestEventId())
    store.onEvent = null // the LISTEN connection is down
    const bea = inbox('bea')
    await postMessage(deps, 'owner', ch.id, 'while down')
    expect(bea).toEqual([])
    await hub.resync()
    expect(bea.map((f) => f.event === 'message' && f.data.message.body)).toEqual(['while down'])
  })
})

async function readFrames(res: Response, count: number): Promise<string> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let text = ''
  while ((text.match(/\n\nid:|^id:/g)?.length ?? 0) < count || !text.endsWith('\n\n')) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value)
    if ((text.match(/^id: /gm)?.length ?? 0) >= count) break
  }
  await reader.cancel()
  return text
}

describe('messagesStreamResponse', () => {
  it('sends catch-up then live frames as SSE with ids, each id once, and unsubscribes on cancel', async () => {
    const { deps, hub, store, settle } = liveFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    await settle()
    const mark = await store.latestEventId()
    await postMessage(deps, 'owner', ch.id, 'missed while offline')
    await settle()
    const ac = new AbortController()
    const res = messagesStreamResponse(hub, 'bea', mark, ac.signal)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    await new Promise((r) => setTimeout(r, 0))
    await postMessage(deps, 'owner', ch.id, 'live')
    await settle()
    const text = await readFrames(res, 2)
    expect(text).toContain('event: message')
    expect(text.indexOf('missed while offline')).toBeLessThan(text.indexOf('live'))
    expect(text.match(/^id: (\d+)$/gm)).toHaveLength(2)
    expect(hub.size).toBe(0)
  })

  it('parses Last-Event-ID defensively', () => {
    expect(parseLastEventId(null)).toBeNull()
    expect(parseLastEventId('')).toBeNull()
    expect(parseLastEventId('42')).toBe(42)
    expect(parseLastEventId('-1')).toBeNull()
    expect(parseLastEventId('abc')).toBeNull()
  })
})
