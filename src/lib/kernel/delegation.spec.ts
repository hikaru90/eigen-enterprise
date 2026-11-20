import type { ToolContext, ToolDescriptor } from './types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy, StaticApprovalPolicy } from './approvals'
import { InMemoryEventSink } from './events'
import {
  delegatedPrincipal,
  isDirectHuman,
  isViaBrain,
  principalRef,
  type PersonRef,
} from './principals'
import { KernelRegistry, type PrincipalScope } from './registry'

/**
 * CB3 (plan/phase-company-brain.md §7, §10): the company brain acts as the
 * person — their id and roles, never more — marked as arriving via the brain.
 * The registry is where that is enforced: permission, row-level-security
 * scope, event provenance, approvals and commit attribution all see the
 * person.
 */

const ann: PersonRef = { id: 'ann', roles: ['admin', 'member'] }
const ben: PersonRef = { id: 'ben', roles: ['member'] }
const viaBrain = (person: PersonRef): ToolContext => ({
  principal: delegatedPrincipal(person, 'orchestrator'),
  requestId: 'req-1',
})

function tool(overrides: Partial<ToolDescriptor> & Pick<ToolDescriptor, 'name'>): ToolDescriptor {
  return {
    module: overrides.name.split('.')[0]!,
    summary: overrides.name,
    auditClass: 'read',
    inputSchema: z.looseObject({}),
    permission: { roles: ['admin', 'agent'] },
    handler: async (ctx) => ({ ranAs: ctx.principal.id }),
    ...overrides,
  }
}

describe('the delegated principal', () => {
  it('is the person: their id and roles, kind human, marked via the brain', () => {
    const p = delegatedPrincipal(ben, 'orchestrator')
    expect(p).toEqual({ id: 'ben', kind: 'human', roles: ['member'], via: 'brain', agentId: 'orchestrator' })
    expect(isViaBrain(p)).toBe(true)
    // Not the person's own click: "human-only" guards refuse it.
    expect(isDirectHuman(p)).toBe(false)
    expect(isDirectHuman({ id: 'ben', kind: 'human', roles: ['member'] })).toBe(true)
    expect(principalRef(p)).toBe('human:ben via brain:orchestrator')
  })

  it('never exists without a person or an agent', () => {
    expect(() => delegatedPrincipal({ id: '', roles: [] }, 'orchestrator')).toThrow(
      expect.objectContaining({ code: 'no_person' }),
    )
    expect(() => delegatedPrincipal(null as unknown as PersonRef, 'orchestrator')).toThrow(
      expect.objectContaining({ code: 'no_person' }),
    )
    expect(() => delegatedPrincipal(ben, '')).toThrow(expect.objectContaining({ code: 'invalid_principal' }))
  })

  it('copies the roles: a later change to the person ref grants nothing', () => {
    const person = { id: 'ben', roles: ['member'] }
    const p = delegatedPrincipal(person, 'orchestrator')
    person.roles.push('admin')
    expect(p.roles).toEqual(['member'])
  })
})

