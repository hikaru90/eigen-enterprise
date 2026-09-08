import type { ChatGatewayBoot } from '../../../modules/index'
import type { OrchestratorBoot, OrchestratorStatus } from '../../../modules/orchestrator/bootstrap'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WiredKernel } from '$lib/kernel/wiring'

const mocks = vi.hoisted(() => ({
  buildKernel: vi.fn(),
  bootstrapOrchestrator: vi.fn(),
  bootstrapChatGateway: vi.fn(),
  piEngine: { engineId: 'fake-pi-engine' },
}))

vi.mock('../../../modules/index', () => ({
  buildKernel: mocks.buildKernel,
  bootstrapChatGateway: mocks.bootstrapChatGateway,
}))
vi.mock('../../../modules/orchestrator/bootstrap', () => ({
  bootstrapOrchestrator: mocks.bootstrapOrchestrator,
}))
vi.mock('../../../modules/dev-agent', () => ({ piEngine: mocks.piEngine }))

type OrchestratorCall = {
  kernel: WiredKernel
  options: { env: Record<string, string | undefined>; engines?: Array<[string, unknown]> }
}

/** What the (fake) orchestrator handed to wireGateway — the adaptation's output. */
const orchestratorCalls: OrchestratorCall[] = []
const stagesFromWireGateway: Array<Record<string, unknown> | null> = []

function fakeKernel(): WiredKernel {
  return {
    registry: {},
    modules: {},
    activations: {},
    principals: {},
    approvals: {},
    eventSink: {},
  } as unknown as WiredKernel
}

function fakeGatewayBoot(): ChatGatewayBoot {
  return {
    manifest: { id: 'chat-gateway' },
    statusTool: { name: 'chat-gateway.status' },
    gateway: { runCycle: async (offset: number) => offset },
    client: {},
    allowlist: {},
    sessions: {},
  } as unknown as ChatGatewayBoot
}

function installFakeOrchestrator(): void {
  mocks.bootstrapOrchestrator.mockImplementation(
    async (
      kernel: WiredKernel,
      wireGateway: (brain: unknown) => Promise<Record<string, unknown> | null>,
      options: OrchestratorCall['options'],
    ) => {
      orchestratorCalls.push({ kernel, options })
      const brain = { respond: async () => 'fake-brain' }
      const stage = await wireGateway(brain)
      stagesFromWireGateway.push(stage)
      return {
        kernel,
        runtime: {},
        brain,
        gateway: stage?.gateway ?? null,
        allowlist: stage?.allowlist ?? null,
        sessions: stage?.sessions ?? null,
        loop: null,
        status: (): OrchestratorStatus =>
          stage ? { chatGateway: 'active', loopRunning: false } : { chatGateway: 'inactive', loopRunning: false },
      } as unknown as OrchestratorBoot
    },
  )
}

beforeEach(() => {
  // boot.ts memoizes per module instance — reset for a fresh memo per test.
  vi.resetModules()
  vi.clearAllMocks()
  orchestratorCalls.length = 0
  stagesFromWireGateway.length = 0
  mocks.buildKernel.mockImplementation(fakeKernel)
  mocks.bootstrapChatGateway.mockResolvedValue(null)
  installFakeOrchestrator()
})

