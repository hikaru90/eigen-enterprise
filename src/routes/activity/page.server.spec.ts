import { describe, expect, it } from 'vitest'
import { load } from './+page.server'

describe('activity page server', () => {
  it('redirects unauthenticated user', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 })
  })

  it('returns initial empty data', async () => {
    const data = await load({
      locals: { user: { id: 'u1', email: 'a@b.c' } },
      url: new URL('http://localhost/activity'),
    } as never)

    expect(data.calls).toEqual([])
    expect(data.totals).toEqual({
      baseCostUsd: '0.000000',
      markupUsd: '0.000000',
      totalCostUsd: '0.000000',
    })
    expect(data.overallTotals).toEqual({
      baseCostUsd: '0.000000',
      markupUsd: '0.000000',
      totalCostUsd: '0.000000',
    })
    expect(data.from).toBeNull()
    expect(data.to).toBeNull()
    expect(data.pagination).toEqual({
      page: 1,
      pageSize: 20,
      totalCount: 0,
      totalPages: 1,
      hasPrev: false,
      hasNext: false,
    })
  })
})
