import type { CorpusRegistry } from '../corpus/runtime'
import type { BrandCorpusItem } from '../style-format/corpus'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { InMemoryBrandStore, REQUIRED_VISUAL_ROLES } from '../store'
import { brandSeedsSchema } from '../style-format/seeds'
import { createBrandSelectionTools } from './tools'

const humanAdmin: ToolContext = {
  principal: { id: 'owner-1', kind: 'human', roles: ['admin'] },
  requestId: 'req-1',
}

const agentPrincipal: ToolContext = {
  principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] },
  requestId: 'req-2',
}

function seeds(hue: number) {
  return brandSeedsSchema.parse({
    seedColor: { l: 0.75, c: 0.06, h: hue },
    neutralTintHue: hue,
    accentHueShift: null,
    chromaCurve: 'muted',
    darkModeStrategy: 'invert-tone',
    fonts: { fontPrimary: 'Inter', fontSecondary: 'Lora', fontMono: 'Geist Mono' },
    fluidScale: {
      baseSize: { min: 16, max: 18 },
      scaleRatio: { min: 1.125, max: 1.2 },
      viewport: { min: 400, max: 1200 },
      scaleSteps: 4,
      trackingCurve: 'neutral',
    },
    spaceRhythm: [0.25, 0.5, 1, 2],
    shapeCharacter: 'soft',
    radiusBase: '0.75rem',
    elevation: 'flat',
    motionPersonality: 'productive',
    grain: 0,
  })
}

function pastel(id: string, name: string, hue: number): BrandCorpusItem {
  return {
    id,
    name,
    seeds: seeds(hue),
    cssVars: {
      '--background': 'oklch(0.985 0.005 300)',
      '--foreground': 'oklch(0.247 0.005 300)',
      '--primary': `oklch(0.75 0.06 ${hue})`,
      '--secondary': `oklch(0.9 0.03 ${hue})`,
      '--accent': `oklch(0.9 0.03 ${hue})`,
      '--muted': 'oklch(0.931 0.005 300)',
      '--border': 'oklch(0.697 0.005 300)',
      '--ring': `oklch(0.75 0.05 ${hue})`,
      '--card': 'oklch(0.985 0.005 300)',
      '--destructive': 'oklch(0.536 0.2 27)',
      '--radius': '0.75rem',
      '--space-1': 'clamp(0.25rem, 0.2rem + 0.025vw, 0.3rem)',
      '--font-sans': '"Inter"',
      '--font-display': '"Lora"',
      '--font-mono': '"Geist Mono"',
    },
    darkCssVars: { '--background': 'oklch(0.13 0.005 300)' },
    provenance: { source: 'archetype' },
    createdAt: '2026-09-09T00:00:00.000Z',
  }
}

const A = pastel('3a000000-0000-4000-8000-00000000000a', 'pastel-a', 290)
const B = pastel('3b000000-0000-4000-8000-00000000000b', 'pastel-b', 300)
const C = pastel('3c000000-0000-4000-8000-00000000000c', 'pastel-c', 310)
const D = pastel('3d000000-0000-4000-8000-00000000000d', 'pastel-d', 320)
const E = pastel('3e000000-0000-4000-8000-00000000000e', 'pastel-e', 330)
const F = pastel('3f000000-0000-4000-8000-00000000000f', 'pastel-f', 340)

const toyCorpus: CorpusRegistry = (() => {
  const items = [A, B, C, D, E, F]
  const byId = new Map(items.map((item) => [item.id, item]))
  return {
    items,
    index: {
      builtAt: '2026-09-09T00:00:00.000Z',
      itemCount: items.length,
      knn: {},
      clusters: [{ id: 'cluster-1', name: 'Pastel family', memberIds: items.map((i) => i.id), centroidVector: [] }],
    },
    item(id: string) {
      const hit = byId.get(id)
      if (!hit) throw new Error(`unknown corpus item: ${id}`)
      return hit
    },
    summary: (item) => ({
      id: item.id,
      name: item.name,
      provenanceSource: item.provenance.source,
      cssVars: item.cssVars,
      darkCssVars: item.darkCssVars,
    }),
    clusters: () => [{ id: 'cluster-1', name: 'Pastel family', memberIds: items.map((i) => i.id) }],
  }
})()

