import { TokenVerifier } from 'livekit-server-sdk'
import { describe, expect, it } from 'vitest'
import { livekitConfig, mintRoomToken, TOKEN_TTL_SECONDS } from './livekit'

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
