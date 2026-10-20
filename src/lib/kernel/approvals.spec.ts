import type { ToolContext, ToolDescriptor } from './types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
  newApprovalRequest,
  StaticApprovalPolicy,
  type ApprovalMode,
} from './approvals'

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

describe('ModeAwareApprovalPolicy', () => {
  const gated = new Set(['email.send_mail', 'memory.note'])
  const external = { ...fakeTool('email.send_mail'), approvalRisk: 'external' as const }
  const internal = { ...fakeTool('memory.note'), approvalRisk: 'internal' as const }
  const ungated = fakeTool('memory.echo')
  const policy = (mode: ApprovalMode) =>
    new ModeAwareApprovalPolicy(gated, new InMemoryApprovalModeStore(mode))

  it('ask: exactly the gated list waits', async () => {
    expect(await policy('ask').decide(external, ctx)).toBe('require')
    expect(await policy('ask').decide(internal, ctx)).toBe('require')
    expect(await policy('ask').decide(ungated, ctx)).toBe('pass')
  })

  it('reasonable: only a declared internal risk runs without approval', async () => {
    expect(await policy('reasonable').decide(external, ctx)).toBe('require')
    for (const risk of ['public', 'destructive'] as const) {
      expect(await policy('reasonable').decide({ ...external, approvalRisk: risk }, ctx)).toBe('require')
    }
    expect(await policy('reasonable').decide(internal, ctx)).toBe('auto_approved')
    expect(await policy('reasonable').decide(ungated, ctx)).toBe('pass')
  })

  it('allow_all: nothing waits; gated tools are auto-approved (recorded), others pass', async () => {
    expect(await policy('allow_all').decide(external, ctx)).toBe('auto_approved')
    expect(await policy('allow_all').decide(internal, ctx)).toBe('auto_approved')
    expect(await policy('allow_all').decide(ungated, ctx)).toBe('pass')
  })

  it('reads the mode on every decision (owner changes take effect immediately)', async () => {
    const store = new InMemoryApprovalModeStore('ask')
    const p = new ModeAwareApprovalPolicy(gated, store)
    expect(await p.decide(external, ctx)).toBe('require')
    await store.set('allow_all', 'owner')
    expect(await p.decide(external, ctx)).toBe('auto_approved')
  })

  it('a gated tool with no declared approvalRisk fails validation', () => {
    expect(() => policy('ask').validateTool(fakeTool('email.send_mail'))).toThrow(/approvalRisk/)
    expect(() => policy('ask').validateTool(ungated)).not.toThrow()
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
