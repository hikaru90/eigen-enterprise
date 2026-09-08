import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry, type ModuleManifest } from '$lib/kernel/modules'
import type { PrincipalStore } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolDescriptor, ToolContext } from '$lib/kernel/types'
import type { WiredKernel } from '$lib/kernel/wiring'
import {
  bootstrapOrchestrator,
  type OrchestratorBootOptions,
  type OrchestratorGatewayStage,
} from './bootstrap'
import { OrchestratorBrain } from './brain'

/** In-memory kernel wiring (the kernel composition itself is modules/index's job). */
function inMemoryKernel(): { kernel: WiredKernel; activations: InMemoryActivationStore } {
  const activations = new InMemoryActivationStore()
  const kernel: WiredKernel = {
    registry: new KernelRegistry({ eventSink: new InMemoryEventSink() }),
    modules: new ModuleRegistry(activations),
    activations,
    principals: {} as PrincipalStore,
    approvals: new InMemoryApprovalStore(),
    eventSink: new InMemoryEventSink(),
  }
  return { kernel, activations }
}

/** Local allowlist/session fakes — the concrete stores belong to chat-gateway. */
function fakeStage(): OrchestratorGatewayStage {
  return {
    gateway: { runCycle: async (offset) => offset },
    allowlist: {
      isAllowed: async () => false,
      principalFor: async () => null,
      add: async () => undefined,
      remove: async () => undefined,
      list: async () => [],
    },
    sessions: {
      touch: async () => ({ id: 'session-1' }),
      get: async () => null,
    },
  }
}

const activeStage = async (): Promise<OrchestratorGatewayStage> => fakeStage()
const inactiveStage = async (): Promise<OrchestratorGatewayStage | null> => null

function bootOptions(overrides: Partial<OrchestratorBootOptions> = {}): OrchestratorBootOptions {
  return { startLoop: false, ...overrides }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('bootstrapOrchestrator — chat-gateway inactive (fail closed)', () => {
  it('boots brain + kernel without gateway/loop and requires no env at all', async () => {
    const { kernel } = inMemoryKernel()

    const boot = await bootstrapOrchestrator(kernel, inactiveStage, bootOptions())

    expect(boot.status()).toEqual({ chatGateway: 'inactive', loopRunning: false })
    expect(boot.brain).toBeInstanceOf(OrchestratorBrain)
    expect(boot.gateway).toBeNull()
    expect(boot.loop).toBeNull()
    expect(boot.allowlist).toBeNull()
    expect(boot.sessions).toBeNull()
  })

  it('hands the freshly composed brain to the wireGateway stage', async () => {
    const { kernel } = inMemoryKernel()
    const received: OrchestratorBrain[] = []

    const boot = await bootstrapOrchestrator(kernel, async (brain) => {
      received.push(brain)
      return null
    }, bootOptions())

    expect(received).toEqual([boot.brain])
  })
})

describe('bootstrapOrchestrator — chat-gateway stage active', () => {
  it('wires brain, gateway, and loop through the stage and reports them', async () => {
    const { kernel } = inMemoryKernel()
    const stage = fakeStage()

    const boot = await bootstrapOrchestrator(kernel, async () => stage, bootOptions())

    expect(boot.status()).toEqual({ chatGateway: 'active', loopRunning: false })
    expect(boot.brain).toBeInstanceOf(OrchestratorBrain)
    expect(boot.gateway).toBe(stage.gateway)
    expect(boot.allowlist).toBe(stage.allowlist)
    expect(boot.sessions).toBe(stage.sessions)
    expect(boot.loop).not.toBeNull()

    await boot.loop!.stop()
  })

  it('starts the loop by default', async () => {
    const { kernel } = inMemoryKernel()
    const stage = fakeStage()

    const boot = await bootstrapOrchestrator(kernel, async () => stage)

    expect(boot.status()).toEqual({ chatGateway: 'active', loopRunning: true })
    await boot.loop!.stop()
    expect(boot.status().loopRunning).toBe(false)
  })

  it('composes the fail-closed tool surface around the stage (end-to-end smoke)', async () => {
    const { kernel, activations } = inMemoryKernel()
    const tool: ToolDescriptor = {
      name: 'testmod.echo',
      module: 'testmod',
      summary: 'summary of testmod.echo',
      auditClass: 'read',
      inputSchema: z.looseObject({}),
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx: ToolContext, input: unknown) => ({ echoed: input }),
    }
    const manifest: ModuleManifest = {
      id: 'testmod',
      name: 'testmod',
      version: '0.1.0',
      tools: ['testmod.echo'],
      permissions: { roles: ['admin', 'agent'] },
    }
    kernel.modules.register(manifest)
    kernel.registry.register(tool)
    await activations.set('testmod', true)

    const boot = await bootstrapOrchestrator(kernel, activeStage, bootOptions())

    const brain = boot.brain as unknown as { offeredTools(): Promise<Array<{ name: string }>> }
    const offered = await brain.offeredTools()
    expect(offered.map((t) => t.name)).toContain('testmod.echo')

    await boot.loop!.stop()
  })
})
