import { describe, expect, it } from 'vitest'
import { FRESH_SESSION_PATHS, needsFreshSignIn } from './fresh-session'

const now = new Date('2026-11-19T12:00:00Z')
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000)

describe('needsFreshSignIn', () => {
  it('a session signed in within the last day is fresh', () => {
    expect(needsFreshSignIn({ signedInAt: hoursAgo(23), now, mailConfigured: true })).toBe(false)
  })

  it('an older session must sign in again when a code can reach the inbox', () => {
    expect(needsFreshSignIn({ signedInAt: hoursAgo(25), now, mailConfigured: true })).toBe(true)
  })

  it('without company email there is no way to sign in again: the session itself is the proof (no lock-out)', () => {
    expect(needsFreshSignIn({ signedInAt: hoursAgo(24 * 30), now, mailConfigured: false })).toBe(false)
  })

  it('guards adding a passkey and unlinking a sign-in method', () => {
    expect(FRESH_SESSION_PATHS).toEqual(['/passkey/generate-register-options', '/unlink-account'])
  })
})

describe('freshSessionHook in a real Better Auth (memory adapter + passkey plugin)', async () => {
  const { betterAuth } = await import('better-auth')
  const { memoryAdapter } = await import('better-auth/adapters/memory')
  const { passkey } = await import('@better-auth/passkey')
  const { freshSessionHook } = await import('./fresh-session')
  const memory: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [], passkey: [] }
  let mail = true
  const auth = betterAuth({
    baseURL: 'http://localhost:4173',
    secret: 'fresh-session-spec-secret-0123456789abcdef',
    database: memoryAdapter(memory),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    session: { expiresIn: 60 * 60 * 24 * 365, updateAge: 60 * 60 * 24, freshAge: 0 },
    hooks: { before: freshSessionHook(async () => mail) },
    plugins: [passkey({ rpID: 'localhost', rpName: 'spec' })],
    logger: { disabled: true },
  })

  async function signedInDaysAgo(days: number): Promise<Headers> {
    const res = await auth.api.signUpEmail({
      body: { email: `u${Math.random()}@example.com`, password: 'spec-password-123', name: 'Spec' },
      returnHeaders: true,
    })
    const row = memory.session.find((s) => s.userId === res.response.user.id)!
    row.createdAt = new Date(Date.now() - days * 86_400_000)
    return new Headers({ cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') })
  }
  const registerOptions = (headers: Headers) => auth.api.generatePasskeyRegistrationOptions({ headers })

  it('with email set up, a two-day-old sign-in is asked to confirm before adding a passkey', async () => {
    mail = true
    await expect(registerOptions(await signedInDaysAgo(2))).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'SESSION_NOT_FRESH' },
    })
  })

  it('with email set up, a sign-in from today adds a passkey', async () => {
    mail = true
    await expect(registerOptions(await signedInDaysAgo(0))).resolves.toMatchObject({ challenge: expect.any(String) })
  })

  it('without email, a month-old sign-in still adds a passkey (it is the only way in)', async () => {
    mail = false
    await expect(registerOptions(await signedInDaysAgo(30))).resolves.toMatchObject({ challenge: expect.any(String) })
  })
})