describe('bootApp — startup composition root', () => {
  it('is single-flight: overlapping and later calls return the same boot (one composition)', async () => {
    const { bootApp } = await import('./boot')

    const [a, b] = await Promise.all([bootApp({ env: {} }), bootApp({ env: {} })])
    expect(a).toBe(b)
    expect(mocks.buildKernel).toHaveBeenCalledTimes(1)
    expect(mocks.bootstrapOrchestrator).toHaveBeenCalledTimes(1)
    expect(mocks.bootstrapChatGateway).toHaveBeenCalledTimes(1)

    // Later calls return the memoized boot; different options are ignored.
    const c = await bootApp({ env: { DIFFERENT: 'ignored' } })
    expect(c).toBe(a)
    expect(mocks.buildKernel).toHaveBeenCalledTimes(1)
    expect(mocks.bootstrapOrchestrator).toHaveBeenCalledTimes(1)
  })

  it('hosts the dev-agent pi engine via the orchestrator engines seam and injects env', async () => {
    const { bootApp } = await import('./boot')
    const env = { EE_HARNESS_SPEND_CAP_USD: '5' }

    const boot = await bootApp({ env })

    expect(mocks.bootstrapOrchestrator).toHaveBeenCalledTimes(1)
    const [kernelArg, , optionsArg] = mocks.bootstrapOrchestrator.mock.calls[0]
    expect(kernelArg).toBe(boot.kernel)
    expect(optionsArg.engines).toEqual([['pi', mocks.piEngine]])
    expect(optionsArg.env).toBe(env)
  })

  it('hands the composed kernel and orchestrator brain to the gateway stage (env injected)', async () => {
    const { bootApp } = await import('./boot')
    const gwBoot = fakeGatewayBoot()
    mocks.bootstrapChatGateway.mockResolvedValue(gwBoot)
    const env = { TELEGRAM_BOT_TOKEN: 'token' }

    const boot = await bootApp({ env })

    const [kernelArg, brainArg, optionsArg] = mocks.bootstrapChatGateway.mock.calls[0]
    expect(kernelArg).toBe(boot.kernel)
    expect(brainArg).toBe(boot.orchestrator.brain)
    expect(optionsArg).toEqual({ env })

    // The stage's real boot is adapted down to the kernel gateway port —
    // exactly { gateway, allowlist, sessions }, no module internals leak.
    expect(stagesFromWireGateway[0]).toEqual({
      gateway: gwBoot.gateway,
      allowlist: gwBoot.allowlist,
      sessions: gwBoot.sessions,
    })

    // The full gateway boot is still exposed for hooks/tests.
    expect(boot.gateway).toBe(gwBoot)
    expect(boot.status()).toEqual({
      orchestrator: { chatGateway: 'active', loopRunning: false },
      gatewayBooted: true,
    })
  })

  it('inactive gateway stage: no gateway boot and status reflects it', async () => {
    const { bootApp } = await import('./boot')

    const boot = await bootApp({ env: {} })

    expect(boot.gateway).toBeNull()
    expect(boot.orchestrator.gateway).toBeNull()
    expect(boot.orchestrator.loop).toBeNull()
    expect(stagesFromWireGateway[0]).toBeNull()
    expect(boot.status()).toEqual({
      orchestrator: { chatGateway: 'inactive', loopRunning: false },
      gatewayBooted: false,
    })
  })

  it('defaults: buildKernel() with no options and env falls back to process.env', async () => {
    const { bootApp } = await import('./boot')

    await bootApp()

    expect(mocks.buildKernel).toHaveBeenCalledWith()
    expect(mocks.bootstrapOrchestrator.mock.calls[0][2].env).toBe(process.env)
    expect(mocks.bootstrapChatGateway.mock.calls[0][2].env).toBe(process.env)
  })

  it('fails loud when the gateway stage throws; a failed boot is not cached (retry re-composes)', async () => {
    const { bootApp } = await import('./boot')
    mocks.bootstrapChatGateway.mockRejectedValue(new Error('TELEGRAM_BOT_TOKEN is not set'))

    // Overlapping calls share one composition even in failure — both reject.
    const results = await Promise.allSettled([bootApp({ env: {} }), bootApp({ env: {} })])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    const reason = (results[0] as PromiseRejectedResult).reason as Error
    expect(reason.message).toMatch(/TELEGRAM_BOT_TOKEN/)
    expect((results[1] as PromiseRejectedResult).reason).toBe(reason)
    expect(mocks.buildKernel).toHaveBeenCalledTimes(1)
    expect(mocks.bootstrapOrchestrator).toHaveBeenCalledTimes(1)

    // Recovery: the next call composes a fresh boot (new kernel, stages rerun).
    mocks.bootstrapChatGateway.mockResolvedValue(null)
    const retry = await bootApp({ env: {} })
    expect(mocks.buildKernel).toHaveBeenCalledTimes(2)
    expect(mocks.bootstrapOrchestrator).toHaveBeenCalledTimes(2)
    expect(retry.kernel).not.toBe(orchestratorCalls[0].kernel)
    expect(retry.status().gatewayBooted).toBe(false)
  })
})
