import type { ToolContext } from './types'
import { describe, expect, it, vi } from 'vitest'
import { createPatternTools, type PatternsPort } from './pattern-tools'

const empty = { digestId: null, createdAt: null, windowStart: null, windowEnd: null, items: [] }
const ctx = (roles: string[]): ToolContext => ({ principal: { id: 'ann', kind: 'human', roles }, requestId: 'r' })

function tools(port: PatternsPort) {
  const [read, refresh] = createPatternTools({ port })
  return { read, refresh }
}

describe('dashboard.patterns tools', () => {
  it('the read passes the caller roles to the filter', async () => {
    const view = vi.fn(async () => empty)
    const { read } = tools({ view, refresh: vi.fn() })
    expect(read.name).toBe('dashboard.patterns')
    expect(read.auditClass).toBe('read')
    await read.handler(ctx(['member']), {})
    expect(view).toHaveBeenCalledWith(['member'])
  })

  it('refresh writes a digest, then returns it as the caller may see it', async () => {
    const order: string[] = []
    const port: PatternsPort = {
      refresh: async () => void order.push('refresh'),
      view: async () => (order.push('view'), empty),
    }
    const { refresh } = tools(port)
    expect(refresh.auditClass).toBe('mutate')
    expect(refresh.activity?.({}, undefined)).toMatch(/What's happening/)
    await refresh.handler(ctx(['admin']), {})
    expect(order).toEqual(['refresh', 'view'])
  })
})
