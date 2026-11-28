import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { memoryTeamQuestionStore } from '$lib/server/memory/team-questions/memory-store'
import type { TeamQuestionDeps, TeamQuestionView } from '$lib/server/memory/team-questions/service'
import { memoryManifest } from './manifest'
import { createQuestionTools, QUESTION_TOOL_NAMES } from './question-tools'

type Writer = { kind: 'self' | 'assistant'; userId: string } | null

function setup(writer: Writer = { kind: 'assistant', userId: 'ony' }) {
  const members = [
    { id: 'ony', name: 'Ony' },
    { id: 'alex', name: 'Alex' },
    { id: 'kim', name: 'Kim' },
  ]
  const deps: TeamQuestionDeps = {
    store: memoryTeamQuestionStore(),
    notify: async () => {},
    directory: { get: async (id) => members.find((m) => m.id === id) ?? null, list: async () => members },
    groups: { list: async () => [{ id: 'g-sales', name: 'Sales', memberIds: ['alex'] }] },
    brain: { rememberAnswer: async () => ({ thoughtId: 't-1' }) },
  }
  const writerOf = vi.fn(async (): Promise<Writer> => writer)
  const tools = createQuestionTools({ deps: async () => deps, writerOf })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const agent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['agent'] }, requestId: 'r' }
  const as = (userId: string) => writerOf.mockResolvedValue({ kind: 'self', userId })
  return { tool, agent, as }
}

describe('questions.* tools', () => {
  it('the memory module owns the questions namespace and lists every question tool', () => {
    expect(memoryManifest.toolNamespaces).toContain('questions')
    expect(QUESTION_TOOL_NAMES).toEqual(['questions.ask', 'questions.list', 'questions.get', 'questions.answer', 'questions.close', 'questions.tags'])
    for (const name of QUESTION_TOOL_NAMES) expect(memoryManifest.tools).toContain(name)
  })

  it('declares audit classes; every write carries an activity sentence; every member reaches them', () => {
    const { tool } = setup()
    for (const name of ['questions.list', 'questions.get', 'questions.tags']) expect(tool(name).auditClass).toBe('read')
    for (const name of ['questions.ask', 'questions.answer', 'questions.close']) {
      expect(tool(name).auditClass).toBe('mutate')
      expect(tool(name).activity).toBeTypeOf('function')
    }
    for (const name of QUESTION_TOOL_NAMES) expect(tool(name).permission.roles).toEqual(['admin', 'member', 'agent'])
  })

  it('the assistant asks Sales for the person; Alex finds it open for him, answers; Ony closes it', async () => {
    const { tool, agent, as } = setup()
    const input = { text: 'Who owns the Acme renewal?', tags: ['Sales', 'acme'], group_ids: ['g-sales'] }
    const q = (await tool('questions.ask').handler(agent, input)) as TeamQuestionView
    expect(q).toMatchObject({ tags: ['sales', 'acme'], createdVia: 'assistant', audience: { kind: 'chosen', groups: [{ name: 'Sales' }] } })
    expect(tool('questions.ask').activity!(input, q)).toBe('Ony asked Sales: Who owns the Acme renewal?')

    as('kim')
    expect(((await tool('questions.list').handler(agent, {})) as { questions: unknown[] }).questions).toEqual([])
    await expect(tool('questions.get').handler(agent, { question_id: q.id })).rejects.toThrow(/not found/)

    as('alex')
    const open = (await tool('questions.list').handler(agent, { for_me: true })) as { questions: TeamQuestionView[] }
    expect(open.questions.map((x) => x.id)).toEqual([q.id])
    expect(await tool('questions.tags').handler(agent, {})).toEqual({ tags: [{ tag: 'acme', count: 1 }, { tag: 'sales', count: 1 }] })
    const answered = (await tool('questions.answer').handler(agent, { question_id: q.id, text: 'Kim does.' })) as TeamQuestionView
    expect(answered.answers.map((a) => a.text)).toEqual(['Kim does.'])
    expect(tool('questions.answer').activity!({ question_id: q.id, text: 'Kim does.' }, answered)).toBe('Alex answered: Who owns the Acme renewal?')
    await expect(tool('questions.close').handler(agent, { question_id: q.id })).rejects.toThrow(/Only the person who asked/)

    as('ony')
    const closed = (await tool('questions.close').handler(agent, { question_id: q.id })) as TeamQuestionView
    expect(closed.status).toBe('closed')
    expect(((await tool('questions.list').handler(agent, { status: 'closed', tag: 'acme' })) as { questions: unknown[] }).questions).toHaveLength(1)
  })

  it('no audience = the whole company; an agent working for no one does nothing', async () => {
    const { tool, agent } = setup()
    const q = (await tool('questions.ask').handler(agent, { text: 'Wo liegt das Logo?' })) as TeamQuestionView
    expect(q.audience).toEqual({ kind: 'company', groups: [], people: [] })
    expect(tool('questions.ask').activity!({ text: 'Wo liegt das Logo?' }, q)).toBe('Ony asked the company: Wo liegt das Logo?')
    await expect(tool('questions.ask').handler(agent, { text: 'Q?', audience: 'chosen' })).rejects.toThrow(/at least one group or person/)
    await expect(tool('questions.ask').handler(agent, { text: 'Q?', audience: 'company', group_ids: ['g-sales'] })).rejects.toThrow(/takes no group_ids/)
    const none = setup(null)
    await expect(none.tool('questions.ask').handler(none.agent, { text: 'Q?' })).rejects.toThrow(/works for no one/)
    await expect(none.tool('questions.list').handler(none.agent, {})).rejects.toThrow(/works for no one/)
  })

  it('rejects malformed input at the schema', () => {
    const { tool } = setup()
    const ask = tool('questions.ask').inputSchema
    expect(ask.safeParse({ text: '' }).success).toBe(false)
    expect(ask.safeParse({ text: 'x'.repeat(501) }).success).toBe(false)
    expect(ask.safeParse({ text: 'Q?', audience: 'everyone' }).success).toBe(false)
    expect(tool('questions.list').inputSchema.safeParse({ status: 'pending' }).success).toBe(false)
    expect(tool('questions.answer').inputSchema.safeParse({ question_id: 'x', text: '' }).success).toBe(false)
  })
})
