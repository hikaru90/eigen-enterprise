import type { PersonDirectory, PersonRef } from '../principals'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { StaticApprovalPolicy } from '../approvals'
import { InMemoryEventSink } from '../events'
import { KernelRegistry } from '../registry'
import {
  createPersonToolExecutor,
  durableConversationKey,
  sessionIdOfConversationKey,
} from './durable'

/**
 * Background runs (plan/phase-software-factory.md §3.1; CB3: no background run
 * without a person): a background run's tools execute through the kernel
 * registry as the run's RECORDED PERSON via the brain — with their CURRENT
 * roles, the same permission / approval / audit path a live dispatch takes —
 * and a person who is no longer a member fails loud instead of running as
 * anyone else.
 */

function directory(people: PersonRef[]): PersonDirectory {
  return { personById: async (id) => people.find((p) => p.id === id) ?? null }
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
    permission: { roles: ['member'] },
    handler: async (ctx, input) => {
      seen.push(`${ctx.principal.id}:${ctx.principal.via}:${(input as { path: string }).path}`)
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
    permission: { roles: ['member'] },
    handler: async () => ({ ok: true }),
  })
  registry.register({
    name: 'admin.danger',
    module: 'admin',
    summary: 'admins only',
    auditClass: 'read',
    inputSchema: z.object({}),
    permission: { roles: ['admin'] },
    handler: async () => ({ ran: true }),
  })
  return { registry, seen, eventSink }
}

const ann: PersonRef = { id: 'ann', roles: ['member'] }

describe('createPersonToolExecutor (background runs execute as the recorded person, via the brain)', () => {
  it('runs the tool through the registry as the recorded person, marked via the brain', async () => {
    const { registry, seen, eventSink } = registryWithEcho()
    const execute = createPersonToolExecutor({ registry, people: directory([ann]) })
    const result = await execute({ personId: 'ann', agentId: 'factory', tool: 'repo.read_file', args: { path: 'README.md' } })
    expect(result).toEqual({ content: 'x', as: 'ann' })
    expect(seen).toEqual(['ann:brain:README.md'])
    const executed = eventSink.events.find((e) => e.type === 'tool.executed')!
    expect(executed.principalId).toBe('ann')
    expect(executed.payload).toMatchObject({ via: 'brain', agentId: 'factory' })
  })

  it('a person who is no longer a member fails loud as a tool error naming them — nothing runs', async () => {
    const { registry, seen } = registryWithEcho()
    const execute = createPersonToolExecutor({ registry, people: directory([]) })
    const result = await execute({ personId: 'gone', agentId: 'factory', tool: 'repo.read_file', args: { path: 'README.md' } })
    expect(result).toMatchObject({ status: 'error', tool: 'repo.read_file', code: 'unknown_principal' })
    expect(JSON.stringify(result)).toContain('gone')
    expect(seen).toEqual([])
  })

  it('inherits the permission gate: the person’s current roles, never more', async () => {
    const { registry } = registryWithEcho()
    const execute = createPersonToolExecutor({ registry, people: directory([ann]) })
    const result = await execute({ personId: 'ann', agentId: 'factory', tool: 'admin.danger', args: {} })
    expect(result).toMatchObject({ status: 'error', code: 'permission_denied' })
  })

  it('inherits the approval gate: a gated tool reports approval_pending, asked by the person', async () => {
    const { registry } = registryWithEcho({ requireApproval: true })
    const execute = createPersonToolExecutor({ registry, people: directory([ann]) })
    const result = await execute({ personId: 'ann', agentId: 'factory', tool: 'repo.write_file', args: { path: 'a' } })
    expect(JSON.stringify(result)).toContain('approval_pending')
    const pending = await registry.getApprovalStore().latestFor('repo.write_file', 'ann')
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
