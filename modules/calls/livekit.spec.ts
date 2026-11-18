import { TokenVerifier } from 'livekit-server-sdk'
import { describe, expect, it } from 'vitest'
import { GUEST_ATTRIBUTE, livekitConfig, mintGuestToken, mintRoomToken, TOKEN_TTL_SECONDS } from './livekit'

const env = { LIVEKIT_URL: 'wss://rtc.os.example.test', LIVEKIT_API_URL: 'http://127.0.0.1:4001', LIVEKIT_API_KEY: 'APItestkey', LIVEKIT_API_SECRET: 'test-secret-that-is-long-enough-0123456789' }

describe('livekitConfig (read at use time, no defaults)', () => {
  it('reads the three variables', () => {
    const cfg = livekitConfig(env)
    expect(cfg).toMatchObject({ url: env.LIVEKIT_URL, apiUrl: env.LIVEKIT_API_URL, apiKey: env.LIVEKIT_API_KEY })
    expect(cfg.apiSecret).toBe(env.LIVEKIT_API_SECRET)
  })

  it('refuses a LIVEKIT_API_URL that is not http(s):// (the server API, not the browser signalling URL)', () => {
    expect(() => livekitConfig({ ...env, LIVEKIT_API_URL: 'wss://rtc.os.example.test' })).toThrow(expect.objectContaining({ code: 'not_configured' }))
    expect(() => livekitConfig({ ...env, LIVEKIT_API_URL: 'not a url' })).toThrow(expect.objectContaining({ code: 'not_configured' }))
  })

  it.each(['LIVEKIT_URL', 'LIVEKIT_API_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])('missing %s → not_configured, naming the variable', (name) => {
    const partial = { ...env, [name]: '  ' }
    expect(() => livekitConfig(partial)).toThrow(expect.objectContaining({ code: 'not_configured' }))
    expect(() => livekitConfig(partial)).toThrow(/Calls are not set up on this server/)
    expect(() => livekitConfig(partial)).toThrow(new RegExp(name))
  })

  it('refuses a LIVEKIT_URL that is not ws(s)://', () => {
    expect(() => livekitConfig({ ...env, LIVEKIT_URL: 'https://rtc.os.example.test' })).toThrow(expect.objectContaining({ code: 'not_configured' }))
    expect(() => livekitConfig({ ...env, LIVEKIT_URL: 'not a url' })).toThrow(expect.objectContaining({ code: 'not_configured' }))
  })

  it('never serializes the secret (logs, JSON responses)', () => {
    const cfg = livekitConfig(env)
    expect(JSON.stringify(cfg)).not.toContain(env.LIVEKIT_API_SECRET)
    expect(Object.keys(cfg)).not.toContain('apiSecret')
  })
})

describe('mintRoomToken', () => {
  it('grants roomJoin for exactly that room, identity = user id, name = display name, ~10 min TTL', async () => {
    const cfg = livekitConfig(env)
    const out = await mintRoomToken(cfg, { room: 'ee-call-1', identity: 'user-ann', name: 'Ann Example' })
    const claims = await new TokenVerifier(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET).verify(out.token)
    expect(claims.sub).toBe('user-ann')
    expect(claims.name).toBe('Ann Example')
    expect(claims.iss).toBe(env.LIVEKIT_API_KEY)
    expect(claims.video).toEqual({ roomJoin: true, room: 'ee-call-1', canPublish: true, canSubscribe: true, canPublishData: true })
    expect(claims.video?.roomCreate).toBeUndefined()
    expect(claims.video?.roomAdmin).toBeUndefined()
    expect(claims.exp! - claims.nbf!).toBeGreaterThanOrEqual(TOKEN_TTL_SECONDS - 1)
    expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(TOKEN_TTL_SECONDS)
    expect(TOKEN_TTL_SECONDS).toBe(600)
    expect(Math.abs(out.expiresAt.getTime() - claims.exp! * 1000)).toBeLessThan(2000)
  })

  it('a token signed with another secret does not verify', async () => {
    const out = await mintRoomToken(livekitConfig(env), { room: 'r', identity: 'u', name: 'U' })
    await expect(new TokenVerifier(env.LIVEKIT_API_KEY, 'another-secret-entirely-0123456789abcdef').verify(out.token)).rejects.toThrow()
  })
})

describe('mintGuestToken (people outside the company)', () => {
  it('joins that one room only, publishes its own camera, mic and screen, no data, no admin; marked a guest', async () => {
    const cfg = livekitConfig(env)
    const out = await mintGuestToken(cfg, { room: 'ee-call-1', identity: 'guest:g1', name: 'Ony Kunde', notAfter: new Date(Date.now() + 3_600_000), now: new Date() })
    const claims = await new TokenVerifier(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET).verify(out.token)
    expect(claims.sub).toBe('guest:g1')
    expect(claims.name).toBe('Ony Kunde')
    expect(claims.attributes).toEqual({ [GUEST_ATTRIBUTE]: 'guest' })
    expect(claims.video).toMatchObject({ roomJoin: true, room: 'ee-call-1', canPublish: true, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false })
    expect(claims.video?.canPublishSources).toEqual(['camera', 'microphone', 'screen_share'])
    for (const k of ['roomCreate', 'roomAdmin', 'roomList', 'roomRecord', 'ingressAdmin', 'hidden', 'agent'] as const) expect(claims.video?.[k]).toBeFalsy()
    expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(TOKEN_TTL_SECONDS)
  })

  it('never outlives the guest window', async () => {
    const notAfter = new Date(Date.now() + 120_000)
    const out = await mintGuestToken(livekitConfig(env), { room: 'r', identity: 'guest:g1', name: 'G', notAfter, now: new Date() })
    const claims = await new TokenVerifier(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET).verify(out.token)
    expect(claims.exp! * 1000).toBeLessThanOrEqual(notAfter.getTime() + 1000)
    await expect(mintGuestToken(livekitConfig(env), { room: 'r', identity: 'guest:g1', name: 'G', notAfter: new Date(Date.now() - 1), now: new Date() })).rejects.toThrow()
  })
})
