import { describe, expect, it } from 'vitest'
import { createAssistantTools, type ConversationsPort } from './tools'

function setup(member = true) {
  const renames: unknown[] = []
  const port: ConversationsPort = {
    access: async () => (member ? { ok: true } : { ok: false, error: 'Forbidden: company members only' }),
    rename: async (userId, runId, title) => {
      renames.push([userId, runId, title])
      return runId === 7 ? { ok: true, run: { id: 7, title } } : { ok: false, status: 403, error: 'Only its owner can name a conversation.' }
    },
  }
  const [tool] = createAssistantTools({ port: async () => port })
  return { tool: tool!, renames }
}

const me = { principal: { id: 'u1', kind: 'human' as const, roles: ['member'] }, requestId: 'r' }

describe('assistant.conversation_rename', () => {
  it('renames my own conversation through the runs source, title trimmed', async () => {
    const { tool, renames } = setup()
    expect(tool).toMatchObject({ name: 'assistant.conversation_rename', auditClass: 'mutate', approvalRisk: 'internal' })
    expect(await tool.handler(me, { run_id: 7, title: '  Q4 plan ' })).toEqual({ run: { id: 7, title: 'Q4 plan' } })
    expect(renames).toEqual([['u1', 7, 'Q4 plan']])
  })

  it('refuses someone else’s run, a non-member, an empty title and a call as no person', async () => {
    await expect(setup().tool.handler(me, { run_id: 8, title: 'x' })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(setup(false).tool.handler(me, { run_id: 7, title: 'x' })).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(setup().tool.handler(me, { run_id: 7, title: '   ' })).rejects.toThrow(/needs a name/)
    const agent = { principal: { id: 'a', kind: 'agent' as const, roles: ['agent'] }, requestId: 'r' }
    await expect(setup().tool.handler(agent, { run_id: 7, title: 'x' })).rejects.toMatchObject({ code: 'no_person' })
  })
})
