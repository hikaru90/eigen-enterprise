import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Plain stand-in for the tagged-template pool: `answer` decides what the database does. */
let answer: () => Promise<unknown>
vi.mock('$lib/server/db', () => ({ appSql: () => answer() }))

const { GET } = await import('./+server')

describe('GET /api/health', () => {
  beforeEach(() => {
    answer = async () => [{ ok: 1 }]
  })

  it('is 200 when the database answers', async () => {
    const res = await GET({} as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('is 503 with the reason when the database does not answer', async () => {
    answer = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    const res = await GET({} as never)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'database: connect ECONNREFUSED' })
  })
})
