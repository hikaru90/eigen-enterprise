import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { load } from './+page.server'

/**
 * A real Better Auth (memory adapter + the passkey plugin) behind
 * $lib/server/auth, so the page runs against Better Auth's own session rules —
 * among them the one-day "fresh session" gate on its list-sessions endpoint,
 * which production sessions (a year long) outgrow on day two.
 */
const { memory, auth } = await vi.hoisted(async () => {
  const { betterAuth } = await import('better-auth')
  const { memoryAdapter } = await import('better-auth/adapters/memory')
  const { passkey } = await import('@better-auth/passkey')
  const memory: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    passkey: [],
  }
  const auth = betterAuth({
    baseURL: 'http://localhost:4173',
    secret: 'passkeys-page-spec-secret-0123456789abcdef',
    database: memoryAdapter(memory),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    // Same lifetime as $lib/server/auth: a signed-in machine stays signed in.
    session: { expiresIn: 60 * 60 * 24 * 365, updateAge: 60 * 60 * 24 },
    plugins: [passkey({ rpID: 'localhost', rpName: 'spec' })],
    logger: { disabled: true },
  })
  return { memory, auth }
})
vi.mock('$lib/server/auth', () => ({ auth }))

const DAY = 24 * 60 * 60 * 1000
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

type Signed = { userId: string; sessionId: string; cookie: string }

async function signUp(email: string): Promise<Signed> {
  const res = await auth.api.signUpEmail({
    body: { email, password: 'spec-password-123', name: 'Spec' },
    headers: new Headers({ 'user-agent': CHROME_MAC }),
    returnHeaders: true,
  })
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')
  const session = memory.session.find((s) => s.userId === res.response.user.id)!
  return { userId: res.response.user.id, sessionId: session.id as string, cookie }
}

/** Make a session look like one signed in `days` ago (expiry stays far ahead). */
function age(sessionId: string, days: number) {
  const row = memory.session.find((s) => s.id === sessionId)!
  row.createdAt = new Date(Date.now() - days * DAY)
  row.updatedAt = new Date(Date.now() - days * DAY)
}

const event = (who: Signed | null) =>
  ({
    locals: {
      user: who ? { id: who.userId } : null,
      session: who ? { id: who.sessionId } : null,
    },
    url: new URL('http://localhost:4173/settings/passkeys'),
    request: new Request('http://localhost:4173/settings/passkeys', {
      headers: who ? { cookie: who.cookie } : {},
    }),
  }) as unknown as Parameters<typeof load>[0]

beforeEach(() => {
  for (const table of Object.values(memory)) table.length = 0
})
afterEach(() => vi.restoreAllMocks())

describe('/settings/passkeys — Passkeys & sessions', () => {
  it('redirects signed-out visitors to login', async () => {
    await expect(load(event(null))).rejects.toMatchObject({ status: 302 })
  })

  it('lists passkeys and sessions on the server — the page never waits on a client query', async () => {
    const me = await signUp('me@example.com')
    const other = memory.session.find((s) => s.id === me.sessionId)!
    memory.session.push({
      ...other,
      id: 's-other',
      token: 'other-token',
      userAgent: null,
      ipAddress: null,
      createdAt: new Date('2026-10-30T09:00:00Z'),
      updatedAt: new Date('2026-10-30T09:00:00Z'),
    })
    memory.passkey.push({
      id: 'pk1',
      name: null,
      publicKey: 'pk',
      userId: me.userId,
      credentialID: 'cred',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: null,
      aaguid: null,
      createdAt: new Date('2026-11-01T10:00:00Z'),
    })

    const here = memory.session.find((s) => s.id === me.sessionId)!
    here.ipAddress = '203.0.113.7'

    const data = await load(event(me))
    expect(data).toEqual({
      origin: 'http://localhost:4173',
      passkeys: [
        {
          id: 'pk1',
          name: 'Passkey',
          syncs: false,
          backedUp: false,
          createdAt: '2026-11-01T10:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: me.sessionId,
          current: true,
          device: 'Chrome on macOS',
          ipAddress: '203.0.113.7',
          signedInAt: (here.createdAt as Date).toISOString(),
          lastActive: (here.updatedAt as Date).toISOString(),
        },
        {
          id: 's-other',
          current: false,
          device: null,
          ipAddress: null,
          signedInAt: '2026-10-30T09:00:00.000Z',
          lastActive: '2026-10-30T09:00:00.000Z',
        },
      ],
    })
  })

  it('opens for a session signed in more than a day ago (production: 500 "Internal Error")', async () => {
    const me = await signUp('me@example.com')
    age(me.sessionId, 3)
    const data = await load(event(me))
    expect(data.sessions.map((s) => s.id)).toEqual([me.sessionId])
    expect(data.sessions[0].current).toBe(true)
  })

  it("shows only the signed-in user's own sessions that have not expired", async () => {
    const me = await signUp('me@example.com')
    const someone = await signUp('someone@example.com')
    const mine = memory.session.find((s) => s.id === me.sessionId)!
    memory.session.push({
      ...mine,
      id: 's-expired',
      token: 'expired-token',
      expiresAt: new Date(Date.now() - DAY),
    })
    const data = await load(event(me))
    expect(data.sessions.map((s) => s.id)).toEqual([me.sessionId])
    expect(data.sessions.map((s) => s.id)).not.toContain(someone.sessionId)
  })

  it('never sends a session token to the page', async () => {
    const me = await signUp('me@example.com')
    const data = await load(event(me))
    const token = memory.session.find((s) => s.id === me.sessionId)!.token as string
    expect(JSON.stringify(data)).not.toContain(token)
  })

  it('lets a failing list fail loud (error page), never an endless "Loading…"', async () => {
    const me = await signUp('me@example.com')
    vi.spyOn(auth.api, 'listPasskeys').mockRejectedValueOnce(new Error('db down'))
    await expect(load(event(me))).rejects.toThrow('db down')
  })
})
