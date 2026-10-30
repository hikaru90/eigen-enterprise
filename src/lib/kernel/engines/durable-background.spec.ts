import type { Principal, PrincipalStore } from '../principals'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { StaticApprovalPolicy } from '../approvals'
import { InMemoryEventSink } from '../events'
import { KernelRegistry } from '../registry'
import {
  createPrincipalToolExecutor,
  durableConversationKey,
  sessionIdOfConversationKey,
} from './durable'

/**
 * Background runs (plan/phase-software-factory.md §3.1): a background run's
 * tools execute through the kernel registry as the run's RECORDED principal —
 * the same permission / approval / audit path a live dispatch takes — and a
 * principal that no longer exists fails loud instead of running as anyone else.
 */

function principalStore(principals: Principal[]): PrincipalStore {
  return {
    getById: async (id) => principals.find((p) => p.id === id) ?? null,
    getByApiKey: async () => null,
  }
}

function registryWithEcho(options: { requireApproval?: boolean } = {}) {
  const eventSink = new InMemoryEventSink()
  const registry = new KernelRegistry({
    eventSink,
    approvalPolicy: new StaticApprovalPolicy(
      new Set(options.requireApproval ? ['repo.write_file'] : []),
    ),
  })
  const seen: string[] = []
  registry.register({
    name: 'repo.read_file',
    module: 'repo',
    summary: 'read',
    auditClass: 'read',
    inputSchema: z.object({ path: z.string() }),
    permission: { roles: ['agent'] },
    handler: async (ctx, input) => {
      seen.push(`${ctx.principal.id}:${(input as { path: string }).path}`)
      return { content: 'x', as: ctx.principal.id }
    },
  })
  registry.register({
    name: 'repo.write_file',
    module: 'repo',
    summary: 'write',
    auditClass: 'mutate',
    activity: () => 'wrote',
    inputSchema: z.object({ path: z.string() }),
    permission: { roles: ['agent'] },
    handler: async () => ({ ok: true }),
  })
  registry.register({
    name: 'admin.danger',
    module: 'admin',
    summary: 'owner only',
    auditClass: 'read',
    inputSchema: z.object({}),
    permission: { roles: ['owner'] },
    handler: async () => ({ ran: true }),
  })
  return { registry, seen, eventSink }
}

const factory: Principal = { id: 'agent:factory', kind: 'agent', roles: ['agent'] }

describe('createPrincipalToolExecutor (background runs execute as the recorded principal)', () => {
  it('runs the tool through the registry as the recorded principal', async () => {
    const { registry, seen } = registryWithEcho()
    const execute = createPrincipalToolExecutor({ registry, principals: principalStore([factory]) })
    const result = await execute({
      principalId: 'agent:factory',
      agentId: 'factory',
      tool: 'repo.read_file',
      args: { path: 'README.md' },
    })
    expect(result).toEqual({ content: 'x', as: 'agent:factory' })
    expect(seen).toEqual(['agent:factory:README.md'])
  })

  it('a principal that no longer exists fails loud as a tool error naming it — nothing runs', async () => {
    const { registry, seen } = registryWithEcho()
    const execute = createPrincipalToolExecutor({ registry, principals: principalStore([]) })
    const result = await execute({
      principalId: 'agent:gone',
      agentId: 'factory',
      tool: 'repo.read_file',
      args: { path: 'README.md' },
    })
    expect(result).toMatchObject({
      status: 'error',
      tool: 'repo.read_file',
      code: 'unknown_principal',
    })
    expect(JSON.stringify(result)).toContain('agent:gone')
    expect(seen).toEqual([])
  })

  it('inherits the permission gate: the recorded principal cannot exceed its roles', async () => {
    const { registry } = registryWithEcho()
    const execute = createPrincipalToolExecutor({ registry, principals: principalStore([factory]) })
    const result = await execute({
      principalId: 'agent:factory',
      agentId: 'factory',
      tool: 'admin.danger',
      args: {},
    })
    expect(result).toMatchObject({ status: 'error', code: 'permission_denied' })
  })

  it('inherits the approval gate: a gated tool reports approval_pending', async () => {
    const { registry } = registryWithEcho({ requireApproval: true })
    const execute = createPrincipalToolExecutor({ registry, principals: principalStore([factory]) })
    const result = await execute({
      principalId: 'agent:factory',
      agentId: 'factory',
      tool: 'repo.write_file',
      args: { path: 'a' },
    })
    expect(JSON.stringify(result)).toContain('approval_pending')
    const pending = await registry.getApprovalStore().latestFor('repo.write_file', 'agent:factory')
    expect(pending?.status).toBe('pending')
  })
})

describe('durable conversation keys', () => {
  it('round-trips the session id of an agent-scoped key', () => {
    const key = durableConversationKey('orchestrator', 'b2c3')
    expect(key).toBe('orchestrator:b2c3')
    expect(sessionIdOfConversationKey('orchestrator', key)).toBe('b2c3')
  })

  it('refuses a key of another agent (no guessing)', () => {
    expect(() => sessionIdOfConversationKey('orchestrator', 'factory:x')).toThrow(
      /not a conversation key of agent orchestrator/,
    )
  })
})
