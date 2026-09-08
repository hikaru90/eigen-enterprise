import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry, type ModuleManifest } from '$lib/kernel/modules'
import type { PrincipalStore } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolDescriptor, ToolContext } from '$lib/kernel/types'
import type { LoopEngine } from '$lib/kernel/engine'
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

describe('bootstrapOrchestrator — harness runtime seeding (phase-1b)', () => {
  it('seeds the orchestrator as one AgentConfig on the builtin-json engine (inactive path)', async () => {
    const { kernel } = inMemoryKernel()

    const boot = await bootstrapOrchestrator(kernel, inactiveStage, bootOptions({ env: {} }))

    const config = boot.runtime.getAgent('orchestrator')
    expect(config).toMatchObject({
      id: 'orchestrator',
      loopEngine: 'builtin-json',
      toolScope: 'all',
      memoryScope: 'company',
      verificationPolicy: 'none',
      enabled: true,
    })
    expect(config?.spendCapUsd).toBeUndefined()
    expect(boot.brain).toBeInstanceOf(OrchestratorBrain)
  })

  it('parses EE_HARNESS_SPEND_CAP_USD into the agent spend cap (undefined = uncapped)', async () => {
    const { kernel } = inMemoryKernel()
    const boot = await bootstrapOrchestrator(
      kernel,
      inactiveStage,
      bootOptions({ env: { EE_HARNESS_SPEND_CAP_USD: '12.5' } }),
    )
    expect(boot.runtime.getAgent('orchestrator')?.spendCapUsd).toBe(12.5)

    const { kernel: kernel2 } = inMemoryKernel()
    const boot2 = await bootstrapOrchestrator(
      kernel2,
      inactiveStage,
      bootOptions({ env: { EE_HARNESS_SPEND_CAP_USD: '' } }),
    )
    expect(boot2.runtime.getAgent('orchestrator')?.spendCapUsd).toBeUndefined()
  })

  it('fails loud on a malformed EE_HARNESS_SPEND_CAP_USD', async () => {
    const { kernel } = inMemoryKernel()
    await expect(
      bootstrapOrchestrator(kernel, inactiveStage, bootOptions({ env: { EE_HARNESS_SPEND_CAP_USD: 'abc' } })),
    ).rejects.toThrow(/EE_HARNESS_SPEND_CAP_USD/)
  })

  it('registers the agent admin tools through the kernel contract (self-seeded active)', async () => {
    const { kernel, activations } = inMemoryKernel()
    await bootstrapOrchestrator(kernel, inactiveStage, bootOptions({ env: {} }))

    expect(await activations.get('agent')).toBe(true)
    expect(kernel.modules.get('agent')).toBeDefined()
    for (const name of ['agent.list', 'agent.enable', 'agent.disable']) {
      expect(kernel.registry.get(name)).toBeDefined()
    }
  })

  it('brain.respond dispatches through the runtime as the orchestrator agent', async () => {
    const activations = new InMemoryActivationStore()
    const sink = new InMemoryEventSink()
    const kernel: WiredKernel = {
      registry: new KernelRegistry({ eventSink: sink }),
      modules: new ModuleRegistry(activations),
      activations,
      principals: {} as PrincipalStore,
      approvals: new InMemoryApprovalStore(),
      eventSink: sink,
    }
    await activations.set('memory', true)

    const boot = await bootstrapOrchestrator(
      kernel,
      inactiveStage,
      bootOptions({
        complete: async () => ({
          choices: [{ message: { content: '{"answer":"hello from harness"}' } }],
        }),
      }),
    )

    const reply = await boot.brain.respond(
      { sessionId: 'session-1', platform: 'telegram', externalChatId: '100', principalId: 'p1' },
      'hi',
    )
    expect(reply).toBe('hello from harness')

    const types = sink.events.map((e) => e.type)
    expect(types).toContain('agent.dispatched')
    expect(types).toContain('agent.replied')
    // Reply content never lands in event payloads.
    const replied = sink.events.find((e) => e.type === 'agent.replied')!
    expect(JSON.stringify(replied.payload)).not.toContain('hello from harness')
    expect(replied.payload).toMatchObject({ agentId: 'orchestrator', sessionId: 'session-1' })
  })
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

describe('bootstrapOrchestrator — extra engine injection (composition-root seam)', () => {
  it('registers injected engines on the runtime without module imports', async () => {
    const { kernel } = inMemoryKernel()
    const fakeEngine: LoopEngine = {
      run: async (sessionId, input) => `pi:${sessionId}:${input}`,
    }

    const boot = await bootstrapOrchestrator(
      kernel,
      inactiveStage,
      bootOptions({ engines: [['pi', fakeEngine]] }),
    )

    // No getEngine accessor by design; prove registration through the dispatch path.
    await boot.runtime.registerAgent({
      id: 'pi-test-agent',
      personaName: 'pi-test-agent',
      description: 'engine injection probe',
      loopEngine: 'pi',
      toolScope: 'all',
      memoryScope: 'company',
      verificationPolicy: 'none',
      enabled: true,
    })
    const reply = await boot.runtime.dispatch('pi-test-agent', 'session-1', 'hello')
    expect(reply).toBe('pi:session-1:hello')
  })
})
