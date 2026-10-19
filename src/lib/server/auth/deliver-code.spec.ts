import { describe, expect, it, vi } from 'vitest'
import { deliverSignInCode, EmailDeliveryNotConfiguredError, signInCodeEmail } from './deliver-code'

describe('deliverSignInCode', () => {
  it('sends the code by email when mail is configured', async () => {
    const send = vi.fn(async () => undefined)
    await deliverSignInCode({ email: 'a@b.co', otp: '123456' }, { mailConfigured: true, dev: false, send, log: vi.fn(), record: vi.fn() })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'a@b.co', subject: 'Your Eigen Enterprise code: 123456' }))
  })

  it('fails loudly in production when no mail delivery is configured (never logs the code)', async () => {
    const log = vi.fn()
    await expect(
      deliverSignInCode({ email: 'a@b.co', otp: '123456' }, { mailConfigured: false, dev: false, send: vi.fn(), log, record: vi.fn() }),
    ).rejects.toBeInstanceOf(EmailDeliveryNotConfiguredError)
    expect(log).not.toHaveBeenCalled()
  })

  it('in dev without mail, prints the code to the terminal and records it for the e2e harness', async () => {
    const log = vi.fn()
    const record = vi.fn()
    await deliverSignInCode({ email: 'a@b.co', otp: '654321' }, { mailConfigured: false, dev: true, send: vi.fn(), log, record })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('654321'))
    expect(record).toHaveBeenCalledWith('a@b.co', '654321')
  })

  it('a send failure propagates (the form shows it) instead of pretending the code went out', async () => {
    const send = vi.fn(async () => {
      throw new Error('Owlery 502')
    })
    await expect(
      deliverSignInCode({ email: 'a@b.co', otp: '1' }, { mailConfigured: true, dev: false, send, log: vi.fn(), record: vi.fn() }),
    ).rejects.toThrow('Owlery 502')
  })
})

describe('signInCodeEmail', () => {
  it('carries the code in text and html', () => {
    const m = signInCodeEmail('a@b.co', '987654')
    expect(m.text).toContain('987654')
    expect(m.html).toContain('987654')
  })
})
