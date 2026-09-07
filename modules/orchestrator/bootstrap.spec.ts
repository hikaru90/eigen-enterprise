import type { WiredKernel } from '../index'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import type { AppDatabase } from '$lib/server/db/context'
import { buildKernel } from '../index'
import { bootstrapOrchestrator, type OrchestratorBootOptions } from './bootstrap'
import { OrchestratorBrain } from './brain'

function inMemoryKernel(): { kernel: WiredKernel; activations: InMemoryActivationStore } {
  const activations = new InMemoryActivationStore()
  const kernel = buildKernel({ activations, vcsCommitter: null })
  return { kernel, activations }
}

function bootOptions(
  kernel: WiredKernel,
  overrides: Partial<OrchestratorBootOptions> = {},
): OrchestratorBootOptions {
  return {
    env: { TELEGRAM_BOT_TOKEN: 'test-token' },
    kernel,
    db: {} as AppDatabase,
    startLoop: false,
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('bootstrapOrchestrator — chat-gateway inactive (fail closed)', () => {
  it('boots brain + kernel without gateway/loop and does NOT require a bot token', async () => {
    const { kernel } = inMemoryKernel()

    const boot = await bootstrapOrchestrator(bootOptions(kernel, { env: {} }))

    expect(boot.status()).toEqual({ chatGateway: 'inactive', loopRunning: false })
    expect(boot.brain).toBeInstanceOf(OrchestratorBrain)
    expect(boot.gateway).toBeNull()
    expect(boot.loop).toBeNull()
    expect(boot.allowlist).toBeNull()
    // Gateway surface is NOT registered while the module is inactive.
    expect(kernel.registry.get('chat-gateway.status')).toBeUndefined()
    expect(kernel.registry.get('chat-gateway.allowlist_add')).toBeUndefined()
    expect(kernel.modules.get('chat-gateway')).toBeUndefined()
  })
})

describe('bootstrapOrchestrator — chat-gateway active', () => {
  it('registers the gateway manifest + tools and wires brain, gateway, and loop', async () => {
    const { kernel, activations } = inMemoryKernel()
    await activations.set('chat-gateway', true)

    const boot = await bootstrapOrchestrator(bootOptions(kernel))

    expect(boot.status()).toEqual({ chatGateway: 'active', loopRunning: false })
    expect(boot.brain).toBeInstanceOf(OrchestratorBrain)
    expect(boot.gateway).not.toBeNull()
    expect(boot.allowlist).not.toBeNull()
    expect(boot.sessions).not.toBeNull()
    expect(boot.loop).not.toBeNull()

    // The full chat-gateway surface went through the kernel contract validation.
    expect(kernel.modules.get('chat-gateway')).toBeDefined()
    for (const name of [
      'chat-gateway.status',
      'chat-gateway.allowlist_add',
      'chat-gateway.allowlist_remove',
      'chat-gateway.allowlist_list',
    ]) {
      expect(kernel.registry.get(name)).toBeDefined()
    }

    await boot.loop!.stop()
  })

  it('starts the loop by default', async () => {
    // Stub the transport before boot so the started loop never touches the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })),
    )
    const { kernel, activations } = inMemoryKernel()
    await activations.set('chat-gateway', true)

    const boot = await bootstrapOrchestrator(bootOptions(kernel, { startLoop: true }))

    expect(boot.status()).toEqual({ chatGateway: 'active', loopRunning: true })
    await boot.loop!.stop()
    expect(boot.status().loopRunning).toBe(false)
  })

  it('fails loud when the module is active but TELEGRAM_BOT_TOKEN is missing', async () => {
    const { kernel, activations } = inMemoryKernel()
    await activations.set('chat-gateway', true)

    await expect(
      bootstrapOrchestrator(bootOptions(kernel, { env: {} })),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('routes brain messages to the gateway brain (end-to-end wiring smoke)', async () => {
    const { kernel, activations } = inMemoryKernel()
    await activations.set('chat-gateway', true)
    await activations.set('memory', true)

    const boot = await bootstrapOrchestrator(bootOptions(kernel))

    // The brain offers memory tools (memory module active) and never gateway
    // owner tools — the gateway surface is owner-only by design.
    const brain = boot.brain as unknown as { offeredTools(): Promise<Array<{ name: string }>> }
    const offered = await brain.offeredTools()
    expect(offered.map((t) => t.name)).toContain('memory.list_text_files')
    expect(offered.map((t) => t.name)).not.toContain('chat-gateway.allowlist_add')

    await boot.loop!.stop()
  })
})
