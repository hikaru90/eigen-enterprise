import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { InMemoryBrandStore, REQUIRED_VISUAL_ROLES } from '../store'
import { parsePickerIndex } from '../taxonomy/load-index'
import fixture from '../taxonomy/test-fixtures/picker-fixture.json'
import { createBrandPickerChooseTool } from './picker-tool'

const owner: ToolContext = { principal: { id: 'owner-1', kind: 'human', roles: ['owner', 'admin'] }, requestId: 'r1' }
const admin: ToolContext = { principal: { id: 'admin-1', kind: 'human', roles: ['admin'] }, requestId: 'r2' }
const agent: ToolContext = { principal: { id: 'orch', kind: 'agent', roles: ['owner', 'admin', 'agent'] }, requestId: 'r3' }

async function setup() {
  const store = new InMemoryBrandStore()
  const activations = new InMemoryActivationStore()
  await activations.set('brand', true)
  // Even with visual_set_activate gated, the picker choice is the owner's own click (D11) — no approval.
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    activationStore: activations,
    approvalPolicy: new StaticApprovalPolicy(new Set(['brand.visual_set_activate'])),
    approvalStore: new InMemoryApprovalStore(),
  })
  registry.register(createBrandPickerChooseTool({ store, pickerIndex: () => parsePickerIndex(fixture, 'fixture') }))
  return { store, registry }
}

describe('brand.picker_choose', () => {
  it('owner choice creates a visual set from the node tokens (light + dark) and activates it, retiring the previous one', async () => {
    const { store, registry } = await setup()
    const first = (await registry.execute('brand.picker_choose', { nodeId: 'swiss-grid-red' }, owner)) as {
      id: string
      status: string
      pickerNodeId: string
      name: string
      cssVars: Record<string, string>
      darkCssVars: Record<string, string>
    }
    expect(first.status).toBe('active')
    expect(first.pickerNodeId).toBe('swiss-grid-red')
    expect(first.name).toBe('Signal red')
    for (const role of REQUIRED_VISUAL_ROLES) {
      expect(first.cssVars[`--${role}`]).toBeTruthy()
      expect(first.darkCssVars[`--${role}`]).toBeTruthy()
    }
    expect(first.cssVars['--primary']).toBe('#c8102e')
    expect(first.darkCssVars['--primary']).toBe('#ff6075')

    const second = (await registry.execute('brand.picker_choose', { nodeId: 'editorial-modern-amber' }, owner)) as { id: string }
    expect((await store.getActiveVisualSet()).id).toBe(second.id)
    expect((await store.getVisualSet(first.id))?.status).toBe('retired')
  })

  it('refuses a non-owner human and an agent (fail closed)', async () => {
    const { store, registry } = await setup()
    await expect(registry.execute('brand.picker_choose', { nodeId: 'swiss-grid-red' }, admin)).rejects.toMatchObject({
      code: 'permission_denied',
    })
    await expect(registry.execute('brand.picker_choose', { nodeId: 'swiss-grid-red' }, agent)).rejects.toMatchObject({
      code: 'permission_denied',
    })
    expect(await store.listVisualSets()).toEqual([])
  })

  it('rejects an unknown node and a non-final node', async () => {
    const { store, registry } = await setup()
    await expect(registry.execute('brand.picker_choose', { nodeId: 'ghost' }, owner)).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(registry.execute('brand.picker_choose', { nodeId: 'swiss-grid' }, owner)).rejects.toMatchObject({
      code: 'invalid_input',
    })
    expect(await store.listVisualSets()).toEqual([])
  })
})
