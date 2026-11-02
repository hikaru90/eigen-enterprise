import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { authDbSelectMock, isOwleryMailConfiguredMock, sendTransactionalEmailMock } = vi.hoisted(
  () => ({
    authDbSelectMock: vi.fn(),
    isOwleryMailConfiguredMock: vi.fn(),
    sendTransactionalEmailMock: vi.fn(),
  }),
)

/** Company email lives in the database now; these values used to come from env. */
vi.mock('$lib/server/mail', () => ({
  companyMail: () => ({
    isConfigured: async () => isOwleryMailConfiguredMock(),
    send: (input: unknown) => sendTransactionalEmailMock(input),
  }),
}))

vi.mock('$lib/server/env/private-env', () => ({
  env: {
    ORIGIN: 'https://eigen.example',
  },
}))

vi.mock('$lib/server/db/auth-db', () => ({
  authDb: { select: authDbSelectMock },
}))

vi.mock('$lib/server/db/auth.schema', () => ({
  user: { id: 'id', email: 'email' },
}))


const { queueNotificationEmail } = await import('./notification-email')

function selectReturning(rows: { email?: string }[]) {
  const limit = vi.fn(async () => rows)
  const where = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ where }))
  authDbSelectMock.mockReturnValue({ from })
  return { limit, where, from }
}

const PAYLOAD = {
  title: 'Appointment',
  body: 'In 30 min · Dentist',
  url: '/m/memory/tasks?event=te1',
  tag: 'event-te1-30',
}

describe('queueNotificationEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwleryMailConfiguredMock.mockReturnValue(true)
    sendTransactionalEmailMock.mockResolvedValue({ messageId: 'em_1' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('no-ops when company email is not set up', async () => {
    isOwleryMailConfiguredMock.mockReturnValue(false)
    selectReturning([])

    await queueNotificationEmail('u1', PAYLOAD)

    expect(authDbSelectMock).not.toHaveBeenCalled()
    expect(sendTransactionalEmailMock).not.toHaveBeenCalled()
  })

  it('no-ops when the user has no email row', async () => {
    selectReturning([])

    await queueNotificationEmail('u1', PAYLOAD)

    expect(sendTransactionalEmailMock).not.toHaveBeenCalled()
  })

  it('sends a transactional email with absolute URL and escaped body', async () => {
    selectReturning([{ email: 'user@example.com' }])

    await queueNotificationEmail('u1', {
      title: 'Daily',
      body: 'A <b>summary</b> & more',
      url: '/m/memory/tasks',
      tag: 'daily-summary-2026-01-01',
    })

    expect(sendTransactionalEmailMock).toHaveBeenCalledTimes(1)
    const [input] = sendTransactionalEmailMock.mock.calls[0]
    expect(input.to).toBe('user@example.com')
    expect(input.subject).toBe('[Eigen] Daily')
    expect(input.text).toContain('Open: https://eigen.example/m/memory/tasks')
    expect(input.html).toContain('https://eigen.example/m/memory/tasks')
    expect(input.html).toContain('A &lt;b&gt;summary&lt;/b&gt; &amp; more')
  })

  it('logs and swallows send failures (best-effort, never throws)', async () => {
    selectReturning([{ email: 'user@example.com' }])
    sendTransactionalEmailMock.mockRejectedValue(new Error('smtp down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(queueNotificationEmail('u1', PAYLOAD)).resolves.toBeUndefined()

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[notification-email]'),
      expect.objectContaining({ userId: 'u1', to: 'user@example.com' }),
    )
    errSpy.mockRestore()
  })

  it('keeps already-absolute URLs unchanged', async () => {
    selectReturning([{ email: 'user@example.com' }])

    await queueNotificationEmail('u1', { title: 'T', body: 'B', url: 'https://other.example/x' })

    const input = sendTransactionalEmailMock.mock.calls[0][0]
    expect(input.text).toContain('Open: https://other.example/x')
  })
})
