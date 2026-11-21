import { describe, expect, it, vi } from 'vitest'

const { parseDateRangePhraseMock } = vi.hoisted(() => ({
  parseDateRangePhraseMock: vi.fn(),
}))

vi.mock('$lib/server/memory/parse-date-range', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/memory/parse-date-range')>()
  return {
    ...actual,
    parseDateRangePhrase: parseDateRangePhraseMock,
  }
})

import { POST } from './+server'

function mockEvent(user: { id: string } | null, body: unknown) {
  return {
    locals: { user },
    request: {
      json: async () => body,
    },
  } as Parameters<typeof POST>[0]
}

describe('POST /api/timeline/parse-date-range', () => {
  it('returns 401 when unauthenticated', async () => {
    expect((await POST(mockEvent(null, { phrase: 'last week' }))).status).toBe(401)
  })

  it('returns parsed range for a phrase', async () => {
    parseDateRangePhraseMock.mockResolvedValueOnce({
      from: '2026-07-14T00:00:00.000Z',
      to: '2026-07-20T23:59:59.999Z',
      includeUndated: false,
      label: 'Last week',
    })

    const res = await POST(
      mockEvent(
        { id: 'u1' },
        { phrase: 'last week', nowIso: '2026-07-21T12:00:00.000Z', timeZone: 'UTC' },
      ),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      from: '2026-07-14T00:00:00.000Z',
      to: '2026-07-20T23:59:59.999Z',
      includeUndated: false,
      label: 'Last week',
    })
    expect(parseDateRangePhraseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        phrase: 'last week',
        nowIso: '2026-07-21T12:00:00.000Z',
        timeZone: 'UTC',
      }),
    )
  })

  it('rejects empty phrase', async () => {
    expect((await POST(mockEvent({ id: 'u1' }, { phrase: '  ' }))).status).toBe(400)
  })

  it('returns JSON 502 when the shared LLM gateway fails (not an uncaught throw)', async () => {
    parseDateRangePhraseMock.mockRejectedValueOnce(new Error('LLM HTTP 502: bad gateway'))

    const res = await POST(
      mockEvent(
        { id: 'u1' },
        { phrase: 'last tuesday to today', nowIso: '2026-07-21T12:00:00.000Z', timeZone: 'UTC' },
      ),
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({
      error: 'Date parsing is temporarily unavailable. Try Last week / Last month, or try again.',
      agent: {
        attempted: 'Parsing a typed date range for the timeline filter',
        cause: 'LLM HTTP 502: bad gateway',
      },
    })
  })

  it('returns JSON 500 for non-gateway LLM failures', async () => {
    parseDateRangePhraseMock.mockRejectedValueOnce(new Error('Invalid date range LLM response: x'))

    const res = await POST(
      mockEvent(
        { id: 'u1' },
        { phrase: 'yesterday', nowIso: '2026-07-21T12:00:00.000Z', timeZone: 'UTC' },
      ),
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      error: 'Invalid date range LLM response: x',
      agent: { attempted: 'Parsing a typed date range for the timeline filter' },
    })
  })
})
