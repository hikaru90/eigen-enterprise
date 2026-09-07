import { describe, expect, it } from 'vitest'
import { PrincipalService, SYSTEM_PRINCIPAL_ID, type Principal, type PrincipalStore } from './principals'

function makeStore(): { store: PrincipalStore; principals: Map<string, Principal> } {
  const principals = new Map<string, Principal>()
  return {
    principals,
    store: {
      getById: async (id) => principals.get(id) ?? null,
      getByApiKey: async (hash) =>
        [...principals.values()].find((p) => p.apiKeyHash === hash) ?? null,
    },
  }
}

describe('PrincipalService', () => {
  it('resolves by id and by hashed api key via the injected store', async () => {
    const { store, principals } = makeStore()
    principals.set('agent-1', {
      id: 'agent-1',
      kind: 'agent',
      roles: ['memory.user'],
      apiKeyHash: 'hash-1',
    })
    const service = new PrincipalService(store)
    await expect(service.resolveById('agent-1')).resolves.toMatchObject({ id: 'agent-1' })
    await expect(service.resolveByApiKey('hash-1')).resolves.toMatchObject({ id: 'agent-1' })
    await expect(service.resolveById('ghost')).resolves.toBeNull()
    await expect(service.resolveByApiKey('no-such-hash')).resolves.toBeNull()
  })

  it('rejects empty inputs (fail loud, no silent fallback)', () => {
    const { store } = makeStore()
    const service = new PrincipalService(store)
    expect(() => service.resolveById('')).toThrow(TypeError)
    expect(() => service.resolveByApiKey('')).toThrow(TypeError)
  })

  it('exposes the system principal id', () => {
    expect(SYSTEM_PRINCIPAL_ID).toBe('system')
  })
})
