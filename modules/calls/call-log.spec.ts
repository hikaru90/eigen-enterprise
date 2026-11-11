import { describe, expect, it } from 'vitest'
import { RING_TIMEOUT_MS } from './state'
import { fixture } from './test-fixtures'

/**
 * When a DM/channel call is over, Calls tells its CallLogPort once (the
 * composition root turns that into a call line in the conversation,
 * plan/video-calls.md §2). Meetings belong to no conversation: nothing is told.
 */

describe('call log port', () => {
  it('an answered DM call that ends: once, with its duration from the first answer to the end', async () => {
    const { service, user, clock, logged } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    const room = `ee-call-${call.id}`
    await service.applyWebhook({ kind: 'participant_joined', room, identity: 'ann' })
    clock.tick(5_000)
    await service.accept('ben', call.id)
    await service.applyWebhook({ kind: 'participant_joined', room, identity: 'ben' })
    const answeredAt = clock.now()
    clock.tick(245_000)
    // A DM ends for both at the first hang-up (owner decision 2026-11-11): logged right then.
    await service.hangup('ann', call.id)
    expect(logged).toHaveLength(1)
    await service.applyWebhook({ kind: 'participant_left', room, identity: 'ann' })
    await service.applyWebhook({ kind: 'participant_left', room, identity: 'ben' })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toEqual({
      callId: call.id,
      contextKind: 'dm',
      contextId: 'dm-ann-ben',
      startedBy: 'ann',
      outcome: 'ended',
      durationSeconds: 245,
      endedAt: new Date(answeredAt.getTime() + 245_000),
    })
    // Nothing more once it is over.
    await service.applyWebhook({ kind: 'room_finished', room })
    expect(logged).toHaveLength(1)
  })

  it('a channel call nobody answers: missed, after the ring window (sweep)', async () => {
    const { service, user, clock, logged } = fixture()
    const call = await service.start(user('ben'), { contextKind: 'channel', contextId: 'ch-general' })
    clock.tick(RING_TIMEOUT_MS + 1)
    expect(await service.expireRinging()).toBe(1)
    expect(logged).toEqual([expect.objectContaining({ callId: call.id, contextKind: 'channel', contextId: 'ch-general', outcome: 'missed', durationSeconds: null })])
  })

  it('declined by the person called: declined; the caller cancelling: missed', async () => {
    const { service, user, logged } = fixture()
    const a = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await service.decline('ben', a.id)
    const b = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await service.hangup('ann', b.id)
    expect(logged.map((l) => [l.callId, l.outcome])).toEqual([
      [a.id, 'declined'],
      [b.id, 'missed'],
    ])
  })

  it('accepted but nobody ever connected media (caller hangs up during the camera prompt): missed, the hang-up succeeds', async () => {
    const { service, user, logged } = fixture()
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await service.accept('ben', call.id)
    await service.hangup('ann', call.id)
    expect((await service.get('ann', call.id)).state).toBe('missed')
    expect(logged).toEqual([expect.objectContaining({ callId: call.id, outcome: 'missed', durationSeconds: null })])
  })

  it('a meeting tells nobody (it has no conversation)', async () => {
    const { service, user, logged } = fixture()
    const m = await service.start(user('ann'), { contextKind: 'meeting', userIds: ['ben'] })
    await service.hangup('ann', m.id)
    expect(logged).toEqual([])
  })

  it('a failing port fails the action loud (the call state is already stored)', async () => {
    const { service, user, deps } = fixture()
    deps.log.callEnded = async () => {
      throw new Error('messages down')
    }
    const call = await service.start(user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await expect(service.decline('ben', call.id)).rejects.toThrow(/messages down/)
    expect((await service.get('ann', call.id)).state).toBe('declined')
  })
})
