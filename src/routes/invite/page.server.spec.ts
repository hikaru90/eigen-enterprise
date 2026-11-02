import { describe, expect, it, vi } from 'vitest'

const { sendOtp, signIn } = vi.hoisted(() => ({ sendOtp: vi.fn(async () => ({ success: true })), signIn: vi.fn(async () => ({})) }))

vi.mock('$lib/server/auth', () => ({ auth: { api: { sendVerificationOTP: sendOtp, signInEmailOTP: signIn } } }))
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

const ev = (url: string, fields?: Record<string, string>) =>
  ({
    locals: { user: null },
    url: new URL(url),
    request: new Request(url, { method: 'POST', body: new URLSearchParams(fields ?? {}) }),
  }) as never

describe('/invite page', () => {
  it('a valid link shows who is invited and as what; a bad one says so plainly', async () => {
    expect(await load(ev('http://x/invite?token=good'))).toMatchObject({ ok: true, email: 'new@k.co', role: 'member', companyName: 'Kindred' })
    expect(await load(ev('http://x/invite?token=bad'))).toMatchObject({ ok: false, message: expect.stringMatching(/not valid/) })
  })

  it('sends the code to the invited address, then signs in with it', async () => {
    expect(await actions.sendCode(ev('http://x/invite', { token: 'good' }))).toMatchObject({ step: 'code', email: 'new@k.co' })
    expect(sendOtp).toHaveBeenCalledWith({ body: { email: 'new@k.co', type: 'sign-in' } })
    await expect(actions.verifyCode(ev('http://x/invite', { token: 'good', code: '123456' }))).rejects.toMatchObject({ status: 303, location: '/' })
    expect(signIn).toHaveBeenCalledWith({ body: { email: 'new@k.co', otp: '123456' }, headers: expect.any(Headers) })
  })

  it('refuses a bad link without sending anything', async () => {
    sendOtp.mockClear()
    const out = (await actions.sendCode(ev('http://x/invite', { token: 'bad' }))) as { status: number }
    expect(out.status).toBe(400)
    expect(sendOtp).not.toHaveBeenCalled()
  })
})
