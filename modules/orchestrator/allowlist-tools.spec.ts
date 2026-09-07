import { describe, expect, it } from 'vitest'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import {
  CHAT_GATEWAY_ALLOWLIST_TOOLS,
  CHAT_GATEWAY_MODULE_ID,
  chatGatewayManifest,
} from '../chat-gateway/manifest'
import { InMemoryAllowlistStore, type AllowlistStore } from '../chat-gateway/stores'
import { createAllowlistAdminTools } from './allowlist-tools'

const ownerCtx: ToolContext = {
  principal: { id: 'owner-1', kind: 'human', roles: ['owner'] },
  requestId: 'req-owner',
}
const adminCtx: ToolContext = {
  principal: { id: 'admin-1', kind: 'human', roles: ['admin', 'agent'] },
  requestId: 'req-admin',
}

function makeRegistry(allowlist: AllowlistStore): KernelRegistry {
  const registry = new KernelRegistry({ eventSink: new InMemoryEventSink() })
  for (const tool of createAllowlistAdminTools(allowlist)) registry.register(tool)
  return registry
}

describe('createAllowlistAdminTools — descriptors', () => {
  it('declares exactly the manifest-listed allowlist tools, owner-only, correct audit classes', () => {
    const tools = createAllowlistAdminTools(new InMemoryAllowlistStore())

    expect(tools.map((t) => t.name)).toEqual([...CHAT_GATEWAY_ALLOWLIST_TOOLS])
    const byName = new Map(tools.map((t) => [t.name, t]))
    expect(byName.get('chat-gateway.allowlist_add')?.auditClass).toBe('mutate')
    expect(byName.get('chat-gateway.allowlist_remove')?.auditClass).toBe('mutate')
    expect(byName.get('chat-gateway.allowlist_list')?.auditClass).toBe('read')
    for (const tool of tools) {
      expect(tool.module).toBe(CHAT_GATEWAY_MODULE_ID)
      expect(tool.permission.roles).toEqual(['owner'])
    }
  })
})

describe('createAllowlistAdminTools — registry execution', () => {
  it('denies principals without the owner role (permission_denied)', async () => {
    const allowlist = new InMemoryAllowlistStore()
    const registry = makeRegistry(allowlist)

    await expect(
      registry.execute(
        'chat-gateway.allowlist_add',
        { platform: 'telegram', external_user_id: '42', principal_id: 'p1' },
        adminCtx,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(
      registry.execute('chat-gateway.allowlist_list', {}, adminCtx),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    expect(await allowlist.list()).toEqual([])
  })

  it('allowlist_add proceeds for an owner and writes the store', async () => {
    const allowlist = new InMemoryAllowlistStore()
    const registry = makeRegistry(allowlist)

    const result = await registry.execute(
      'chat-gateway.allowlist_add',
      { platform: 'telegram', external_user_id: '42', principal_id: 'principal-42' },
      ownerCtx,
    )

    expect(result).toMatchObject({ ok: true })
    expect(await allowlist.principalFor('telegram', '42')).toBe('principal-42')
  })

  it('allowlist_add validates input against the zod schema (fail loud invalid_input)', async () => {
    const registry = makeRegistry(new InMemoryAllowlistStore())

    await expect(
      registry.execute(
        'chat-gateway.allowlist_add',
        { platform: 'slack', external_user_id: '42', principal_id: 'p1' },
        ownerCtx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      registry.execute(
        'chat-gateway.allowlist_add',
        { platform: 'telegram', external_user_id: '', principal_id: 'p1' },
        ownerCtx,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('allowlist_remove proceeds for an owner and deletes the entry', async () => {
    const allowlist = new InMemoryAllowlistStore()
    await allowlist.add('telegram', '42', 'principal-42')
    const registry = makeRegistry(allowlist)

    await registry.execute(
      'chat-gateway.allowlist_remove',
      { platform: 'telegram', external_user_id: '42' },
      ownerCtx,
    )

    expect(await allowlist.isAllowed('telegram', '42')).toBe(false)
  })

  it('allowlist_list returns the current entries for an owner', async () => {
    const allowlist = new InMemoryAllowlistStore()
    await allowlist.add('telegram', '7', 'principal-7')
    const registry = makeRegistry(allowlist)

    const result = await registry.execute('chat-gateway.allowlist_list', {}, ownerCtx)

    expect(result).toEqual([
      { platform: 'telegram', externalUserId: '7', principalId: 'principal-7' },
    ])
  })

  it('surfaces store failures loud (non-KernelError handler errors propagate)', async () => {
    const failing: AllowlistStore = {
      isAllowed: async () => true,
      principalFor: async () => null,
      add: async () => {
        throw new Error('db down')
      },
      remove: async () => undefined,
      list: async () => [],
    }
    const registry = makeRegistry(failing)

    await expect(
      registry.execute(
        'chat-gateway.allowlist_add',
        { platform: 'telegram', external_user_id: '1', principal_id: 'p1' },
        ownerCtx,
      ),
    ).rejects.toThrow(/db down/)
  })
})

describe('allowlist tools — manifest wiring', () => {
  it('every descriptor satisfies the kernel manifest contract for chat-gateway', () => {
    const allowlist = new InMemoryAllowlistStore()
    const modules = new ModuleRegistry(new InMemoryActivationStore())
    const { manifest } = chatGatewayManifest(async () => ({
      allowlistCount: 0,
      sessionsCount: 0,
    }))
    modules.register(manifest)

    const tools = createAllowlistAdminTools(allowlist)
    for (const tool of tools) {
      expect(tool.name.startsWith(`${tool.module}.`)).toBe(true)
      expect(modules.get(tool.module)?.tools).toContain(tool.name)
    }
  })
})
