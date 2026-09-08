import { describe, expect, it } from 'vitest'
import { InMemoryEventSink } from '$lib/kernel/events'
import {
  CHAT_GATEWAY_ALLOWLIST_TOOLS,
  CHAT_GATEWAY_MODULE_ID,
  type AllowlistEntry,
  type AllowlistStore,
} from '$lib/kernel/gateway'
import { InMemoryActivationStore, ModuleRegistry, type ModuleManifest } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { createAllowlistAdminTools } from './allowlist-tools'

const ownerCtx: ToolContext = {
  principal: { id: 'owner-1', kind: 'human', roles: ['owner'] },
  requestId: 'req-owner',
}
const adminCtx: ToolContext = {
  principal: { id: 'admin-1', kind: 'human', roles: ['admin', 'agent'] },
  requestId: 'req-admin',
}

/** Local in-memory store — the concrete implementations belong to chat-gateway. */
function inMemoryAllowlist(): AllowlistStore {
  const entries = new Map<string, AllowlistEntry>()
  const key = (platform: string, externalUserId: string) => `${platform}${externalUserId}`
  return {
    isAllowed: async (platform, externalUserId) => entries.has(key(platform, externalUserId)),
    principalFor: async (platform, externalUserId) =>
      entries.get(key(platform, externalUserId))?.principalId ?? null,
    add: async (platform, externalUserId, principalId) => {
      entries.set(key(platform, externalUserId), { platform, externalUserId, principalId })
    },
    remove: async (platform, externalUserId) => {
      entries.delete(key(platform, externalUserId))
    },
    list: async () => [...entries.values()],
  }
}

/** Manifest literal mirroring the chat-gateway surface (see kernel/gateway.ts). */
const chatGatewayManifest: ModuleManifest = {
  id: CHAT_GATEWAY_MODULE_ID,
  name: 'Chat Gateway',
  version: '0.1.0',
  tools: ['chat-gateway.status', ...CHAT_GATEWAY_ALLOWLIST_TOOLS],
  permissions: { roles: ['owner', 'admin'] },
}

function makeRegistry(allowlist: AllowlistStore): KernelRegistry {
  const registry = new KernelRegistry({ eventSink: new InMemoryEventSink() })
  for (const tool of createAllowlistAdminTools(allowlist)) registry.register(tool)
  return registry
}

describe('createAllowlistAdminTools — descriptors', () => {
  it('declares exactly the manifest-listed allowlist tools, owner-only, correct audit classes', () => {
    const tools = createAllowlistAdminTools(inMemoryAllowlist())

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
    const allowlist = inMemoryAllowlist()
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
    const allowlist = inMemoryAllowlist()
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
    const registry = makeRegistry(inMemoryAllowlist())

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
    const allowlist = inMemoryAllowlist()
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
    const allowlist = inMemoryAllowlist()
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
    const modules = new ModuleRegistry(new InMemoryActivationStore())
    modules.register(chatGatewayManifest)

    const tools = createAllowlistAdminTools(inMemoryAllowlist())
    for (const tool of tools) {
      expect(tool.name.startsWith(`${tool.module}.`)).toBe(true)
      expect(modules.get(tool.module)?.tools).toContain(tool.name)
    }
  })
})