describe('KernelRegistry — the brain acting as a person', () => {
  it('a non-admin member cannot execute an admin tool through the brain', async () => {
    const registry = new KernelRegistry()
    let ran = false
    registry.register(
      tool({
        name: 'website.publish_page',
        handler: async () => {
          ran = true
          return {}
        },
      }),
    )
    await expect(registry.execute('website.publish_page', {}, viaBrain(ben))).rejects.toMatchObject({
      code: 'permission_denied',
    })
    expect(ran).toBe(false)
    // The same tool runs for an admin acting through the brain.
    await expect(registry.execute('website.publish_page', {}, viaBrain(ann))).resolves.toEqual({})
  })

  it('a tool granted to members runs as the member through the brain', async () => {
    const registry = new KernelRegistry()
    registry.register(tool({ name: 'memory.retrieve_thoughts', permission: { roles: ['admin', 'member', 'agent'] } }))
    await expect(registry.execute('memory.retrieve_thoughts', {}, viaBrain(ben))).resolves.toEqual({ ranAs: 'ben' })
  })

  it('refuses a malformed principal (via without the brain agent, via on a non-person)', async () => {
    const registry = new KernelRegistry()
    registry.register(tool({ name: 'memory.read' }))
    for (const principal of [
      { id: 'ann', kind: 'human' as const, roles: ['admin'], via: 'brain' as const },
      { id: 'bot', kind: 'agent' as const, roles: ['admin'], via: 'brain' as const, agentId: 'orchestrator' },
      { id: 'ann', kind: 'human' as const, roles: ['admin'], agentId: 'orchestrator' },
    ]) {
      await expect(registry.execute('memory.read', {}, { principal, requestId: 'r' })).rejects.toMatchObject({
        code: 'invalid_principal',
      })
    }
  })

  it('event provenance shows the person and that the call came via the brain', async () => {
    const eventSink = new InMemoryEventSink()
    const registry = new KernelRegistry({ eventSink })
    registry.register(tool({ name: 'memory.read' }))

    await registry.execute('memory.read', {}, viaBrain(ann))
    await registry.execute('memory.read', {}, { principal: { id: 'ann', kind: 'human', roles: ['admin'] }, requestId: 'r' })

    const [brainCall, ownCall] = eventSink.events.filter((e) => e.type === 'tool.executed')
    expect(brainCall!.principalId).toBe('ann')
    expect(brainCall!.payload).toMatchObject({ tool: 'memory.read', ok: true, via: 'brain', agentId: 'orchestrator' })
    expect(ownCall!.principalId).toBe('ann')
    expect(ownCall!.payload).not.toHaveProperty('via')
    expect(ownCall!.payload).not.toHaveProperty('agentId')
  })

  it('an auto-approved gate records who asked and that it came via the brain', async () => {
    const eventSink = new InMemoryEventSink()
    const registry = new KernelRegistry({
      eventSink,
      approvalPolicy: new ModeAwareApprovalPolicy(new Set(['drive.write_text']), new InMemoryApprovalModeStore('allow_all')),
    })
    registry.register(
      tool({ name: 'drive.write_text', auditClass: 'mutate', approvalRisk: 'internal', activity: () => 'Wrote a file' }),
    )
    await registry.execute('drive.write_text', {}, viaBrain(ann))
    const auto = eventSink.events.find((e) => e.type === 'approval.auto_approved')!
    expect(auto.principalId).toBe('ann')
    expect(auto.payload).toMatchObject({ tool: 'drive.write_text', via: 'brain', agentId: 'orchestrator' })
  })

  it('approvals are asked by the person, and one person’s approval never lets another person’s call through', async () => {
    const approvalStore = new InMemoryApprovalStore()
    const registry = new KernelRegistry({
      approvalPolicy: new StaticApprovalPolicy(new Set(['drive.write_text'])),
      approvalStore,
    })
    registry.register(
      tool({
        name: 'drive.write_text',
        auditClass: 'mutate',
        permission: { roles: ['admin', 'member', 'agent'] },
        activity: () => 'Wrote a file',
      }),
    )

    await expect(registry.execute('drive.write_text', { f: 1 }, viaBrain(ann))).rejects.toMatchObject({
      code: 'approval_required',
    })
    const [asked] = await approvalStore.listPending()
    // Who asked: the person (the brain only carried the call).
    expect(asked).toMatchObject({ toolName: 'drive.write_text', principalId: 'ann', input: { f: 1 } })

    // Who must approve: an owner or admin decides it (recorded as decidedBy).
    await approvalStore.decide(asked!.id, 'approved', 'owner-1')
    await expect(registry.execute('drive.write_text', { f: 1 }, viaBrain(ann))).resolves.toEqual({ ranAs: 'ann' })

    // Ben's brain call is his own request: Ann's approval does not cover it.
    await expect(registry.execute('drive.write_text', { f: 1 }, viaBrain(ben))).rejects.toMatchObject({
      code: 'approval_required',
    })
    expect((await approvalStore.listPending()).map((r) => r.principalId)).toEqual(['ben'])
  })

  it('commits a mutate as the person via the brain', async () => {
    const messages: string[] = []
    const registry = new KernelRegistry({
      vcsCommitter: { commit: async (message) => (messages.push(message), 'abc') },
    })
    registry.register(tool({ name: 'drive.write_text', auditClass: 'mutate', activity: () => 'Wrote a file' }))
    await registry.execute('drive.write_text', {}, viaBrain(ann))
    expect(messages).toEqual(['tool drive.write_text by ann via brain:orchestrator'])
  })

  it('runs every handler inside the principal’s scope (row-level security), as that principal', async () => {
    const scoped: string[] = []
    const scope: PrincipalScope = async (principal, run) => {
      scoped.push(principalRef(principal))
      return run()
    }
    const registry = new KernelRegistry({ principalScope: scope })
    registry.register(tool({ name: 'memory.read', permission: { roles: ['member'] } }))
    await registry.execute('memory.read', {}, viaBrain(ben))
    // A refused call never opens a scope.
    await expect(
      registry.execute('memory.read', {}, { principal: { id: 'x', kind: 'agent', roles: ['agent'] }, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    expect(scoped).toEqual(['human:ben via brain:orchestrator'])
  })
})
