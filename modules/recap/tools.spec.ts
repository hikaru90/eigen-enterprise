import { describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))

import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { registerModuleTools } from '$lib/kernel/wiring'
import type { AppDatabase } from '$lib/server/db/context'
import { kernelGatewaySessions } from '$lib/server/db/gateway.schema'
import { kernelEvents, kernelApprovals } from '$lib/server/db/kernel.schema'
import { createRecapModule } from './index'
import { recapManifest } from './manifest'

vi.mock('$lib/server/mcp/tools', () => ({
  runCaptureThoughtTool: vi.fn(),
  runRetrieveThoughtsTool: vi.fn(async () => ({ count: 0, results: [] })),
  runListProjectsTool: vi.fn(),
  runGetProjectTimelineTool: vi.fn(),
  runListTextFilesTool: vi.fn(),
  runGetTextFileTool: vi.fn(),
  runSearchTextFilesTool: vi.fn(),
}))

/** Chainable drizzle fake resolving fixed rows per table (no real database). */
function fakeDb(tables: Map<unknown, unknown[]>): AppDatabase {
  const makeBuilder = () => {
    let table: unknown
    const builder = {
      from(t: unknown) {
        table = t
        return builder
      },
      where: () => builder,
      orderBy: () => builder,
      limit: () => builder,
      then: (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(tables.get(table) ?? []).then(resolve),
    }
    return builder
  }
  return { select: () => makeBuilder() } as unknown as AppDatabase
}

const OWNER_CTX: ToolContext = {
  principal: { id: 'principal-owner', kind: 'human', roles: ['owner'] },
  requestId: 'req-owner',
}
const AGENT_CTX: ToolContext = {
  principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] },
  requestId: 'req-agent',
}

function makeWiredFixture() {
  const activations = new InMemoryActivationStore()
  const eventSink = new InMemoryEventSink()
  const sends: Array<{ chatId: string; text: string }> = []
  const db = fakeDb(
    new Map([
      [kernelEvents, []],
      [kernelApprovals, [{ pending: 0 }]],
      [kernelGatewaySessions, [{ externalChatId: '200', principalId: 'p-owner' }]],
    ]),
  )
  const boot = createRecapModule(
    {
      db,
      telegram: {
        sendMessage: async (chatId: string, text: string) => {
          sends.push({ chatId, text })
        },
      },
      allowlist: {
        list: async () => [{ platform: 'telegram', externalUserId: 'u1', principalId: 'p-owner' }],
      },
      eventSink,
    },
    { isActive: () => activations.get('recap') },
  )

  const modules = new ModuleRegistry(activations)
  const registry = new KernelRegistry({
    eventSink,
    activationStore: activations,
    approvalPolicy: new StaticApprovalPolicy(new Set()),
    approvalStore: new InMemoryApprovalStore(),
    vcsCommitter: null,
  })
  modules.register(boot.manifest)
  registerModuleTools(registry, modules, [boot.runNowTool])
  return { activations, eventSink, sends, boot, registry, modules }
}

describe('recap manifest + validated registration', () => {
  it('declares the recap module with the run_now tool', () => {
    expect(recapManifest.id).toBe('recap')
    expect(recapManifest.tools).toEqual(['recap.run_now'])
    expect(recapManifest.permissions.roles).toEqual(['owner', 'admin'])
  })

  it('registers through registerModuleTools (manifest ↔ tool contract holds)', () => {
    const { registry, modules } = makeWiredFixture()
    expect(registry.get('recap.run_now')).toBeDefined()
    expect(modules.get('recap')).toBeDefined()
  })

  it('fails the validated path when the tool is missing from the manifest', () => {
    const activations = new InMemoryActivationStore()
    const modules = new ModuleRegistry(activations)
    const registry = new KernelRegistry({ activationStore: activations })
    modules.register({ ...recapManifest, tools: [] })
    const { boot } = makeWiredFixture()
    expect(() => registerModuleTools(registry, modules, [boot.runNowTool])).toThrow(
      /missing from manifest "recap"/,
    )
  })
})

describe('recap.run_now through the kernel registry', () => {
  it('runs for an owner: delivers to owner chats and emits recap.completed + audit', async () => {
    const { activations, eventSink, sends, registry } = makeWiredFixture()
    await activations.set('recap', true)

    const result = (await registry.execute('recap.run_now', {}, OWNER_CTX)) as {
      deliveredChats: string[]
      chunkCount: number
    }

    expect(result.deliveredChats).toEqual(['200'])
    expect(result.chunkCount).toBe(1)
    expect(sends).toHaveLength(1)
    expect(sends[0].text).toContain('Quiet day')

    const types = eventSink.events.map((e) => e.type)
    expect(types).toContain('recap.completed')
    expect(types).toContain('tool.executed')
    expect(eventSink.events.find((e) => e.type === 'tool.executed')).toMatchObject({
      principalId: 'principal-owner',
      payload: { tool: 'recap.run_now', auditClass: 'mutate', ok: true },
    })
  })

  it('denies non-owner/admin principals', async () => {
    const { activations, sends, registry } = makeWiredFixture()
    await activations.set('recap', true)
    await expect(registry.execute('recap.run_now', {}, AGENT_CTX)).rejects.toMatchObject({
      code: 'permission_denied',
    })
    expect(sends).toHaveLength(0)
  })

  it('fails closed while the recap module is inactive', async () => {
    const { registry, sends } = makeWiredFixture()
    await expect(registry.execute('recap.run_now', {}, OWNER_CTX)).rejects.toMatchObject({
      code: 'module_inactive',
    })
    expect(sends).toHaveLength(0)
  })

  it('rejects non-empty input', async () => {
    const { activations, registry } = makeWiredFixture()
    await activations.set('recap', true)
    await expect(registry.execute('recap.run_now', { hack: 1 }, OWNER_CTX)).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })
})

describe('run_now and scheduler share the run path', () => {
  it('scheduler.maybeRun delivers like run_now', async () => {
    const { activations, sends, boot } = makeWiredFixture()
    await activations.set('recap', true)

    const ran = await boot.scheduler.maybeRun(new Date('2026-09-09T07:00:00.000Z'))
    expect(ran).toBe(true)
    expect(sends).toHaveLength(1)
    expect(boot.scheduler.lastRunDay()).toBe('2026-09-09')

    await expect(boot.scheduler.maybeRun(new Date('2026-09-09T08:00:00.000Z'))).resolves.toBe(
      false,
    )
    expect(sends).toHaveLength(1)
  })
})
