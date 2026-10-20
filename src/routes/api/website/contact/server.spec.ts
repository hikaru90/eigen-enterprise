import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleContactSubmitMock, defaultWebsiteStoreMock, bootstrapKernelMock } = vi.hoisted(() => ({
  handleContactSubmitMock: vi.fn(),
  defaultWebsiteStoreMock: vi.fn(),
  bootstrapKernelMock: vi.fn(),
}))

vi.mock('../../../../../modules/website/contact', () => ({
  handleContactSubmit: handleContactSubmitMock,
}))

vi.mock('../../../../../modules/website/store', () => ({
  defaultWebsiteStore: defaultWebsiteStoreMock,
}))

vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
vi.mock('../../../../../modules/index', () => ({
  bootstrapKernel: bootstrapKernelMock,
}))

import { isApiErrorBody } from '$lib/server/http/api-error'
import { GET, POST } from './+server'

function postEvent(body: string | unknown) {
  return {
    request: new Request('http://localhost/api/website/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  } as Parameters<typeof POST>[0]
}

describe('POST /api/website/contact', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bootstrapKernelMock.mockReturnValue({ eventSink: { emit: vi.fn() } })
    defaultWebsiteStoreMock.mockReturnValue({ createContact: vi.fn() })
    handleContactSubmitMock.mockResolvedValue({ id: 'contact-1' })
  })

  it('returns 201 with the captured contact id', async () => {
    const res = await POST(postEvent({ email: 'jane@example.com', message: 'Hi' }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'contact-1' })
  })

  it('hands the raw body, the default store, and the kernel event sink to handleContactSubmit', async () => {
    const body = { email: 'jane@example.com' }
    const sink = { emit: vi.fn() }
    bootstrapKernelMock.mockReturnValue({ eventSink: sink })
    const store = { createContact: vi.fn() }
    defaultWebsiteStoreMock.mockReturnValue(store)

    await POST(postEvent(body))

    expect(handleContactSubmitMock).toHaveBeenCalledTimes(1)
    const [rawInput, deps] = handleContactSubmitMock.mock.calls[0]
    expect(rawInput).toEqual(body)
    expect(deps.store).toBe(store)
    expect(deps.eventSink).toBe(sink)
  })

  it('rejects invalid JSON with 400 without touching the handler', async () => {
    const res = await POST(postEvent('not-json'))
    expect(res.status).toBe(400)
    expect(isApiErrorBody(await res.json())).toBe(true)
    expect(handleContactSubmitMock).not.toHaveBeenCalled()
  })

  it('maps zod validation failures to a 400 JSON error', async () => {
    const { ZodError } = await import('zod')
    const zodError = new ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['email'],
        message: 'Required',
      },
    ])
    handleContactSubmitMock.mockRejectedValue(zodError)

    const res = await POST(postEvent({}))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(isApiErrorBody(body)).toBe(true)
    expect(body.error).toMatch(/email/)
  })

  it('lets kernel/store failures propagate loud (no silent 4xx)', async () => {
    handleContactSubmitMock.mockRejectedValue(new Error('kernel unavailable'))
    await expect(POST(postEvent({ email: 'a@example.com' }))).rejects.toThrow('kernel unavailable')
  })
})

describe('GET /api/website/contact', () => {
  it('rejects with 405', async () => {
    await expect(GET({} as Parameters<typeof GET>[0])).rejects.toMatchObject({
      status: 405,
    })
  })
})
