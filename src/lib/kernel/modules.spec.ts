import { describe, expect, it } from 'vitest'
import { InMemoryActivationStore, ModuleRegistry } from './modules'

function makeRegistry() {
  const store = new InMemoryActivationStore()
  const registry = new ModuleRegistry(store)
  registry.register({
    id: 'memory',
    name: 'Memory',
    version: '0.1.0',
    tools: ['memory.echo', 'memory.wipe'],
    permissions: { roles: ['admin'] },
  })
  return { store, registry }
}

describe('ModuleRegistry', () => {
  it('throws on duplicate module id', () => {
    const { registry } = makeRegistry()
    expect(() =>
      registry.register({
        id: 'memory',
        name: 'Memory again',
        version: '0.2.0',
        tools: ['memory.echo'],
        permissions: { roles: ['admin'] },
      }),
    ).toThrow(/already registered/)
  })

  it('rejects malformed manifests with a validation error (fail loud)', () => {
    const { registry } = makeRegistry()
    expect(() =>
      registry.register({
        id: 'chat',
        name: 'Chat',
        version: '1.0',
        tools: ['chat.send'],
        permissions: { roles: ['admin'] },
      }),
    ).toThrow(/invalid module manifest chat/)
  })

  it('validates the manifest before the duplicate check', () => {
    const { registry } = makeRegistry()
    expect(() =>
      registry.register({
        id: 'memory',
        name: 'Memory',
        version: 'nope',
        tools: ['memory.echo'],
        permissions: { roles: ['admin'] },
      }),
    ).toThrow(/invalid module manifest memory/)
  })

  it('activates and deactivates via the activation store', async () => {
    const { store, registry } = makeRegistry()
    await expect(store.get('memory')).resolves.toBe(false)
    await registry.activate('memory')
    await expect(store.get('memory')).resolves.toBe(true)
    await expect(registry.isToolActive('memory.echo')).resolves.toBe(true)
    await registry.deactivate('memory')
    await expect(store.get('memory')).resolves.toBe(false)
    await expect(registry.isToolActive('memory.wipe')).resolves.toBe(false)
    const listed = await store.list()
    expect(listed.get('memory')).toBe(false)
  })

  it('isToolActive is false for unknown modules and malformed tool names (fail closed)', async () => {
    const { registry } = makeRegistry()
    await expect(registry.isToolActive('ghost.echo')).resolves.toBe(false)
    await expect(registry.isToolActive('notnamespaced')).resolves.toBe(false)
    // Even with the module activated, an unregistered module id stays false.
    await registry.activate('memory')
    await expect(registry.isToolActive('ghost.echo')).resolves.toBe(false)
  })

  it('activation gating is reflected per owning module', async () => {
    const { registry } = makeRegistry()
    await registry.activate('memory')
    await expect(registry.isToolActive('memory.echo')).resolves.toBe(true)
    await expect(registry.isToolActive('memory.wipe')).resolves.toBe(true)
    await registry.deactivate('memory')
    await expect(registry.isToolActive('memory.echo')).resolves.toBe(false)
  })

  it('activate/deactivate throw for unknown module ids', async () => {
    const { registry } = makeRegistry()
    await expect(registry.activate('ghost')).rejects.toThrow(/unknown module/)
    await expect(registry.deactivate('ghost')).rejects.toThrow(/unknown module/)
  })
})
