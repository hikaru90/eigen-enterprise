import { describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { memoryManifest, THOUGHT_TOOL_NAMES } from './manifest'
import { createThoughtTools, type ThoughtToolService } from './thought-tools'

function fakeService(): ThoughtToolService {
  return {
    editThought: vi.fn(async (_u, id) => (id === 't1' ? { ok: true as const, thought: { id } } : { ok: false as const })),
    setThoughtStatus: vi.fn(async (_u, id, status) =>
      id === 't1' ? { ok: true as const, thought: { id, status } } : { ok: false as const },
    ),
    deleteThought: vi.fn(async (_u, id) =>
      id === 't1'
        ? { ok: true as const }
        : id === 'sys'
          ? { ok: false as const, reason: 'system_project_task' as const, projectLabel: 'Ops' }
          : { ok: false as const, reason: 'not_found' as const },
    ),
    deleteArchivedThoughts: vi.fn(async () => ({ deleted: 3 })),
    retryEnrichment: vi.fn(async (_u, id) =>
      id === 't1' ? { ok: true as const } : { ok: false as const, reason: 'not_retryable' as const },
    ),
    relinkThought: vi.fn(async (_u, id) => (id === 't1' ? { ok: true as const, thought: { id } } : { ok: false as const })),
    answerRelevance: vi.fn(async (_u, id, action) =>
      id === 't1' ? { ok: true as const, action } : { ok: false as const, reason: 'not_found' as const },
    ),
    answerGrounding: vi.fn(async () => undefined),
    dismissCheckIn: vi.fn(async () => undefined),
    isGroundingFacetKey: (k: string) => k === 'role',
    assignProject: vi.fn(async (_u, _t, target) => ({
      projectEntityId: 'p1',
      projectLabel: 'projectLabel' in target ? target.projectLabel : 'Launch',
      eligible: true,
      created: 'projectLabel' in target,
      isGtdProject: true,
    })),
    getThought: vi.fn(async (_u, id) => (id === 't1' ? { id, rawText: 'Call Bea' } : null)),
    listArchivedThoughtIds: vi.fn(async () => ['t1']),
    listRecentThoughts: vi.fn(async () => ({
      recentThoughts: [
        { id: 't1', normalizedText: 'Call Bea', category: 'task', createdAt: '2026-11-20T09:00:00.000Z', author: 'user', authorLabel: null, source: 'agent' },
        { id: 't2', normalizedText: 'Acme likes blue', category: 'preference', createdAt: '2026-11-19T09:00:00.000Z', author: 'agent', authorLabel: 'Coder', source: 'mcp' },
        { id: 't3', normalizedText: 'Old one', category: 'idea', createdAt: '2025-01-01T09:00:00.000Z', author: 'user', authorLabel: null, source: null },
      ],
      recentThoughtDetails: [
        { id: 't1', enrichmentComplete: true, queueStatus: 'complete', queueError: null },
        { id: 't2', enrichmentComplete: false, queueStatus: 'failed', queueError: 'LLM HTTP 500' },
        { id: 't3', enrichmentComplete: false, queueStatus: 'pending', queueError: null },
      ],
    })),
    listThoughtNotes: vi.fn(async () => [{ id: 'n1', title: 'Note' }]),
    linkNote: vi.fn(async (_u, t, n) =>
      t !== 't1' ? { linked: false, reason: 'thought_not_found' as const } : n === 'n1' ? { linked: true } : { linked: false, reason: 'text_file_not_found' as const },
    ),
    unlinkNote: vi.fn(async (_u, t) => t === 't1'),
    getNote: vi.fn(async (_u, id) =>
      id === 'mine'
        ? { editable: true, author: 'user', authorKeyId: null, authorLabel: null }
        : id === 'assistants'
          ? { editable: true, author: 'agent', authorKeyId: null, authorLabel: 'Assistant' }
          : id === 'colleague'
            ? { editable: false, author: 'user', authorKeyId: null, authorLabel: null }
            : null,
    ),
    deleteNote: vi.fn(async () => true),
    getEntity: vi.fn(async (_u, id) => (id === 'e1' ? { id, label: 'Acme', entityType: 'organization', canonicalKey: 'acme' } : null)),
    entityThoughts: vi.fn(async () => [{ id: 't1' }]),
    updateEntity: vi.fn(async (_u, id, patch) => (id === 'e1' ? { ok: true as const, entity: { id, ...patch } } : { ok: false as const })),
    deleteEntity: vi.fn(async (_u, id) =>
      id === 'e1' ? { ok: true as const } : id === 'sys' ? { ok: false as const, reason: 'system_project' as const } : { ok: false as const, reason: 'not_found' as const },
    ),
    syncEntity: vi.fn(async (_u, id) => (id === 'e1' ? { ok: true as const, repair: { repaired: 1 } } : { ok: false as const })),
    cleanUpGraph: vi.fn(async () => ({ pruned: 2 })),
    listConnectedAgents: vi.fn(async () => [{ id: 'a1', name: 'Coder', enabled: true }]),
    listAgentProjects: vi.fn(async () => [{ projectEntityId: 'p1' }]),
    assignToAgent: vi.fn(async (input) => ({ assignmentId: 'as1', agentId: input.agentId, agentName: 'Coder', thoughtId: input.thoughtId, status: 'pending' })),
    bindAgentProject: vi.fn(async () => ({ id: 'b1' })),
    unbindAgentProject: vi.fn(async () => undefined),
  } as unknown as ThoughtToolService
}

function setup(writer: { kind: 'self' | 'assistant'; userId: string } | null = { kind: 'self', userId: 'alex' }) {
  const svc = fakeService()
  const tools = createThoughtTools({ service: async () => svc, writerOf: async () => writer })
  const run = (name: string, input: unknown = {}) => {
    const t = tools.find((d) => d.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t.handler(ctx, input)
  }
  const ctx: ToolContext = { principal: { id: 'alex', kind: 'human', roles: ['member'] }, requestId: 'r' }
  return { svc, tools, run }
}

describe('memory thought / graph / note tools', () => {
  it('are exactly the manifest names, all in the memory module and listed in the manifest', () => {
    const { tools } = setup()
    expect(tools.map((t) => t.name).sort()).toEqual([...THOUGHT_TOOL_NAMES].sort())
    for (const t of tools) {
      expect(t.module).toBe('memory')
      expect(memoryManifest.tools).toContain(t.name)
    }
  })

  it('marks the for-good deletions destructive and the reads read', () => {
    const { tools } = setup()
    const by = (n: string) => tools.find((t) => t.name === n)!
    for (const n of ['memory.delete_thought', 'memory.delete_archived_thoughts', 'memory.delete_entity', 'memory.delete_text_file']) {
      expect(by(n).approvalRisk).toBe('destructive')
    }
    for (const n of ['memory.list_thoughts', 'memory.get_thought', 'memory.list_archived_thoughts', 'memory.list_thought_notes', 'memory.get_entity', 'memory.list_connected_agents', 'memory.list_agent_projects']) {
      expect(by(n).auditClass).toBe('read')
    }
  })

  it('acts as the person: every call runs with the writer’s user id', async () => {
    const { svc, run } = setup({ kind: 'assistant', userId: 'bea' })
    await run('memory.edit_thought', { thought_id: 't1', change: 'make it Friday' })
    expect(svc.editThought).toHaveBeenCalledWith('bea', 't1', 'make it Friday', { verbatim: false })
    await run('memory.clean_up_graph')
    expect(svc.cleanUpGraph).toHaveBeenCalledWith('bea')
  })

  it('edit_thought takes either a change in plain words or the new text verbatim, exactly one (wish 2f296da6)', async () => {
    const { svc, run } = setup({ kind: 'assistant', userId: 'bea' })
    await run('memory.edit_thought', { thought_id: 't1', text: 'Call Acme on Friday' })
    expect(svc.editThought).toHaveBeenCalledWith('bea', 't1', 'Call Acme on Friday', { verbatim: true })
    await expect(run('memory.edit_thought', { thought_id: 't1' })).rejects.toThrow()
    await expect(run('memory.edit_thought', { thought_id: 't1', change: 'a', text: 'b' })).rejects.toThrow()
  })

  it('fails loud when the run works for no one', async () => {
    const { run } = setup(null)
    await expect(run('memory.get_entity', { entity_id: 'e1' })).rejects.toBeInstanceOf(KernelError)
  })

  it('edits, opens/completes/archives, relinks and retries a thought, refusing unknown ones', async () => {
    const { run, svc } = setup()
    await expect(run('memory.set_thought_status', { thought_id: 't1', status: 'archived' })).resolves.toEqual({
      thought: { id: 't1', status: 'archived' },
    })
    await expect(run('memory.set_thought_status', { thought_id: 't1', status: 'gone' })).rejects.toThrow()
    await expect(run('memory.edit_thought', { thought_id: 'x', change: 'y' })).rejects.toThrow(/not in your Memory/)
    await expect(run('memory.relink_thought', { thought_id: 't1' })).resolves.toEqual({ thought: { id: 't1' } })
    await expect(run('memory.retry_enrichment', { thought_id: 't1' })).resolves.toEqual({ ok: true, thoughtId: 't1' })
    await expect(run('memory.retry_enrichment', { thought_id: 't2' })).rejects.toThrow(/not eligible/)
    expect(svc.setThoughtStatus).toHaveBeenCalledTimes(1)
  })

  it('deletes a thought for good, and refuses a company project’s task', async () => {
    const { run } = setup()
    await expect(run('memory.delete_thought', { thought_id: 't1' })).resolves.toEqual({ deleted: true, thoughtId: 't1' })
    await expect(run('memory.delete_thought', { thought_id: 'sys' })).rejects.toThrow(/Ops/)
    await expect(run('memory.delete_archived_thoughts')).resolves.toEqual({ deleted: 3 })
  })

  it('answers a check-in: keep/archive a thought, a grounding answer, or dismiss', async () => {
    const { run, svc } = setup()
    await expect(run('memory.answer_check_in', { kind: 'relevance', thought_id: 't1', action: 'keep' })).resolves.toEqual({
      kind: 'relevance',
      action: 'keep',
    })
    expect(svc.dismissCheckIn).toHaveBeenCalledWith('alex')
    await expect(run('memory.answer_check_in', { kind: 'relevance', thought_id: 'x', action: 'archive' })).rejects.toThrow()
    await run('memory.answer_check_in', { kind: 'grounding', facet_key: 'role', answer: 'Founder' })
    expect(svc.answerGrounding).toHaveBeenCalledWith('alex', 'role', 'Founder')
    await expect(run('memory.answer_check_in', { kind: 'grounding', facet_key: 'nope', answer: 'x' })).rejects.toThrow(/facet_key/)
    await expect(run('memory.answer_check_in', { kind: 'dismiss' })).resolves.toEqual({ kind: 'dismiss', dismissed: true })
  })

  it('assigns a thought to a project by id or by name, not both', async () => {
    const { run, svc } = setup()
    await run('memory.assign_thought_project', { thought_id: 't1', project_label: 'New' })
    expect(svc.assignProject).toHaveBeenCalledWith('alex', 't1', { projectLabel: 'New' })
    await expect(run('memory.assign_thought_project', { thought_id: 't1', project_entity_id: 'p', project_label: 'q' })).rejects.toThrow()
    await expect(run('memory.assign_thought_project', { thought_id: 't1' })).rejects.toThrow()
  })

  it('links, unlinks and lists a thought’s notes', async () => {
    const { run } = setup()
    await expect(run('memory.link_text_file', { thought_id: 't1', text_file_id: 'n1' })).resolves.toEqual({ linked: true, thoughtId: 't1', textFileId: 'n1' })
    await expect(run('memory.link_text_file', { thought_id: 't1', text_file_id: 'n9' })).rejects.toThrow(/Note not found/)
    await expect(run('memory.unlink_text_file', { thought_id: 't9', text_file_id: 'n1' })).rejects.toThrow(/not linked/)
    await expect(run('memory.list_thought_notes', { thought_id: 't1' })).resolves.toEqual({ notes: [{ id: 'n1', title: 'Note' }] })
  })

  it('deletes a note: the person their own, the assistant only what it wrote, nobody a colleague’s', async () => {
    const self = setup()
    await expect(self.run('memory.delete_text_file', { text_file_id: 'mine' })).resolves.toEqual({ deleted: true, textFileId: 'mine' })
    await expect(self.run('memory.delete_text_file', { text_file_id: 'colleague' })).rejects.toBeInstanceOf(KernelError)
    await expect(self.run('memory.delete_text_file', { text_file_id: 'none' })).rejects.toThrow(/Note not found/)
    const asst = setup({ kind: 'assistant', userId: 'alex' })
    await expect(asst.run('memory.delete_text_file', { text_file_id: 'mine' })).rejects.toBeInstanceOf(KernelError)
    await expect(asst.run('memory.delete_text_file', { text_file_id: 'assistants' })).resolves.toEqual({ deleted: true, textFileId: 'assistants' })
  })

  it('reads, edits, deletes and re-syncs an entity; cleans up the graph', async () => {
    const { run } = setup()
    await expect(run('memory.get_entity', { entity_id: 'e1' })).resolves.toMatchObject({ entity: { label: 'Acme' }, thoughts: [{ id: 't1' }] })
    await expect(run('memory.get_entity', { entity_id: 'e9' })).rejects.toThrow(/Entity not found/)
    await expect(run('memory.update_entity', { entity_id: 'e1', label: 'Acme GmbH' })).resolves.toEqual({ entity: { id: 'e1', label: 'Acme GmbH' } })
    await expect(run('memory.update_entity', { entity_id: 'e1' })).rejects.toThrow()
    await expect(run('memory.delete_entity', { entity_id: 'sys' })).rejects.toBeInstanceOf(KernelError)
    await expect(run('memory.delete_entity', { entity_id: 'e1' })).resolves.toEqual({ deleted: true, entityId: 'e1' })
    await expect(run('memory.sync_entity', { entity_id: 'e1' })).resolves.toEqual({ ok: true, repair: { repaired: 1 } })
    await expect(run('memory.clean_up_graph')).resolves.toEqual({ pruned: 2 })
  })

  it('lists connected agents, hands them a thought and binds/unbinds projects', async () => {
    const { run, svc } = setup()
    await expect(run('memory.list_connected_agents')).resolves.toEqual({ agents: [{ id: 'a1', name: 'Coder', enabled: true }] })
    await run('memory.assign_thought_to_agent', { agent_id: 'a1', thought_id: 't1' })
    expect(svc.assignToAgent).toHaveBeenCalledWith({ userId: 'alex', agentId: 'a1', thoughtId: 't1' })
    await run('memory.bind_agent_project', { agent_id: 'a1', project_entity_id: 'p1' })
    expect(svc.bindAgentProject).toHaveBeenCalledWith({ userId: 'alex', agentId: 'a1', projectEntityId: 'p1' })
    await expect(run('memory.unbind_agent_project', { agent_id: 'a1', project_entity_id: 'p1' })).resolves.toEqual({ unbound: true })
    await expect(run('memory.list_agent_projects', { agent_id: 'a1' })).resolves.toEqual({ bindings: [{ projectEntityId: 'p1' }] })
  })

  it('reads one of the person’s own thoughts and lists their archived ones', async () => {
    const { run, svc } = setup({ kind: 'assistant', userId: 'bea' })
    await expect(run('memory.get_thought', { thought_id: 't1' })).resolves.toEqual({ thought: { id: 't1', rawText: 'Call Bea' } })
    expect(svc.getThought).toHaveBeenCalledWith('bea', 't1')
    await expect(run('memory.get_thought', { thought_id: 'x' })).rejects.toThrow(/not in your Memory/)
    await expect(run('memory.list_archived_thoughts', { limit: 10 })).resolves.toEqual({ thoughts: [{ id: 't1', rawText: 'Call Bea' }] })
    expect(svc.listArchivedThoughtIds).toHaveBeenCalledWith('bea', 10)
  })
  it('lists what the brain took in, newest first: source, category, date and whether it is indexed (Memory › What the brain knows)', async () => {
    const { run, svc } = setup({ kind: 'assistant', userId: 'bea' })
    await expect(run('memory.list_thoughts', { limit: 3, category: 'task' })).resolves.toEqual({
      thoughts: [
        { id: 't1', text: 'Call Bea', category: 'task', createdAt: '2026-11-20T09:00:00.000Z', source: { kind: 'assistant' }, status: 'indexed', error: null },
        { id: 't2', text: 'Acme likes blue', category: 'preference', createdAt: '2026-11-19T09:00:00.000Z', source: { kind: 'connected_agent', name: 'Coder' }, status: 'failed', error: 'LLM HTTP 500' },
        { id: 't3', text: 'Old one', category: 'idea', createdAt: '2025-01-01T09:00:00.000Z', source: { kind: 'unrecorded' }, status: 'pending', error: null },
      ],
    })
    expect(svc.listRecentThoughts).toHaveBeenCalledWith('bea', 3, 'task')
    await run('memory.list_thoughts', {})
    expect(svc.listRecentThoughts).toHaveBeenLastCalledWith('bea', 30, undefined)
    await expect(run('memory.list_thoughts', { limit: 51 })).rejects.toThrow()
  })
})