const ACTIVATIONS = new InMemoryActivationStore()

/** cssVars covering every activation-required role (V9 guard fixture). */
function completeCssVars(bg = '#e8ede5'): Record<string, string> {
  return Object.fromEntries(
    REQUIRED_VISUAL_ROLES.map((role) => [`--${role}`, role === 'radius' ? '0.25rem' : bg]),
  )
}

function activatedRegistry() {
  const store = new InMemoryBrandStore()
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    activationStore: ACTIVATIONS,
    approvalStore: new InMemoryApprovalStore(),
    vcsCommitter: null,
  })
  for (const descriptor of createBrandSelectionTools({ store, corpus: toyCorpus })) {
    registry.register(descriptor)
  }
  return { store, registry }
}

describe('createBrandSelectionTools — descriptors', () => {
  const tools = createBrandSelectionTools({ store: new InMemoryBrandStore(), corpus: toyCorpus })

  it('exposes the seven wizard tools with namespaced names', () => {
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'brand.corpus_get',
        'brand.corpus_list',
        'brand.selection_matches',
        'brand.visual_set_activate',
        'brand.visual_set_create',
        'brand.visual_set_get',
        'brand.visual_set_list',
      ].sort(),
    )
  })

  it('reads are admin+agent; the visual-set mutations are admin-only (G8)', () => {
    for (const descriptor of tools) {
      if (descriptor.auditClass === 'read') {
        expect(descriptor.permission.roles).toEqual(['admin', 'agent'])
      } else {
        expect(descriptor.permission.roles).toEqual(['admin'])
      }
    }
    expect(tools.filter((t) => t.auditClass === 'mutate').map((t) => t.name)).toEqual([
      'brand.visual_set_create',
      'brand.visual_set_activate',
    ])
  })
})

