import type { RouteDeps } from './input-route'
import { describe, expect, it } from 'vitest'
import { memoryManifest } from './manifest'
import { createRouteTools } from './route-tools'

describe('memory.route_input', () => {
  it('is a memory registry action every member, the assistant and co-workers reach', () => {
    const [tool] = createRouteTools({ deps: async () => ({}) as RouteDeps })
    expect(tool).toMatchObject({ name: 'memory.route_input', module: 'memory', auditClass: 'mutate', permission: { roles: ['admin', 'member', 'agent'] } })
    expect(memoryManifest.tools).toContain('memory.route_input')
  })

  it('routes as the person it runs for', async () => {
    const filed: string[] = []
    const deps: RouteDeps = {
      decide: async () => ({ decisionId: 'd', choice: 'task', confidence: 0.95, distribution: { task: 0.95 } }),
      label: async () => {},
      file: async (route, userId) => {
        filed.push(`${route}:${userId}`)
        return { id: 't1', url: '/m/memory/tasks' }
      },
      unfile: async () => {},
    }
    const [tool] = createRouteTools({ deps: async () => deps, writerOf: async () => ({ kind: 'self', userId: 'ony' }) })
    const out = await tool!.handler({ principal: { id: 'ony', kind: 'human', roles: ['member'] }, requestId: 'r' } as never, { text: 'Send Acme the deck' })
    expect(out).toMatchObject({ outcome: 'filed', route: 'task', id: 't1' })
    expect(filed).toEqual(['task:ony'])
    await expect(tool!.handler({ principal: { id: 'ony', kind: 'human', roles: ['member'] }, requestId: 'r' } as never, { text: 'x', as: 'nope' })).rejects.toThrow()
  })
})
