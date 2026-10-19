import { beforeEach, describe, expect, it, vi } from 'vitest'

const { isOwleryMailConfiguredMock, sendTransactionalEmailMock } = vi.hoisted(() => ({
  isOwleryMailConfiguredMock: vi.fn(),
  sendTransactionalEmailMock: vi.fn(),
}))

/** Company email lives in the database now; these values used to come from env. */
vi.mock('$lib/server/mail', () => ({
  companyMail: () => ({
    isConfigured: async () => isOwleryMailConfiguredMock(),
    send: (input: unknown) => sendTransactionalEmailMock(input),
  }),
}))

vi.mock('$lib/server/env/private-env', () => ({ env: {} }))


const { FEEDBACK_INBOX_EMAIL, assertFeedbackMailConfigured, sendFeedbackInboxEmail } =
  await import('./send-feedback-email')

describe('sendFeedbackInboxEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwleryMailConfiguredMock.mockReturnValue(true)
    sendTransactionalEmailMock.mockResolvedValue({ messageId: 'em_fb' })
  })

  it('exposes the product inbox address', () => {
    expect(FEEDBACK_INBOX_EMAIL).toBe('feedback@eigenenterprise.example')
  })

  it('assertFeedbackMailConfigured throws when company email is not set up', async () => {
    isOwleryMailConfiguredMock.mockReturnValue(false)
    await expect(assertFeedbackMailConfigured()).rejects.toThrow(/not set up/i)
  })

  it('sends to feedback@eigenenterprise.example with replyTo and escaped body', async () => {
    await sendFeedbackInboxEmail({
      feedbackId: 'fb-1',
      userId: 'u1',
      userEmail: 'alex@example.com',
      message: 'Hello <b>world</b> & thanks',
    })

    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1)
    const [input] = sendTransactionalEmailMock.mock.calls[0]
    expect(input.to).toBe('feedback@eigenenterprise.example')
    expect(input.replyTo).toBe('alex@example.com')
    expect(input.subject).toContain('Product feedback')
    expect(input.text).toContain('Hello <b>world</b> & thanks')
    expect(input.text).toContain('alex@example.com')
    expect(input.text).toContain('u1')
    expect(input.text).toContain('fb-1')
    expect(input.html).toContain('Hello &lt;b&gt;world&lt;/b&gt; &amp; thanks')
    expect(input.html).not.toContain('<b>world</b>')
  })

  it('propagates send failures (no silent swallow)', async () => {
    sendTransactionalEmailMock.mockRejectedValue(new Error('Owlery down'))
    await expect(
      sendFeedbackInboxEmail({
        feedbackId: 'fb-1',
        userId: 'u1',
        userEmail: 'alex@example.com',
        message: 'hi',
      }),
    ).rejects.toThrow(/Owlery down/)
  })
})