describe('selection wizard tools through the kernel pipeline', () => {
  it('an agent can browse the corpus and compute matches (pure reads)', async () => {
    const { registry } = activatedRegistry()
    await ACTIVATIONS.set('brand', true)
    await expect(registry.execute('brand.corpus_list', {}, agentPrincipal)).resolves.toMatchObject({
      itemCount: 6,
      clusters: [{ id: 'cluster-1', name: 'Pastel family' }],
    })
    const result = (await registry.execute(
      'brand.selection_matches',
      { pickedIds: [A.id, B.id, C.id] },
      agentPrincipal,
    )) as { matches: Array<{ item: { id: string }; distance: number }> }
    expect(result.matches).toHaveLength(3)
    expect(result.matches.map((m) => m.item.id)).not.toContain(A.id)
    for (let i = 1; i < result.matches.length; i++) {
      expect(result.matches[i - 1]!.distance).toBeLessThanOrEqual(result.matches[i]!.distance)
    }
  })

  it('selection_matches enforces the >=3 pick unlock at schema level', async () => {
    const { registry } = activatedRegistry()
    await ACTIVATIONS.set('brand', true)
    await expect(
      registry.execute('brand.selection_matches', { pickedIds: [A.id, B.id] }, humanAdmin),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('an agent principal with the admin ROLE cannot create visual sets (G8)', async () => {
    const { registry } = activatedRegistry()
    await ACTIVATIONS.set('brand', true)
    await expect(
      registry.execute(
        'brand.visual_set_create',
        {
          name: 'Agent draft',
          pickedIds: [A.id, B.id, C.id],
          cssVars: { '--background': '#fff' },
        },
        agentPrincipal,
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('an agent principal with the admin ROLE cannot activate visual sets (G8)', async () => {
    const { store, registry } = activatedRegistry()
    await ACTIVATIONS.set('brand', true)
    const draft = await store.createVisualSet({
      name: 'Draft',
      pickedItemIds: [A.id, B.id, C.id],
      cssVars: completeCssVars(),
    })
    // This registry wires no approval policy, so the human-guard is what
    // rejects — the agent principal never reaches the store (the approval
    // flow itself is covered against the wired kernel in modules/index.spec).
    await expect(
      registry.execute('brand.visual_set_activate', { setId: draft.id }, agentPrincipal),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(store.getVisualSet(draft.id)).resolves.toMatchObject({ status: 'draft' })
  })

  it('visual_set_activate flips a complete draft to active (guards enforced)', async () => {
    const { store, registry } = activatedRegistry()
    await ACTIVATIONS.set('brand', true)
    const draft = await store.createVisualSet({
      name: 'Kindred identity',
      pickedItemIds: [A.id, B.id, C.id],
      cssVars: completeCssVars(),
    })
    await expect(
      registry.execute('brand.visual_set_activate', { setId: draft.id }, humanAdmin),
    ).resolves.toMatchObject({ id: draft.id, status: 'active' })
    await expect(store.getActiveVisualSet()).resolves.toMatchObject({ id: draft.id })
  })

  it('visual_set_activate propagates the store guard loud on incomplete cssVars', async () => {
    const { store, registry } = activatedRegistry()
    await ACTIVATIONS.set('brand', true)
    const incomplete = await store.createVisualSet({
      name: 'Incomplete',
      pickedItemIds: [A.id, B.id, C.id],
      cssVars: { '--background': '#fff' },
    })
    await expect(
      registry.execute('brand.visual_set_activate', { setId: incomplete.id }, humanAdmin),
    ).rejects.toThrow(/missing required roles/)
  })

  it('visual_set_create lands a draft row and backfills seeds from the source corpus item', async () => {
    const { store, registry } = activatedRegistry()
    await ACTIVATIONS.set('brand', true)
    const created = (await registry.execute(
      'brand.visual_set_create',
      {
        name: 'Kindred draft',
        sourceItemId: B.id,
        pickedIds: [A.id, B.id, C.id],
        cssVars: { '--background': '#fff', '--primary': '#333' },
      },
      humanAdmin,
    )) as { id: string; status: string; seeds: unknown; sourceItemId: string }
    expect(created.status).toBe('draft')
    expect(created.sourceItemId).toBe(B.id)
    expect(created.seeds).toEqual(B.seeds)
    await expect(store.getVisualSet(created.id)).resolves.toMatchObject({ id: created.id })
  })

  it('visual_set_create fails loud on an unknown sourceItemId', async () => {
    const { registry } = activatedRegistry()
    await ACTIVATIONS.set('brand', true)
    await expect(
      registry.execute(
        'brand.visual_set_create',
        {
          name: 'Bad ref',
          sourceItemId: '4e000000-0000-4000-8000-00000000000e',
          pickedIds: [A.id, B.id, C.id],
          cssVars: { '--background': '#fff' },
        },
        humanAdmin,
      ),
    ).rejects.toThrow(/unknown corpus item/)
  })

  it('visual_set_get and visual_set_list read the draft back', async () => {
    const { store, registry } = activatedRegistry()
    await ACTIVATIONS.set('brand', true)
    const created = await store.createVisualSet({
      name: 'Trail draft',
      pickedItemIds: [A.id, B.id, D.id],
      cssVars: { '--background': '#fff' },
    })
    await expect(
      registry.execute('brand.visual_set_get', { setId: created.id }, humanAdmin),
    ).resolves.toMatchObject({ id: created.id, name: 'Trail draft' })
    await expect(registry.execute('brand.visual_set_list', {}, humanAdmin)).resolves.toHaveLength(1)
  })
})
