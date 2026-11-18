import { describe, expect, it, vi } from 'vitest'

const { claimCompany, claimStatus } = vi.hoisted(() => ({
  claimCompany: vi.fn(async () => {}),
  claimStatus: vi.fn(async (): Promise<string> => 'ok'),
}))

vi.mock('$lib/server/auth', () => ({ auth: { api: {} } }))
vi.mock('$lib/server/db/auth-db', () => ({ authDb: {} }))
vi.mock('$lib/server/env/private-env', () => ({ env: {} }))
vi.mock('$lib/server/overview/sources', () => ({ foundingCompanyName: async () => 'Kindred' }))
vi.mock('$lib/server/auth/claim', () => ({
  claimCompany,
  claimStatus,
  claimConfigFromEnv: () => ({}),
  claimMessage: (s: string) => `message for ${s}`,
  ClaimError: class ClaimError extends Error {},
}))

const { actions, load } = await import('./+page.server')

const ev = (url: string, fields?: Record<string, string>, user: unknown = null) =>
  ({
    locals: { user },
    url: new URL(url),
    getClientAddress: () => '127.0.0.1',
    request: new Request(url, { method: 'POST', body: new URLSearchParams(fields ?? {}) }),
  }) as never

describe('/claim page', () => {
  it('claiming signs the owner in and goes on to the passkey step (the way back in without email)', async () => {
    await expect(actions.default(ev('http://x/claim', { token: 't', email: 'o@k.co' }))).rejects.toMatchObject({
      status: 303,
      location: '/claim?step=passkey',
    })
    expect(claimCompany).toHaveBeenCalledWith({ email: 'o@k.co', token: 't' }, expect.anything())
  })

  it('signed in: the passkey step shows on ?step=passkey with the account email', async () => {
    const me = { id: 'u', email: 'o@k.co' }
    expect(await load(ev('http://x/claim?step=passkey', undefined, me))).toMatchObject({ step: 'passkey', email: 'o@k.co', companyName: 'Kindred' })
  })

  it('the passkey step needs a session: signed out it is the ordinary claim page', async () => {
    claimStatus.mockResolvedValueOnce('already_claimed')
    expect(await load(ev('http://x/claim?step=passkey'))).toMatchObject({ step: 'claim', ok: false, message: 'message for already_claimed' })
  })

  it('an already claimed company sends a signed-in visitor home', async () => {
    claimStatus.mockResolvedValueOnce('already_claimed')
    await expect(load(ev('http://x/claim?token=t', undefined, { id: 'u', email: 'o@k.co' }))).rejects.toMatchObject({ status: 302, location: '/' })
  })
})
