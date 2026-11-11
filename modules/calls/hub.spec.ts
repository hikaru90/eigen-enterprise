import { describe, expect, it } from 'vitest'
import { CallsHub, callsStreamResponse, type CallFrame } from './hub'
import { fixture } from './test-fixtures'

/** A hub wired the way the live listener does it: every stored change is "NOTIFY"-ed into dispatch. */
function liveFixture() {
  const f = fixture()
  const hub = new CallsHub(f.service)
  const pending: Promise<void>[] = []
  f.store.onChange = (id) => pending.push(hub.dispatch(id))
  const settle = async () => {
    while (pending.length) await pending.shift()
  }
  const inbox = (userId: string) => {
    const frames: CallFrame[] = []
    hub.subscribe(userId, (fr) => frames.push(fr))
    return frames
  }
  return { ...f, hub, settle, inbox }
}

describe('CallsHub fan-out', () => {
  it('rings the callee, tells the caller the state, and never sends a frame to anyone else', async () => {
    const { service, user, settle, inbox } = liveFixture()
    const ann = inbox('ann')
    const ben = inbox('ben')
    const cat = inbox('cat')
    const dan = inbox('dan')
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await settle()
    expect(ben.map((f) => f.event)).toEqual(['call.ringing'])
    expect(ann.map((f) => f.event)).toEqual(['call.state'])
    await service.accept('ben', call.id)
    await service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ben' })
    await service.hangup('ben', call.id)
    await settle()
    expect(ben.slice(1).map((f) => [f.event, f.data.call.state])).toEqual([
      ['call.state', 'ringing'],
      ['call.state', 'active'],
      ['call.state', 'ended'],
    ])
    expect(cat).toEqual([])
    expect(dan).toEqual([])
  })

  it('a channel call rings its members only', async () => {
    const { service, user, settle, inbox } = liveFixture()
    const cat = inbox('cat')
    const dan = inbox('dan')
    await service.start(user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    await settle()
    expect(cat.map((f) => f.event)).toEqual(['call.ringing'])
    expect(dan).toEqual([])
  })

  it('re-checks membership at send time: someone who lost access stops getting frames', async () => {
    const { service, user, settle, inbox, contexts } = liveFixture()
    const cat = inbox('cat')
    const call = await service.start(user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    await settle()
    contexts.conversations.get('ch-general')!.memberIds = ['ann', 'ben']
    await service.accept('ben', call.id)
    await settle()
    expect(cat.map((f) => f.event)).toEqual(['call.ringing'])
  })

  it('resync (LISTEN came back) resends each subscriber its live calls only', async () => {
    const { service, user, hub, inbox, settle } = liveFixture()
    await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await settle()
    const ben = inbox('ben')
    const cat = inbox('cat')
    await hub.resync()
    expect(ben.map((f) => f.event)).toEqual(['call.ringing'])
    expect(cat).toEqual([])
  })

  it('the stream opens with a snapshot of the person’s live calls, then live frames; a stranger’s stream stays empty', async () => {
    const { service, user, hub, settle } = liveFixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await settle()
    const ac = new AbortController()
    const res = callsStreamResponse(hub, 'ben', ac.signal)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value)
    }
    await readUntil('event: call.ringing')
    expect(text).toContain(`"id":"${call.id}"`)
    await service.decline('ben', call.id)
    await settle()
    await readUntil('"state":"declined"')
    ac.abort()
    expect(hub.size).toBe(0)

    const strangerAc = new AbortController()
    const stranger = callsStreamResponse(hub, 'dan', strangerAc.signal).body!.getReader()
    const first = decoder.decode((await stranger.read()).value)
    expect(first).toBe(': connected\n\n')
    await service.start(user('ben'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await settle()
    strangerAc.abort()
    // Nothing but the connect comment was ever queued for the stranger.
    const rest = await Promise.race([stranger.read(), new Promise((r) => setTimeout(() => r('idle'), 20))])
    expect(rest).toBe('idle')
  })
})
