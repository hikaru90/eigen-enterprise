import type { ToolContext } from './types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { registerModuleTools } from '../../../modules/index'
import { createAgentAdminTools, agentAdminManifest, AGENT_ADMIN_TOOL_NAMES } from './agent-admin'
import { AgentRuntime } from './agent-runtime'
import { InMemoryApprovalStore, StaticApprovalPolicy } from './approvals'
import { KernelError, isKernelErrorCode } from './errors'
import { InMemoryEventSink } from './events'
import { InMemoryActivationStore, ModuleRegistry } from './modules'
import { KernelRegistry } from './registry'

function makeRuntime(): AgentRuntime {
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new StaticApprovalPolicy(new Set()),
    approvalStore: new InMemoryApprovalStore(),
  })
  return new AgentRuntime({
    registry,
    isToolActive: async () => true,
    eventSink: new InMemoryEventSink(),
  })
}

function makeHarness() {
  const runtime = makeRuntime()
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new StaticApprovalPolicy(new Set()),
    approvalStore: new InMemoryApprovalStore(),
  })
  const modules = new ModuleRegistry(new InMemoryActivationStore())
  modules.register(agentAdminManifest)
  registerModuleTools(registry, modules, createAgentAdminTools({ runtime }))
  return { runtime, registry, modules }
}

function adminCtx(roles: string[]): ToolContext {
  return { principal: { id: 'principal-1', kind: 'human', roles }, requestId: 'req-1' }
}

describe('agentAdminManifest', () => {
  it('declares exactly the agent admin tools', () => {
    expect(agentAdminManifest.tools).toEqual([...AGENT_ADMIN_TOOL_NAMES])
    expect(agentAdminManifest.id).toBe('agent')
  })
})

describe('agent admin tools — kernel-contract wiring', () => {
  it('registers through the validated manifest ↔ tool path', () => {
    const { registry } = makeHarness()
    for (const name of AGENT_ADMIN_TOOL_NAMES) {
      expect(registry.get(name)).toBeDefined()
    }
  })
})

describe('agent.list', () => {
  it('lists registered agents for admin and agent roles', async () => {
    const { runtime, registry } = makeHarness()
    runtime.registerAgent({
      id: 'orchestrator',
      personaName: 'Orchestrator',
      description: 'd',
      loopEngine: 'durable',
      toolScope: 'all',
      memoryScope: 'company',
      verificationPolicy: 'none',
      enabled: true,
    })

    const descriptor = registry.get('agent.list')!
    for (const roles of [['admin'], ['agent']]) {
      const result = await descriptor.handler(adminCtx(roles), {})
      expect(result).toEqual([expect.objectContaining({ id: 'orchestrator', enabled: true })])
    }
  })

  it('denies other roles at the kernel permission gate', async () => {
    const { runtime, registry } = makeHarness()
    runtime.registerAgent({
      id: 'a',
      personaName: 'A',
      description: 'd',
      loopEngine: 'e',
      toolScope: 'all',
      memoryScope: 'company',
      verificationPolicy: 'none',
      enabled: true,
    })

    const error = await registry
      .execute('agent.list', {}, adminCtx(['human']))
      .then(() => null, (err: unknown) => err as KernelError)
    expect(error).toBeInstanceOf(KernelError)
    expect((error as KernelError).code).toBe('permission_denied')
  })
})

describe('agent.enable / agent.disable', () => {
  const cfg = {
    id: 'a',
    personaName: 'A',
    description: 'd',
    loopEngine: 'e',
    toolScope: 'all' as const,
    memoryScope: 'company' as const,
    verificationPolicy: 'none' as const,
    enabled: true,
  }

  it('disable flips the runtime config; only owners may call it', async () => {
    const { runtime, registry } = makeHarness()
    runtime.registerAgent(cfg)

    const result = await registry.execute('agent.disable', { agent_id: 'a' }, adminCtx(['owner']))
    expect(result).toEqual({ agent_id: 'a', enabled: false })
    expect(runtime.getAgent('a')?.enabled).toBe(false)

    await expect(
      registry.execute('agent.enable', { agent_id: 'a' }, adminCtx(['agent'])),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('enable flips the runtime config back (owner only)', async () => {
    const { runtime, registry } = makeHarness()
    runtime.registerAgent({ ...cfg, enabled: false })

    const result = await registry.execute('agent.enable', { agent_id: 'a' }, adminCtx(['owner']))
    expect(result).toEqual({ agent_id: 'a', enabled: true })
    expect(runtime.getAgent('a')?.enabled).toBe(true)
  })

  it('fails loud on unknown agents', async () => {
    const { registry } = makeHarness()
    expect(isKernelErrorCode('unknown_agent')).toBe(true)
    await expect(
      registry.execute('agent.disable', { agent_id: 'ghost' }, adminCtx(['owner'])),
    ).rejects.toMatchObject({ code: 'unknown_agent' })
  })

  it('validates input via zod', async () => {
    const { registry } = makeHarness()
    await expect(
      registry.execute('agent.enable', { agent_id: '' }, adminCtx(['owner'])),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('schema sanity', () => {
  it('input schemas are zod schemas', () => {
    const runtime = makeRuntime()
    for (const t of createAgentAdminTools({ runtime })) {
      expect(t.inputSchema).toBeDefined()
      expect(typeof (t.inputSchema as z.ZodType).safeParse).toBe('function')
    }
  })
})
