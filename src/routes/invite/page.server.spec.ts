import { describe, expect, it, vi } from 'vitest'

const { createOtp, signIn } = vi.hoisted(() => ({
  createOtp: vi.fn(async () => '424242'),
  signIn: vi.fn(async () => ({})),
}))

vi.mock('$lib/server/auth', () => ({ auth: { api: { createVerificationOTP: createOtp, signInEmailOTP: signIn } } }))
vi.mock('$lib/server/overview/sources', () => ({ foundingCompanyName: async () => 'Kindred' }))
vi.mock('$lib/server/members/db-store', async () => {
  const { memoryStore } = await import('$lib/server/members/memory-store')
  const { hashInviteToken } = await import('$lib/server/members/service')
  const s = memoryStore()
  s.invites.push({
    id: 'inv1',
    email: 'new@k.co',
    role: 'member',
    tokenHash: hashInviteToken('good'),
    invitedBy: 'o',
    expiresAt: new Date(Date.now() + 86_400_000),
    acceptedAt: null,
    createdAt: new Date(),
  })
  return { dbMemberStore: s }
})

const { actions, load } = await import('./+page.server')

const ev = (url: string, fields?: Record<string, string>, user: unknown = null) =>
  ({
    locals: { user },
    url: new URL(url),
    getClientAddress: () => '127.0.0.1',
    request: new Request(url, { method: 'POST', body: new URLSearchParams(fields ?? {}) }),
  }) as never

describe('/invite page', () => {
  it('a valid link shows who is invited and as what; a bad one says so plainly', async () => {
    expect(await load(ev('http://x/invite?token=good'))).toMatchObject({ ok: true, email: 'new@k.co', role: 'member', companyName: 'Kindred' })
    expect(await load(ev('http://x/invite?token=bad'))).toMatchObject({ ok: false, message: expect.stringMatching(/not valid/) })
  })

  it('signed in: the passkey step shows on ?step=passkey, anything else goes home', async () => {
    const me = { id: 'u', email: 'new@k.co' }
    expect(await load(ev('http://x/invite?step=passkey', undefined, me))).toMatchObject({ step: 'passkey', email: 'new@k.co' })
    await expect(load(ev('http://x/invite?token=good', undefined, me))).rejects.toMatchObject({ status: 302, location: '/' })
  })

  it('joins without any email: a server-minted code signs in, then on to the passkey step', async () => {
    await expect(actions.join(ev('http://x/invite', { token: 'good', name: 'Bea' }))).rejects.toMatchObject({
      status: 303,
      location: '/invite?step=passkey',
    })
    expect(createOtp).toHaveBeenCalledWith({ body: { email: 'new@k.co', type: 'sign-in' } })
    expect(signIn).toHaveBeenCalledWith({ body: { email: 'new@k.co', otp: '424242', name: 'Bea' }, headers: expect.any(Headers) })
  })

  it('refuses a bad link without minting a code', async () => {
    createOtp.mockClear()
    const out = (await actions.join(ev('http://x/invite', { token: 'bad', name: 'Bea' }))) as { status: number; data: { message: string } }
    expect(out.status).toBe(400)
    expect(out.data.message).toMatch(/not valid/)
    expect(createOtp).not.toHaveBeenCalled()
  })
})
