import type { ToolContext, ToolDescriptor } from './types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalStore, newApprovalRequest, StaticApprovalPolicy } from './approvals'

function fakeTool(name: string): ToolDescriptor {
  return {
    name,
    module: name.split('.')[0],
    summary: 'test tool',
    inputSchema: z.object({}),
    permission: { roles: ['admin'] },
    auditClass: 'read',
    handler: async () => null,
  }
}

const ctx: ToolContext = {
  principal: { id: 'p1', kind: 'agent', roles: ['admin'] },
  requestId: 'req-1',
}

describe('StaticApprovalPolicy', () => {
  it('requires approval exactly for listed tools', () => {
    const policy = new StaticApprovalPolicy(new Set(['memory.wipe']))
    expect(policy.requiresApproval(fakeTool('memory.wipe'), ctx)).toBe(true)
    expect(policy.requiresApproval(fakeTool('memory.echo'), ctx)).toBe(false)
  })
})

describe('InMemoryApprovalStore lifecycle', () => {
  it('create -> pending, decide -> decided with metadata', async () => {
    const store = new InMemoryApprovalStore()
    const created = await store.create(
      newApprovalRequest({ toolName: 'memory.wipe', input: { value: 1 }, principalId: 'p1' }),
    )
    expect(created.status).toBe('pending')
    expect(await store.listPending()).toHaveLength(1)

    const decided = await store.decide(created.id, 'approved', 'the-owner')
    expect(decided.status).toBe('approved')
    expect(decided.decidedBy).toBe('the-owner')
    expect(decided.decidedAt).toBeDefined()
    expect(await store.listPending()).toHaveLength(0)
  })

  it('decide supports denial and throws on unknown ids', async () => {
    const store = new InMemoryApprovalStore()
    const created = await store.create(
      newApprovalRequest({ toolName: 'memory.wipe', input: null, principalId: 'p1' }),
    )
    await expect(store.decide(created.id, 'denied', 'the-owner')).resolves.toMatchObject({
      status: 'denied',
    })
    await expect(store.decide('missing', 'approved', 'the-owner')).rejects.toThrow(/unknown approval/)
  })

  it('latestFor returns the most recently created request for a tool+principal', async () => {
    const store = new InMemoryApprovalStore()
    const first = await store.create(
      newApprovalRequest({ toolName: 'memory.wipe', input: null, principalId: 'p1' }),
    )
    const second = await store.create(
      newApprovalRequest({ toolName: 'memory.wipe', input: null, principalId: 'p1' }),
    )
    await store.create(newApprovalRequest({ toolName: 'memory.wipe', input: null, principalId: 'p2' }))
    await store.create(newApprovalRequest({ toolName: 'memory.echo', input: null, principalId: 'p1' }))

    await expect(store.latestFor('memory.wipe', 'p1')).resolves.toMatchObject({ id: second.id })
    await expect(store.latestFor('memory.wipe', 'nobody')).resolves.toBeNull()
    await store.decide(first.id, 'denied', 'the-owner')
    await expect(store.latestFor('memory.wipe', 'p1')).resolves.toMatchObject({ id: second.id })
  })
})
