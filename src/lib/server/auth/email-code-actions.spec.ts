import { describe, expect, it, vi } from 'vitest'

const { sendVerificationOTPMock, signInEmailOTPMock } = vi.hoisted(() => ({
  sendVerificationOTPMock: vi.fn(),
  signInEmailOTPMock: vi.fn(),
}))
vi.mock('$lib/server/auth', () => ({
  auth: { api: { sendVerificationOTP: sendVerificationOTPMock, signInEmailOTP: signInEmailOTPMock } },
}))
const { signInRefusalMock } = vi.hoisted(() => ({ signInRefusalMock: vi.fn(async (_email: string): Promise<string | null> => null) }))
vi.mock('./unclaimed', () => ({ signInRefusal: signInRefusalMock }))

const { requestCode, verifyCode } = await import('./email-code-actions')
const { recordDeliveryFailure } = await import('./deliver-code')

const event = (fields: Record<string, string>) =>
  ({ request: new Request('http://localhost/x', { method: 'POST', body: new URLSearchParams(fields) }) }) as never

describe('requestCode', () => {
  it('emails a sign-in code and moves to the code step', async () => {
    sendVerificationOTPMock.mockResolvedValue({ success: true })
    const out = await requestCode(event({ email: ' Owner@Kindred.Test ' }), { requireTerms: false })
    expect(sendVerificationOTPMock).toHaveBeenCalledWith({ body: { email: 'owner@kindred.test', type: 'sign-in' } })
    expect(out).toEqual({ step: 'code', email: 'owner@kindred.test', notice: 'We sent a 6-digit code to owner@kindred.test.' })
  })

  it('signup requires accepting the terms before any email is sent', async () => {
    sendVerificationOTPMock.mockClear()
    const out = (await requestCode(event({ email: 'a@b.co' }), { requireTerms: true })) as { status: number; data: { message: string } }
    expect(out.status).toBe(400)
    expect(out.data.message).toMatch(/Terms of Service/)
    expect(sendVerificationOTPMock).not.toHaveBeenCalled()
  })

  it('rejects an invalid email', async () => {
    const out = (await requestCode(event({ email: 'nope' }), { requireTerms: false })) as { status: number; data: { message: string } }
    expect(out.status).toBe(400)
    expect(out.data.message).toBe('Invalid email address')
  })

  it('surfaces a delivery failure instead of pretending a code was sent', async () => {
    sendVerificationOTPMock.mockRejectedValue(new Error('Email delivery is not configured on this server'))
    const out = (await requestCode(event({ email: 'a@b.co' }), { requireTerms: false })) as { status: number; data: { step: string; message: string } }
    expect(out.status).toBe(503)
    expect(out.data).toMatchObject({ step: 'email', message: 'Email delivery is not configured on this server' })
  })
})

describe('requestCode on a claimed server', () => {
  it('an address without an account gets the plain not-a-member answer and no code', async () => {
    sendVerificationOTPMock.mockClear()
    signInRefusalMock.mockResolvedValueOnce("You're not a member of Kindred yet. Ask the owner for an invite.")
    const out = (await requestCode(event({ email: 'Stranger@X.co' }), { requireTerms: false })) as { status: number; data: { step: string; message: string } }
    expect(signInRefusalMock).toHaveBeenCalledWith('stranger@x.co')
    expect(out.status).toBe(403)
    expect(out.data).toEqual({ step: 'email', email: 'stranger@x.co', message: "You're not a member of Kindred yet. Ask the owner for an invite." })
    expect(sendVerificationOTPMock).not.toHaveBeenCalled()
  })
})

describe('requestCode when Better Auth swallows the sender error', () => {
  it('still reports the failure instead of showing the code step', async () => {
    sendVerificationOTPMock.mockImplementation(async ({ body }: { body: { email: string } }) => {
      recordDeliveryFailure(body.email, new Error('Owlery 502'))
      return { success: true } // what Better Auth returns after logging the background error
    })
    const out = (await requestCode(event({ email: 'a@b.co' }), { requireTerms: false })) as { status: number; data: { step: string; message: string } }
    expect(out.status).toBe(503)
    expect(out.data).toMatchObject({ step: 'email', message: 'Owlery 502' })
  })
})

describe('verifyCode', () => {
  it('signs in (or up) with a valid code and redirects home', async () => {
    signInEmailOTPMock.mockResolvedValue({ token: 't' })
    await expect(verifyCode(event({ email: 'a@b.co', code: '123456' }))).rejects.toMatchObject({ status: 302, location: '/' })
    expect(signInEmailOTPMock).toHaveBeenCalledWith({ body: { email: 'a@b.co', otp: '123456' } })
  })

  it('rejects anything that is not six digits without calling Better Auth', async () => {
    signInEmailOTPMock.mockClear()
    const out = (await verifyCode(event({ email: 'a@b.co', code: '12ab' }))) as { status: number; data: { message: string } }
    expect(out.data.message).toBe('Enter the 6-digit code from the email')
    expect(signInEmailOTPMock).not.toHaveBeenCalled()
  })

  it('stays on the code step with the reason when the code is wrong or signup is closed', async () => {
    signInEmailOTPMock.mockRejectedValue(new Error('This company already has an owner. Ask them to invite you.'))
    const out = (await verifyCode(event({ email: 'x@y.co', code: '111111' }))) as { status: number; data: { step: string; message: string } }
    expect(out.status).toBe(400)
    expect(out.data).toMatchObject({ step: 'code', message: 'This company already has an owner. Ask them to invite you.' })
  })
})
