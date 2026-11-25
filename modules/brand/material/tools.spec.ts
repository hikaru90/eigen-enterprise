import type { MaterialRenderer } from './export'
import type { MaterialChat } from './texts'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { InMemoryBrandStore } from '../store'
import { createBrandMaterialTools } from './tools'

/** The company brain acting as Ana (CB3: the principal IS the person). */
const agentCtx: ToolContext = {
  principal: delegatedPrincipal({ id: 'ana', roles: ['admin', 'member'] }, 'orchestrator'),
  requestId: 'req-1',
}

const active = {
  id: 's1',
  name: 'Blueprint',
  cssVars: {
    '--background': '#ffffff',
    '--foreground': '#111111',
    '--primary': '#b00000',
    '--primary-foreground': '#ffffff',
    '--accent': '#006600',
    '--muted-foreground': '#555555',
  },
  darkCssVars: null,
}

async function wired(chat: MaterialChat = async () => ({ choices: [] })) {
  const brand = Object.assign(new InMemoryBrandStore(), { findActiveVisualSet: async () => active })
  const htmls: string[] = []
  const render: MaterialRenderer = async (html) => {
    htmls.push(html)
    return { bytes: new Uint8Array([37, 80, 68, 70]), mime: 'application/pdf' }
  }
  const logo = async () => ({ mime: 'image/png', bytes: new Uint8Array([1]) })
  const activations = new InMemoryActivationStore()
  await activations.set('brand', true)
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    activationStore: activations,
    approvalStore: new InMemoryApprovalStore(),
    vcsCommitter: null,
  })
  for (const d of createBrandMaterialTools({ brand, chat, logo, render })) registry.register(d)
  return { registry, htmls }
}

describe('brand material tools', () => {
  it('both are reads (nothing is saved), open to every member and the assistant', async () => {
    const tools = createBrandMaterialTools({ brand: new InMemoryBrandStore() })
    expect(tools.map((t) => t.name).sort()).toEqual(['brand.material_export', 'brand.material_text_suggest'])
    for (const t of tools) {
      expect(t.auditClass).toBe('read')
      expect(t.permission.roles).toEqual(['admin', 'member', 'agent'])
    }
    const exportTool = tools.find((t) => t.name === 'brand.material_export')!
    for (const id of ['flyer-a5', 'banner-social', 'banner-rollup', 'poster-a1', 'poster-a2', 'merch-shirt', 'merch-mug', 'merch-tote'])
      expect(exportTool.summary).toContain(id)
  })

  it('exports a piece as base64 with its file name, through the kernel', async () => {
    const { registry, htmls } = await wired()
    const out = await registry.execute('brand.material_export', { formatId: 'flyer-a5', headline: 'Hall 3', body: 'Come by.', cta: 'Find us' }, agentCtx)
    expect(out).toEqual({
      formatId: 'flyer-a5',
      filename: 'hall-3-flyer-a5.pdf',
      mime: 'application/pdf',
      sizeBytes: 4,
      logo: true,
      dataB64: Buffer.from([37, 80, 68, 70]).toString('base64'),
    })
    expect(htmls[0]).toContain('Hall 3')
  })

  it('refuses an unknown format at the schema', async () => {
    const { registry } = await wired()
    await expect(registry.execute('brand.material_export', { formatId: 'billboard', headline: 'x' }, agentCtx)).rejects.toThrow()
  })

  it('text suggestions run on the acting person’s gateway identity', async () => {
    const seen: string[] = []
    const chat: MaterialChat = async (input) => {
      seen.push(input.userId)
      return { choices: [{ message: { content: JSON.stringify({ variants: [{ headline: 'A' }, { headline: 'B' }, { headline: 'C' }] }) } }] }
    }
    const { registry } = await wired(chat)
    const out = await registry.execute('brand.material_text_suggest', { formatId: 'merch-shirt', brief: 'summer fair' }, agentCtx)
    expect(out).toMatchObject({ formatId: 'merch-shirt', voice: false, variants: [{ headline: 'A' }, { headline: 'B' }, { headline: 'C' }] })
    expect(seen).toEqual(['ana'])
  })
})
