import type { DraftDeps } from './handover-upkeep'
import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { memoryHandoverStore } from '$lib/server/memory/handover/memory-store'
import type { HandoverDeps, HandoverEntryView, HandoverView } from '$lib/server/memory/handover/service'
import { createHandoverTools, HANDOVER_TOOL_NAMES } from './handover-tools'
import { memoryManifest } from './manifest'

const people = [
  { id: 'ony', name: 'Ony', email: 'ony@k.co' },
  { id: 'alex', name: 'Alex', email: 'alex@k.co' },
]

function setup(writer: { kind: 'self' | 'assistant'; userId: string } | null = { kind: 'assistant', userId: 'ony' }) {
  const assign = vi.fn(async () => ({ id: 'task-1' }))
  const deps: HandoverDeps = {
    store: memoryHandoverStore(),
    directory: { get: async (id) => people.find((p) => p.id === id) ?? null, list: async () => people },
    tasks: { assign, status: async () => 'open' as const },
    now: () => new Date('2026-11-25T09:00:00Z'),
  }
  const draft: DraftDeps = {
    handover: deps,
    decideStatus: vi.fn(async () => ({
      kind: 'memory.handover_status',
      status: 'enforced' as const,
      decisionId: 'd',
      outcome: 'decided' as const,
      choice: 'in_progress' as const,
      confidence: 0.9,
      distribution: null,
      source: 'jev' as const,
      jev: null,
    })),
    writeSentence: vi.fn(async () => 'The lawyer reviews option B.'),
  }
  const writerOf = vi.fn(async () => writer)
  const tools = createHandoverTools({ deps: async () => deps, draftDeps: async () => draft, writerOf })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const agent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['agent'] }, requestId: 'r' }
  return { tool, agent, writerOf, assign }
}

describe('handover.* tools', () => {
  it('the memory module owns the handover namespace and lists every handover tool', () => {
    expect(memoryManifest.toolNamespaces).toContain('handover')
    const { tool } = setup()
    for (const name of HANDOVER_TOOL_NAMES) {
      expect(memoryManifest.tools).toContain(name)
      expect(tool(name).module).toBe('memory')
      expect(tool(name).permission.roles).toEqual(['admin', 'member', 'agent'])
    }
  })

  it('declares audit classes: reads are reads, writes carry an activity sentence', () => {
    const { tool } = setup()
    expect(tool('handover.list').auditClass).toBe('read')
    expect(tool('handover.get').auditClass).toBe('read')
    for (const name of HANDOVER_TOOL_NAMES.filter((n) => n !== 'handover.list' && n !== 'handover.get')) {
      expect(tool(name).auditClass).toBe('mutate')
      expect(tool(name).activity).toBeTypeOf('function')
    }
  })

  it('the assistant creates, fills and assigns for the person it works for; a colleague reads it', async () => {
    const { tool, agent, writerOf, assign } = setup()
    const h = (await tool('handover.create').handler(agent, { title: 'Handover to Alex', subject_id: 'alex' })) as HandoverView
    expect(tool('handover.create').activity!({ title: 'Handover to Alex' }, h)).toBe("Ony started the handover 'Handover to Alex'")
    const e = (await tool('handover.add_entry').handler(agent, {
      handover_id: h.id,
      topic: 'Office lease',
      sentence: 'Two options for the renewal.',
      status: 'decision_needed',
      link: '/m/drive/file/abc',
    })) as HandoverEntryView
    expect(e).toMatchObject({ writtenVia: 'assistant', status: 'decision_needed' })
    const assigned = (await tool('handover.assign_entry').handler(agent, { entry_id: e.id, assignee_id: 'alex' })) as HandoverEntryView
    expect(assign).toHaveBeenCalledWith({ userId: 'ony', via: 'assistant' }, expect.objectContaining({ assigneeId: 'alex' }))
    expect(tool('handover.assign_entry').activity!({ entry_id: e.id, assignee_id: 'alex' }, assigned)).toBe("Assigned 'Office lease' to Alex")

    writerOf.mockResolvedValue({ kind: 'assistant', userId: 'alex' })
    const read = (await tool('handover.get').handler(agent, { handover_id: h.id })) as HandoverView
    expect(read).toMatchObject({ canEdit: false, entries: [{ topic: 'Office lease', assignee: { name: 'Alex' } }] })
    await expect(tool('handover.update_entry').handler(agent, { entry_id: e.id, status: 'for_info' })).rejects.toMatchObject({ code: 'forbidden' })
    const listed = (await tool('handover.list').handler(agent, {})) as { handovers: Array<{ title: string; decisionsNeeded: number }> }
    expect(listed.handovers).toEqual([expect.objectContaining({ title: 'Handover to Alex', decisionsNeeded: 1 })])
  })

  it('update_entry with an empty link removes it; remove_entry removes the entry', async () => {
    const { tool, agent } = setup()
    const h = (await tool('handover.create').handler(agent, { title: 'H' })) as HandoverView
    const e = (await tool('handover.add_entry').handler(agent, { handover_id: h.id, topic: 'T', sentence: 'S.', status: 'for_info', link: 'https://example.com/x' })) as HandoverEntryView
    expect(await tool('handover.update_entry').handler(agent, { entry_id: e.id, link: '' })).toMatchObject({ link: null })
    expect(await tool('handover.remove_entry').handler(agent, { entry_id: e.id })).toEqual({ id: e.id, removed: true })
  })

  it('draft_entry by the assistant is the brain’s upkeep', async () => {
    const { tool, agent } = setup()
    const h = (await tool('handover.create').handler(agent, { title: 'H' })) as HandoverView
    const out = await tool('handover.draft_entry').handler(agent, { handover_id: h.id, topic: 'Office lease', source: 'We chose B; the lawyer reviews it.' })
    expect(out).toMatchObject({ outcome: 'added', entry: { status: 'in_progress', sentence: 'The lawyer reviews option B.', writtenVia: 'brain' } })
    expect(tool('handover.draft_entry').activity!({ handover_id: h.id, topic: 'Office lease', source: 'x' }, out)).toBe("Refreshed 'Office lease' in a handover")
  })

  it('an agent working for no one reads and changes nothing', async () => {
    const { tool, agent } = setup(null)
    await expect(tool('handover.list').handler(agent, {})).rejects.toThrow(/works for no one/)
    await expect(tool('handover.create').handler(agent, { title: 'X' })).rejects.toThrow(/works for no one/)
  })

  it('rejects an unknown status and a malformed day at the schema', () => {
    const { tool } = setup()
    const add = tool('handover.add_entry').inputSchema
    const ok = { handover_id: 'h', topic: 'T', sentence: 'S.', status: 'for_info' }
    expect(add.safeParse(ok).success).toBe(true)
    expect(add.safeParse({ ...ok, status: 'urgent' }).success).toBe(false)
    expect(add.safeParse({ ...ok, entry_on: 'Friday' }).success).toBe(false)
  })
})
