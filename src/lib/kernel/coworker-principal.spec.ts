import type { ToolPrincipal } from './types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { KernelError } from './errors'
import {
  actsAsMember,
  assertWellFormedPrincipal,
  coworkerPrincipal,
  delegatedPrincipal,
  isDirectHuman,
  isViaBrain,
  principalRef,
} from './principals'
import { KernelRegistry } from './registry'

/** AI co-workers (plan/phase-ai-coworkers.md §3): a co-worker is its own principal kind, scoped like a member. */
describe('coworkerPrincipal', () => {
  it('is the co-worker user id, kind coworker, member rights only, with the agent it runs as', () => {
    expect(coworkerPrincipal('cw_1', 'coworker:cw_1')).toEqual({
      id: 'cw_1',
      kind: 'coworker',
      roles: ['member'],
      agentId: 'coworker:cw_1',
    })
  })

  it('fails loud without a user id or an agent id', () => {
    expect(() => coworkerPrincipal('', 'a')).toThrow(KernelError)
    expect(() => coworkerPrincipal('cw_1', ' ')).toThrow(KernelError)
  })

  it('is never the brain acting for a person, and never a person at their keyboard', () => {
    const p = coworkerPrincipal('cw_1', 'coworker:cw_1')
    expect(isViaBrain(p)).toBe(false)
    expect(isDirectHuman(p)).toBe(false)
    expect(principalRef(p)).toBe('coworker:cw_1')
  })
})

describe('actsAsMember', () => {
  const human: ToolPrincipal = { id: 'ann', kind: 'human', roles: ['member'] }
  it('is true for a person (directly or via the brain) and for a co-worker', () => {
    expect(actsAsMember(human)).toBe(true)
    expect(actsAsMember(delegatedPrincipal({ id: 'ann', roles: ['member'] }, 'orchestrator'))).toBe(true)
    expect(actsAsMember(coworkerPrincipal('cw_1', 'coworker:cw_1'))).toBe(true)
  })
  it('is false for agents and services', () => {
    expect(actsAsMember({ id: 'orchestrator', kind: 'agent', roles: ['agent'] })).toBe(false)
    expect(actsAsMember({ id: 'system', kind: 'service', roles: ['admin'] })).toBe(false)
  })
})

describe('assertWellFormedPrincipal with co-workers', () => {
  it('accepts a co-worker carrying its agent id', () => {
    expect(() => assertWellFormedPrincipal(coworkerPrincipal('cw_1', 'coworker:cw_1'))).not.toThrow()
  })
  it('refuses a co-worker without its agent id', () => {
    expect(() => assertWellFormedPrincipal({ id: 'cw_1', kind: 'coworker', roles: ['member'] })).toThrow(KernelError)
  })
  it('refuses `via` on a co-worker: only a person is acted for through the brain', () => {
    expect(() =>
      assertWellFormedPrincipal({ id: 'cw_1', kind: 'coworker', roles: ['member'], via: 'brain', agentId: 'orchestrator' }),
    ).toThrow(KernelError)
  })
  it('still refuses an agent id on an agent or a service', () => {
    expect(() => assertWellFormedPrincipal({ id: 'x', kind: 'agent', roles: [], agentId: 'y' })).toThrow(KernelError)
    expect(() => assertWellFormedPrincipal({ id: 'x', kind: 'service', roles: [], agentId: 'y' })).toThrow(KernelError)
  })
})

describe('the registry with a co-worker principal', () => {
  it('runs a member tool as the co-worker, inside the principal scope', async () => {
    const scoped: string[] = []
    const registry = new KernelRegistry({
      principalScope: async (principal, run) => {
        scoped.push(`${principal.kind}:${principal.id}`)
        return run()
      },
    })
    registry.register({
      name: 'probe.whoami',
      module: 'probe',
      summary: 'probe',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['member'] },
      handler: async (ctx) => ({ id: ctx.principal.id }),
    })
    const ctx = { principal: coworkerPrincipal('cw_1', 'coworker:cw_1'), requestId: 'r1' }
    await expect(registry.execute('probe.whoami', {}, ctx)).resolves.toEqual({ id: 'cw_1' })
    expect(scoped).toEqual(['coworker:cw_1'])
  })

  it('refuses an admin tool to a co-worker (member rights only)', async () => {
    const registry = new KernelRegistry({})
    registry.register({
      name: 'probe.admin',
      module: 'probe',
      summary: 'probe',
      auditClass: 'read',
      inputSchema: z.object({}).strict(),
      permission: { roles: ['admin', 'agent'] },
      handler: async () => ({}),
    })
    const ctx = { principal: coworkerPrincipal('cw_1', 'coworker:cw_1'), requestId: 'r1' }
    await expect(registry.execute('probe.admin', {}, ctx)).rejects.toMatchObject({ code: 'permission_denied' })
  })
})
