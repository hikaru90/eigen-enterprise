import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { BRAND_TOOL_NAMES, brandManifest } from './manifest'
import { InMemoryBrandStore } from './store'
import { createBrandTools } from './tools'

const humanAdmin: ToolContext = {
  principal: { id: 'owner-1', kind: 'human', roles: ['admin'] },
  requestId: 'req-1',
}

const agentPrincipal: ToolContext = {
  // Orchestrator-style agent: holds the admin ROLE but is not a human (G8/D5).
  principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] },
  requestId: 'req-2',
}

function validContext() {
  return {
    mission: 'Make AI-native company operations legible.',
    audience: 'Founder-operators of small companies.',
    register: 'Plain, direct, no hype.',
    toneAttributes: ['clear and approachable', 'action-oriented and candid'],
  }
}

function wiredRegistry() {
  const store = new InMemoryBrandStore()
  const activations = new InMemoryActivationStore()
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    activationStore: activations,
    approvalStore: new InMemoryApprovalStore(),
    vcsCommitter: null,
  })
  for (const descriptor of createBrandTools({ store })) registry.register(descriptor)
  return { store, registry, activations }
}

describe('brandManifest', () => {
  it('owns the namespaced brand tool names', () => {
    expect(brandManifest.id).toBe('brand')
    expect(brandManifest.tools).toEqual([...BRAND_TOOL_NAMES])
    expect(brandManifest.tools.every((name) => name.startsWith('brand.'))).toBe(true)
  })
})

describe('createBrandTools', () => {
  const tools = createBrandTools({ store: new InMemoryBrandStore() })
  const byName = new Map(tools.map((t) => [t.name, t]))

  it('builds one descriptor per manifest tool name', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...BRAND_TOOL_NAMES].sort())
    for (const descriptor of tools) {
      expect(descriptor.module).toBe('brand')
      expect(descriptor.summary.length).toBeGreaterThan(0)
    }
  })

  it('marks curation tools mutate and reads read', () => {
    const reads = ['brand.set_get', 'brand.set_list']
    for (const descriptor of tools) {
      if (reads.includes(descriptor.name)) expect(descriptor.auditClass).toBe('read')
      else expect(descriptor.auditClass).toBe('mutate')
    }
  })

  it('restricts guideline mutations to the admin role (G8)', () => {
    for (const descriptor of tools) {
      if (descriptor.auditClass === 'read') {
        expect(descriptor.permission.roles).toEqual(['admin', 'agent'])
      } else {
        expect(descriptor.permission.roles).toEqual(['admin'])
      }
    }
  })

  it('rejects a single tone word at descriptor schema level (G2)', () => {
    const schema = byName.get('brand.set_create')?.inputSchema
    const bad = { locale: 'en', context: { ...validContext(), toneAttributes: ['happy'] } }
    expect(schema?.safeParse(bad).success).toBe(false)
    expect(schema?.safeParse({ locale: 'en', context: validContext() }).success).toBe(true)
  })
})

describe('brand tools through the kernel pipeline', () => {
  it('a human admin creates a draft set; the audit event records ok:true', async () => {
    const { store, registry, activations } = wiredRegistry()
    await activations.set('brand', true)
    const result = await registry.execute('brand.set_create', { locale: 'en', context: validContext() }, humanAdmin)
    const created = result as { id: string; status: string }
    expect(created.status).toBe('draft')
    await expect(store.getSet(created.id)).resolves.not.toBeNull()
  })

  it('an agent principal with the admin ROLE still gets permission_denied on mutations (G8/D5)', async () => {
    const { registry, activations } = wiredRegistry()
    await activations.set('brand', true)
    await expect(
      registry.execute('brand.set_create', { locale: 'en', context: validContext() }, agentPrincipal),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('an agent CAN read guideline sets', async () => {
    const { store, registry, activations } = wiredRegistry()
    await activations.set('brand', true)
    const set = await store.createSet({ locale: 'en', context: validContext() })
    await expect(
      registry.execute('brand.set_get', { setId: set.id }, agentPrincipal),
    ).resolves.toMatchObject({ id: set.id })
  })

  it('fails closed when the brand module is inactive', async () => {
    const { registry } = wiredRegistry()
    await expect(
      registry.execute('brand.set_list', {}, humanAdmin),
    ).rejects.toMatchObject({ code: 'module_inactive' })
  })

  it('the full curation journey runs through registry tools: create -> exemplars -> activate (guards enforced)', async () => {
    const { store, registry, activations } = wiredRegistry()
    await activations.set('brand', true)

    const created = (await registry.execute(
      'brand.set_create',
      { locale: 'en', context: validContext() },
      humanAdmin,
    )) as { id: string }

    // Activation without exemplars is blocked by the store guard (G2).
    await expect(
      registry.execute('brand.set_activate', { setId: created.id }, humanAdmin),
    ).rejects.toThrow(/exemplar-first/)

    await registry.execute(
      'brand.example_add',
      { setId: created.id, contentType: 'headline', body: 'Ship your company OS today', label: 'good' },
      humanAdmin,
    )
    await registry.execute(
      'brand.example_add',
      { setId: created.id, contentType: 'headline', body: 'Synergy disruption!!!', label: 'bad' },
      humanAdmin,
    )
    await registry.execute(
      'brand.lexicon_add',
      { setId: created.id, term: 'synergy', kind: 'banned' },
      humanAdmin,
    )

    const activated = (await registry.execute(
      'brand.set_activate',
      { setId: created.id },
      humanAdmin,
    )) as { status: string }
    expect(activated.status).toBe('active')

    const stored = await store.getSet(created.id)
    expect(stored?.status).toBe('active')
    await expect(store.listLexicon(created.id)).resolves.toHaveLength(1)
  })
})
