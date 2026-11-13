import { describe, expect, it } from 'vitest'
import { InMemoryActivationStore, ModuleRegistry } from './modules'
import { KernelRegistry } from './registry'
import { registerModuleTools } from './wiring'
import type { ToolDescriptor } from './types'
import { z } from 'zod'

/** Platform step 1: one module may own several tool namespaces (merged modules). */
function merged() {
  const store = new InMemoryActivationStore()
  const registry = new ModuleRegistry(store)
  registry.register({
    id: 'website',
    name: 'Website',
    version: '0.2.0',
    toolNamespaces: ['website', 'substrate', 'github'],
    tools: ['website.list_pages', 'substrate.status', 'github.status'],
    permissions: { roles: ['admin'] },
  })
  return { store, registry }
}

describe('ModuleRegistry tool namespaces', () => {
  it('resolves a merged namespace to its owning module for activation', async () => {
    const { store, registry } = merged()
    expect(await registry.isToolActive('substrate.status')).toBe(false)
    await store.set('website', true)
    expect(await registry.isToolActive('substrate.status')).toBe(true)
    expect(await registry.isToolActive('github.status')).toBe(true)
    expect(registry.ownerOfNamespace('github')?.id).toBe('website')
    expect(registry.ownerOfNamespace('website')?.id).toBe('website')
    expect(registry.ownerOfNamespace('ghost')).toBeUndefined()
  })

  it('a stale activation row under an old id does not activate the merged tools', async () => {
    const { store, registry } = merged()
    await store.set('substrate', true)
    expect(await registry.isToolActive('substrate.status')).toBe(false)
  })

  it('throws when two manifests claim the same namespace', () => {
    const { registry } = merged()
    expect(() =>
      registry.register({
        id: 'hosting',
        name: 'Hosting',
        version: '0.1.0',
        toolNamespaces: ['hosting', 'substrate'],
        tools: ['substrate.domain_add'],
        permissions: { roles: ['admin'] },
      }),
    ).toThrow(/namespace "substrate" is already owned by module website/)
  })

  it('throws when a new module id collides with a namespace another module owns', () => {
    const { registry } = merged()
    expect(() =>
      registry.register({
        id: 'substrate',
        name: 'Hosting',
        version: '0.1.0',
        tools: ['substrate.domain_add'],
        permissions: { roles: ['admin'] },
      }),
    ).toThrow(/namespace "substrate" is already owned by module website/)
  })

  it('rejects a manifest listing a tool outside its namespaces', () => {
    const registry = new ModuleRegistry(new InMemoryActivationStore())
    expect(() =>
      registry.register({
        id: 'email',
        name: 'Email',
        version: '0.1.0',
        toolNamespaces: ['email', 'owlery'],
        tools: ['email.send_mail', 'repo.merge'],
        permissions: { roles: ['admin'] },
      }),
    ).toThrow(/tool repo.merge is outside the namespaces of module email/)
  })

  it("a namespace may use the same characters as a tool name's prefix (contribute-hub owns contribute_hub.*)", () => {
    const registry = new ModuleRegistry(new InMemoryActivationStore())
    registry.register({
      id: 'contribute-hub',
      name: 'Contribute hub',
      version: '0.1.0',
      toolNamespaces: ['contribute-hub', 'contribute_hub'],
      tools: ['contribute_hub.list'],
      permissions: { roles: ['admin'] },
    })
    expect(registry.ownerOfNamespace('contribute_hub')?.id).toBe('contribute-hub')
    expect(() =>
      registry.register({
        id: 'other',
        name: 'Other',
        version: '0.1.0',
        toolNamespaces: ['other', 'Bad.ns'],
        tools: [],
        permissions: { roles: ['admin'] },
      }),
    ).toThrow(/invalid module manifest other: toolNamespaces/)
  })

  it('rejects toolNamespaces that omit the module id itself', () => {
    const registry = new ModuleRegistry(new InMemoryActivationStore())
    expect(() =>
      registry.register({
        id: 'email',
        name: 'Email',
        version: '0.1.0',
        toolNamespaces: ['owlery'],
        tools: ['owlery.status'],
        permissions: { roles: ['admin'] },
      }),
    ).toThrow(/toolNamespaces of module email must include its own id/)
  })
})

function tool(name: string, module: string): ToolDescriptor {
  return {
    name,
    module,
    summary: name,
    inputSchema: z.object({}),
    permission: { roles: ['admin'] },
    auditClass: 'read',
    handler: async () => ({ ok: true }),
  }
}

describe('registerModuleTools with merged namespaces', () => {
  function kernelRegistry() {
    const activationStore = new InMemoryActivationStore()
    return new KernelRegistry({
      eventSink: { emit: async () => {} } as never,
      activationStore,
      approvalPolicy: { requiresApproval: async () => false } as never,
      approvalStore: {} as never,
      vcsCommitter: null,
    } as never)
  }

  it('accepts a tool whose prefix is a namespace declared by its owning module', () => {
    const { registry: modules } = merged()
    const registry = kernelRegistry()
    registerModuleTools(registry, modules, [
      tool('website.list_pages', 'website'),
      tool('substrate.status', 'website'),
      tool('github.status', 'website'),
    ])
    expect(registry.get('substrate.status')?.module).toBe('website')
  })

  it('rejects a tool claiming a module that does not own its prefix', () => {
    const { registry: modules } = merged()
    modules.register({
      id: 'email',
      name: 'Email',
      version: '0.1.0',
      tools: ['email.send_mail'],
      permissions: { roles: ['admin'] },
    })
    expect(() =>
      registerModuleTools(kernelRegistry(), modules, [tool('email.send_mail', 'website')]),
    ).toThrow(/tool email.send_mail is not in a namespace of its module "website"/)
  })
})
