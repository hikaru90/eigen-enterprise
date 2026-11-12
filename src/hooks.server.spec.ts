import { afterEach, describe, expect, it, vi } from 'vitest'

// `building` keeps the module's boot side effects (tickers, bootApp) from running on import.
vi.mock('$app/environment', () => ({ building: true, dev: false, browser: false, version: 'test' }))

const { captureServerException } = vi.hoisted(() => ({ captureServerException: vi.fn() }))
vi.mock('$lib/server/analytics/posthog-server', () => ({ captureServerException }))
vi.mock('$lib/server/auth', () => ({ auth: { api: {} } }))
vi.mock('$lib/server/db', () => ({
  appSql: {},
  appDbAsyncLocal: {},
  createScopedDrizzle: vi.fn(),
  activateTenantDbSession: vi.fn(),
  deactivateTenantDbSession: vi.fn(),
}))
vi.mock('$lib/server/db/auth-db', () => ({ authSql: vi.fn() }))

const { handleError } = await import('./hooks.server')

type ErrorInput = Parameters<typeof handleError>[0]

const SECRET_COOKIE = 'better-auth.session_token=sess-cookie-value'
const SECRET_QUERY = 'otp-in-query-123'

function input(error: unknown, status: number): ErrorInput {
  return {
    error,
    status,
    message: 'Internal Error',
    event: {
      locals: { user: { id: 'u1' } },
      url: new URL(`https://os.example.com/settings/passkeys?token=${SECRET_QUERY}`),
      route: { id: '/(nucleus)/settings/passkeys' },
      request: new Request(`https://os.example.com/settings/passkeys?token=${SECRET_QUERY}`, {
        method: 'GET',
        headers: { cookie: SECRET_COOKIE, authorization: 'Bearer key-value-456' },
      }),
    },
  } as unknown as ErrorInput
}

function logged(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((args: unknown[]) => args.map(String).join(' ')).join('\n')
}

describe('handleError — unexpected server errors reach the server log', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    captureServerException.mockClear()
  })

  it('logs the error with its stack, the status, the route id and the path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('Session is not fresh')
    await handleError(input(error, 500))

    expect(spy).toHaveBeenCalledTimes(1)
    const line = logged(spy)
    expect(line).toContain('500')
    expect(line).toContain('GET')
    expect(line).toContain('/(nucleus)/settings/passkeys')
    expect(line).toContain('/settings/passkeys')
    expect(line).toContain('Error: Session is not fresh')
    expect(line).toContain(error.stack!.split('\n')[1].trim())
  })

  it('never logs cookies, headers or the query string', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleError(input(new Error('boom'), 500))
    const line = logged(spy)
    expect(line).not.toContain('sess-cookie-value')
    expect(line).not.toContain('key-value-456')
    expect(line).not.toContain(SECRET_QUERY)
  })

  it('logs the cause chain of a wrapped error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleError(input(new Error('outer', { cause: new TypeError('inner reason') }), 500))
    const line = logged(spy)
    expect(line).toContain('Error: outer')
    expect(line).toContain('TypeError: inner reason')
  })

  it('logs a thrown non-Error value by its type, not its contents', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleError(input({ password: 'hunter2' }, 500))
    const line = logged(spy)
    expect(line).toContain('non-Error value (object)')
    expect(line).not.toContain('hunter2')
  })

  it('keeps capturing to PostHog', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new Error('boom')
    await handleError(input(error, 500))
    expect(captureServerException).toHaveBeenCalledWith(error, 'u1', {
      status: 500,
      path: '/settings/passkeys',
      route_id: '/(nucleus)/settings/passkeys',
    })
  })

  it('stays quiet for 404s (unmatched paths are not server faults)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await handleError(input(new Error('Not found: /nope'), 404))
    expect(spy).not.toHaveBeenCalled()
    expect(captureServerException).not.toHaveBeenCalled()
  })
})
