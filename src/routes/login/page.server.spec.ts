import { describe, expect, it, vi } from 'vitest'
import { actions, load } from './+page.server'

const { requestCodeMock, verifyCodeMock, isOwleryMailConfiguredMock } = vi.hoisted(() => ({
  requestCodeMock: vi.fn(async () => ({ step: 'code', email: 'a@b.co', notice: 'sent' })),
  verifyCodeMock: vi.fn(async () => ({})),
  isOwleryMailConfiguredMock: vi.fn(() => false),
}))
vi.mock('$lib/server/auth/email-code-actions', () => ({
  requestCode: requestCodeMock,
  verifyCode: verifyCodeMock,
}))
vi.mock('$lib/server/owlery/mail', () => ({
  isOwleryMailConfigured: isOwleryMailConfiguredMock,
}))

describe('login page server', () => {
  it('exposes mailConfigured for forgot-password / resend UI', () => {
    isOwleryMailConfiguredMock.mockReturnValue(true)
    const data = load({
      locals: { user: null },
      url: new URL('http://localhost/login'),
    } as never)
    expect(data).toMatchObject({ mailConfigured: true })
  })

  it('passwordless: sendCode (no terms on login), verifyCode signs in', async () => {
    const event = { request: new Request('http://localhost/login', { method: 'POST' }) } as never
    await actions.sendCode(event)
    expect(requestCodeMock).toHaveBeenCalledWith(event, { requireTerms: false })
    await actions.verifyCode(event)
    expect(verifyCodeMock).toHaveBeenCalledWith(event)
    expect(Object.keys(actions).sort()).toEqual(['sendCode', 'verifyCode'])
  })
})
