import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import { CHAT_GATEWAY_MODULE_ID, chatGatewayManifest, type ChatGatewayStats } from './manifest'

const stats: ChatGatewayStats = { allowlistCount: 2, sessionsCount: 5 }
const { manifest, statusTool } = chatGatewayManifest(async () => stats)

describe('chat-gateway manifest', () => {
  it('has the prescribed shape', () => {
    expect(manifest.id).toBe('chat-gateway')
    expect(manifest.name).toBe('Chat Gateway')
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.tools).toEqual(['chat-gateway.status'])
    expect(manifest.permissions).toEqual({ roles: ['owner', 'admin'] })
    expect(typeof manifest.description).toBe('string')
  })

  it('registers in the ModuleRegistry and activates', async () => {
    const modules = new ModuleRegistry(new InMemoryActivationStore())
    modules.register(manifest)

    expect(modules.get(CHAT_GATEWAY_MODULE_ID)).toBe(manifest)
    expect(await modules.isToolActive('chat-gateway.status')).toBe(false)

    await modules.activate(CHAT_GATEWAY_MODULE_ID)
    expect(await modules.isToolActive('chat-gateway.status')).toBe(true)
  })

  it('rejects duplicate registration', () => {
    const modules = new ModuleRegistry(new InMemoryActivationStore())
    modules.register(manifest)
    expect(() => modules.register(manifest)).toThrow(/already registered/)
  })
})

describe('chat-gateway.status tool', () => {
  it('is a read tool owned by chat-gateway with an empty input schema', () => {
    expect(statusTool.name).toBe('chat-gateway.status')
    expect(statusTool.module).toBe('chat-gateway')
    expect(statusTool.auditClass).toBe('read')
    expect(statusTool.permission.roles).toEqual(['owner', 'admin'])
    expect(statusTool.inputSchema.safeParse({}).success).toBe(true)
  })

  it('executes through the KernelRegistry and returns injected stats', async () => {
    const sink = new InMemoryEventSink()
    const registry = new KernelRegistry({ eventSink: sink })
    registry.register(statusTool)

    const result = await registry.execute('chat-gateway.status', {}, {
      principal: { id: 'p1', kind: 'human' as const, roles: ['owner'] },
      requestId: 'req-1',
    })

    expect(result).toEqual({ allowlistCount: 2, sessionsCount: 5 })
    const audit = sink.events.find((e) => e.type === 'tool.executed')
    expect(audit).toBeDefined()
    expect(audit?.payload).toMatchObject({ tool: 'chat-gateway.status', ok: true })
  })

  it('denies principals without owner/admin roles', async () => {
    const registry = new KernelRegistry()
    registry.register(statusTool)

    await expect(
      registry.execute('chat-gateway.status', {}, {
        principal: { id: 'p2', kind: 'human' as const, roles: ['member'] },
        requestId: 'req-2',
      }),
    ).rejects.toThrow(KernelError)
  })
})
