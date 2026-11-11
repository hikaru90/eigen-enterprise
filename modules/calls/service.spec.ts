import { TokenVerifier } from 'livekit-server-sdk'
import { describe, expect, it } from 'vitest'
import { RING_TIMEOUT_MS } from './state'
import { fixture, TEST_LIVEKIT_ENV } from './test-fixtures'

const verify = (token: string) => new TokenVerifier(TEST_LIVEKIT_ENV.LIVEKIT_API_KEY, TEST_LIVEKIT_ENV.LIVEKIT_API_SECRET).verify(token)

describe('starting calls', () => {
  it('a DM call rings the other person; the caller is in it', async () => {
    const { service, user } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    expect(call).toMatchObject({ state: 'ringing', contextKind: 'dm', title: 'Ann Example, Ben Example', startedBy: 'ann', startedByName: 'Ann Example' })
    expect(call.participants.map((p) => [p.userId, p.response])).toEqual([
      ['ann', 'accepted'],
      ['ben', 'none'],
    ])
  })

  it('a channel call rings every member; someone outside the channel cannot start one (fail closed)', async () => {
    const { service, user } = fixture()
    const call = await service.start(user('ben'), { contextKind: 'channel', contextId: 'ch-general' })
    expect(call.participants.map((p) => p.userId)).toEqual(['ben', 'ann', 'cat'])
    await expect(service.start(user('dan'), { contextKind: 'channel', contextId: 'ch-general' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(service.start(user('dan'), { contextKind: 'dm', contextId: 'dm-ann-ben' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a read-only channel member cannot start a call there', async () => {
    const { service, user, contexts } = fixture()
    contexts.conversations.get('ch-general')!.readOnly = ['cat']
    await expect(service.start(user('cat'), { contextKind: 'channel', contextId: 'ch-general' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('every member may start a meeting with an explicit invite list', async () => {
    const { service, user } = fixture()
    const call = await service.start(user('dan'), { contextKind: 'meeting', userIds: ['ann', 'cat', 'dan'] })
    expect(call).toMatchObject({ contextKind: 'meeting', contextId: null, title: 'Meeting with Ann Example, Cat Example' })
    expect(call.participants.map((p) => p.userId)).toEqual(['dan', 'ann', 'cat'])
    const titled = await service.start(user('dan'), { contextKind: 'meeting', userIds: ['ben'], title: '  Standup ' })
    expect(titled.title).toBe('Standup')
  })

  it('refuses bad input', async () => {
    const { service, user } = fixture()
    await expect(service.start(user('ann'), { contextKind: 'meeting', userIds: [] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.start(user('ann'), { contextKind: 'meeting', userIds: ['ghost'] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben', userIds: ['cat'] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.start(user('ann'), { contextKind: 'dm' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(service.start(user('ann'), { contextKind: 'room' as never })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a non-member of the company cannot start anything', async () => {
    const { service, user } = fixture()
    await expect(service.start(user('stranger'), { contextKind: 'meeting', userIds: ['ann'] })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('both people starting a call to each other at once end up in ONE call, both accepted', async () => {
    const { service, user, store } = fixture()
    const [a, b] = await Promise.all([
      service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' }),
      service.start(user('ben'), { contextKind: 'dm', contextId: 'dm-ann-ben' }),
    ])
    expect(a.id).toBe(b.id)
    expect(store.records.size).toBe(1)
    const call = await service.get('ann', a.id)
    expect(call.participants.every((p) => p.response === 'accepted')).toBe(true)
  })

  it('calling a DM that already has a live call joins it instead of ringing twice', async () => {
    const { service, user, store } = fixture()
    const first = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    const again = await service.start(user('ben'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    expect(again.id).toBe(first.id)
    expect(store.records.size).toBe(1)
  })

  it('LiveKit not set up: starting fails loud before anyone is rung, and no token is minted', async () => {
    const { service, user, store } = fixture({ env: { ...TEST_LIVEKIT_ENV, LIVEKIT_API_SECRET: undefined } })
    await expect(service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })).rejects.toMatchObject({
      code: 'not_configured',
      message: expect.stringContaining('Calls are not set up on this server'),
    })
    expect(store.records.size).toBe(0)
  })
})

describe('membership on every action (fail closed)', () => {
  it('someone outside the call gets not_found for get, accept, decline, hangup, token and end', async () => {
    const { service, user } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    for (const run of [
      () => service.get('cat', call.id),
      () => service.accept('cat', call.id),
      () => service.decline('cat', call.id),
      () => service.hangup('cat', call.id),
      () => service.token('cat', call.id),
      () => service.end(user('cat'), call.id),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: 'not_found' })
    }
  })

  it('losing access to the conversation loses access to its call', async () => {
    const { service, user, contexts } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    await service.accept('cat', call.id)
    contexts.conversations.get('ch-general')!.memberIds = ['ann', 'ben']
    await expect(service.token('cat', call.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(await service.list(user('cat'))).toEqual([])
  })

  it('a meeting is its invite list only', async () => {
    const { service, user } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'meeting', userIds: ['ben'] })
    await expect(service.accept('cat', call.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await service.accept('ben', call.id)).participants.find((p) => p.userId === 'ben')?.response).toBe('accepted')
  })

  it('someone removed from the company loses the call', async () => {
    const { service, user, directory } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    directory.roles.delete('ben')
    await expect(service.accept('ben', call.id)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('tokens', () => {
  it('the caller and an accepted callee get a one-room token; a callee who has not accepted does not', async () => {
    const { service, user } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    const t = await service.token('ann', call.id)
    expect(t).toMatchObject({ url: TEST_LIVEKIT_ENV.LIVEKIT_URL, identity: 'ann', room: `ee-call-${call.id}` })
    const claims = await verify(t.token)
    expect(claims).toMatchObject({ sub: 'ann', name: 'Ann Example', video: { roomJoin: true, room: `ee-call-${call.id}` } })
    await expect(service.token('ben', call.id)).rejects.toMatchObject({ code: 'conflict' })
    await service.accept('ben', call.id)
    expect((await verify((await service.token('ben', call.id)).token)).sub).toBe('ben')
  })

  it('a channel member who joined the channel after the call started may accept and join', async () => {
    const { service, user, contexts } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    contexts.conversations.get('ch-general')!.memberIds.push('dan')
    await service.accept('dan', call.id)
    expect((await verify((await service.token('dan', call.id)).token)).sub).toBe('dan')
  })

  it('no token for a call that is over', async () => {
    const { service, user } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await service.decline('ben', call.id)
    await expect(service.token('ann', call.id)).rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('the call lifecycle through the service', () => {
  it('ringing → active → ended, driven by the webhook facts', async () => {
    const { service, user } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    const room = `ee-call-${call.id}`
    await service.applyWebhook({ kind: 'participant_joined', room, identity: 'ann' })
    await service.accept('ben', call.id)
    await service.applyWebhook({ kind: 'participant_joined', room, identity: 'ben' })
    expect((await service.get('ann', call.id)).state).toBe('active')
    await service.applyWebhook({ kind: 'participant_left', room, identity: 'ann' })
    await service.applyWebhook({ kind: 'participant_left', room, identity: 'ben' })
    const done = await service.get('ann', call.id)
    expect(done.state).toBe('ended')
    expect(done.answeredAt).not.toBeNull()
  })

  it('ringing timeout → missed, stored by the sweep; the waiting caller is dropped from the room', async () => {
    const { service, user, clock, closed } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ann' })
    clock.tick(RING_TIMEOUT_MS - 1000)
    expect(await service.expireRinging()).toBe(0)
    clock.tick(1000)
    expect((await service.get('ben', call.id)).state).toBe('missed') // reads as missed even before the sweep
    expect(await service.expireRinging()).toBe(0) // get() already stored it
    expect(closed).toEqual([`ee-call-${call.id}`])
  })

  it('the sweep stores every elapsed ring window', async () => {
    const { service, user, clock, store } = fixture()
    const a = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    const b = await service.start(user('dan'), { contextKind: 'meeting', userIds: ['cat'] })
    clock.tick(RING_TIMEOUT_MS)
    expect(await service.expireRinging()).toBe(2)
    expect((await store.get(a.id))!.call.state).toBe('missed')
    expect((await store.get(b.id))!.call.state).toBe('missed')
  })

  it('a declined 1:1 call closes the room the caller was waiting in', async () => {
    const { service, user, closed } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ann' })
    expect((await service.decline('ben', call.id)).state).toBe('declined')
    expect(closed).toEqual([`ee-call-${call.id}`])
  })

  it('end: only the starter ends it for everyone; the room is closed', async () => {
    const { service, user, closed } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    const room = `ee-call-${call.id}`
    await service.accept('ben', call.id)
    await service.applyWebhook({ kind: 'participant_joined', room, identity: 'ann' })
    await service.applyWebhook({ kind: 'participant_joined', room, identity: 'ben' })
    await expect(service.end(user('ben'), call.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await service.end(user('ann'), call.id)).state).toBe('ended')
    expect(closed).toEqual([room])
  })

  it('hangup by a callee leaves the call running for the others', async () => {
    const { service, user } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    const room = `ee-call-${call.id}`
    for (const u of ['ann', 'ben', 'cat']) {
      if (u !== 'ann') await service.accept(u, call.id)
      await service.applyWebhook({ kind: 'participant_joined', room, identity: u })
    }
    expect((await service.hangup('cat', call.id)).state).toBe('active')
  })

  it('webhooks for unknown rooms or uninvited identities change nothing', async () => {
    const { service, user, store } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    const before = structuredClone(await store.get(call.id))
    expect(await service.applyWebhook({ kind: 'participant_joined', room: 'nope', identity: 'ann' })).toEqual({ applied: false })
    expect(await service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'cat' })).toEqual({ applied: false })
    expect(await store.get(call.id)).toEqual(before)
  })
})

describe('list', () => {
  it('a person sees the calls they were in, newest first; the agent sees the meetings it started', async () => {
    const { service, user, clock } = fixture()
    const a = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    clock.tick(1000)
    const m = await service.start({ kind: 'agent', id: 'agent:1' }, { contextKind: 'meeting', userIds: ['ann'] })
    expect((await service.list(user('ann'))).map((c) => c.id)).toEqual([m.id, a.id])
    expect((await service.list(user('cat'))).map((c) => c.id)).toEqual([])
    expect((await service.list({ kind: 'agent', id: 'agent:1' })).map((c) => c.id)).toEqual([m.id])
    expect(m.startedByName).toBe('Agent')
  })
})

describe('agents', () => {
  it('start meetings only, are never a participant, and never get a token', async () => {
    const { service } = fixture()
    const agent = { kind: 'agent' as const, id: 'agent:1' }
    await expect(service.start(agent, { contextKind: 'dm', contextId: 'dm-ann-ben' })).rejects.toMatchObject({ code: 'forbidden' })
    const m = await service.start(agent, { contextKind: 'meeting', userIds: ['ann', 'ben'] })
    expect(m.participants.map((p) => p.userId)).toEqual(['ann', 'ben'])
    await expect(service.token('agent:1', m.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await service.end(agent, m.id)).state).toBe('missed')
    await expect(service.end({ kind: 'agent', id: 'agent:2' }, m.id)).rejects.toMatchObject({ code: 'not_found' })
  })
})
