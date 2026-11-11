import { createHash } from 'node:crypto'
import { AccessToken } from 'livekit-server-sdk'
import { describe, expect, it } from 'vitest'
import { livekitConfig } from './livekit'
import { fixture, TEST_LIVEKIT_ENV } from './test-fixtures'
import { handleLiveKitWebhook } from './webhook'

/** A webhook exactly as livekit-server signs one: a JWT (API key/secret) carrying the body's sha256. */
async function signed(body: string, secret = TEST_LIVEKIT_ENV.LIVEKIT_API_SECRET): Promise<string> {
  const at = new AccessToken(TEST_LIVEKIT_ENV.LIVEKIT_API_KEY, secret)
  at.sha256 = createHash('sha256').update(body).digest('base64')
  return at.toJwt()
}

const eventBody = (event: string, room: string, identity?: string) =>
  JSON.stringify({
    event,
    id: `EV_${event}_${identity ?? 'room'}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { sid: 'RM_test', name: room },
    ...(identity ? { participant: { sid: `PA_${identity}`, identity } } : {}),
  })

async function setup() {
  const f = fixture()
  const call = await f.service.start(f.user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
  await f.service.accept('ben', call.id)
  const room = `ee-call-${call.id}`
  const post = async (body: string, auth: string | null) =>
    handleLiveKitWebhook(f.service, () => livekitConfig(TEST_LIVEKIT_ENV), body, auth)
  const send = async (event: string, identity?: string) => {
    const body = eventBody(event, room, identity)
    return post(body, await signed(body))
  }
  return { ...f, call, room, post, send }
}

describe('LiveKit webhook', () => {
  it('participant_joined / participant_left drive participant rows and the call state', async () => {
    const { send, store, call } = await setup()
    expect(await send('participant_joined', 'ann')).toEqual({ status: 200, body: { ok: true, applied: true } })
    await send('participant_joined', 'ben')
    let rec = (await store.get(call.id))!
    expect(rec.call.state).toBe('active')
    expect(rec.participants.find((p) => p.userId === 'ben')!.joinedAt).not.toBeNull()
    await send('participant_left', 'ben')
    await send('participant_connection_aborted', 'ann')
    rec = (await store.get(call.id))!
    expect(rec.call.state).toBe('ended')
    expect(rec.participants.every((p) => p.leftAt !== null)).toBe(true)
  })

  it('room_finished ends the call', async () => {
    const { send, store, call } = await setup()
    await send('participant_joined', 'ann')
    await send('participant_joined', 'ben')
    await send('room_finished')
    expect((await store.get(call.id))!.call.state).toBe('ended')
  })

  it('a bad signature is rejected (401) and changes nothing', async () => {
    const { post, store, call, room } = await setup()
    const before = structuredClone(await store.get(call.id))
    const body = eventBody('participant_joined', room, 'ann')
    expect((await post(body, await signed(body, 'not-the-secret-0123456789abcdefghijkl'))).status).toBe(401)
    expect((await post(body, null)).status).toBe(401)
    expect((await post(body, 'garbage')).status).toBe(401)
    // A valid signature for a different body (tampered payload).
    expect((await post(eventBody('participant_joined', room, 'ben'), await signed(body))).status).toBe(401)
    expect(await store.get(call.id)).toEqual(before)
  })

  it('events Calls does not use are acknowledged and ignored', async () => {
    const { send, store, call } = await setup()
    const before = structuredClone(await store.get(call.id))
    expect(await send('track_published', 'ann')).toEqual({ status: 200, body: { ok: true, applied: false } })
    expect(await store.get(call.id)).toEqual(before)
  })

  it('without LiveKit configured the webhook answers 503 (nothing to verify against)', async () => {
    const { service } = fixture()
    const out = await handleLiveKitWebhook(service, () => livekitConfig({}), '{}', 'x')
    expect(out.status).toBe(503)
    expect(out.body.error).toMatch(/Calls are not set up on this server/)
  })
})
