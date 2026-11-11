import { describe, expect, it } from 'vitest'
import { fixture } from './test-fixtures'
import { createCallsTools } from './tools'

function setup() {
  const f = fixture()
  const tools = createCallsTools({ service: async () => f.service })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const human = (id: string) => ({ principal: { id, kind: 'human' as const, roles: ['admin'] }, requestId: 'r' })
  const agent = { principal: { id: 'agent:1', kind: 'agent' as const, roles: ['agent'] }, requestId: 'r' }
  return { ...f, tools, tool, human, agent }
}

describe('calls.* tools', () => {
  it('declares calls.list, calls.start, calls.end with their audit classes; start is approval-risk internal', () => {
    const { tools, tool } = setup()
    expect(tools.map((t) => t.name)).toEqual(['calls.list', 'calls.start', 'calls.end'])
    expect(tool('calls.list').auditClass).toBe('read')
    expect(tool('calls.start')).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(tool('calls.end').auditClass).toBe('mutate')
    expect(tool('calls.start').activity!({ context_kind: 'meeting' }, undefined)).toBe('Tried to start a meeting')
  })

  it('no tool hands out a media token', async () => {
    const { tools, agent, tool } = setup()
    const { call } = (await tool('calls.start').handler(agent, { context_kind: 'meeting', user_ids: ['ann'] })) as { call: { id: string } }
    for (const t of tools) expect(t.name).not.toMatch(/token|join/)
    const listed = JSON.stringify(await tool('calls.list').handler(agent, {}))
    expect(listed).toContain(call.id)
    expect(listed).not.toMatch(/eyJ/) // no JWT anywhere in what the agent sees
  })

  it('the agent starts and ends a meeting; it cannot ring a DM', async () => {
    const { tool, agent } = setup()
    await expect(tool('calls.start').handler(agent, { context_kind: 'dm', context_id: 'dm-ann-ben' })).rejects.toMatchObject({ code: 'forbidden' })
    const out = (await tool('calls.start').handler(agent, { context_kind: 'meeting', user_ids: ['ann', 'ben'], title: 'Weekly' })) as {
      call: { id: string; title: string }
    }
    expect(out.call.title).toBe('Weekly')
    expect(tool('calls.start').activity!({ context_kind: 'meeting' }, out)).toBe('Started a call: Weekly (2 people)')
    expect(await tool('calls.end').handler(agent, { call_id: out.call.id })).toMatchObject({ call: { state: 'missed' } })
  })

  it('a person acts as themselves (membership checked)', async () => {
    const { tool, human } = setup()
    const out = (await tool('calls.start').handler(human('ann'), { context_kind: 'dm', context_id: 'dm-ann-ben' })) as { call: { id: string } }
    expect(await tool('calls.list').handler(human('ben'), {})).toMatchObject({ calls: [{ id: out.call.id }] })
    expect(await tool('calls.list').handler(human('cat'), {})).toEqual({ calls: [] })
    await expect(tool('calls.end').handler(human('cat'), { call_id: out.call.id })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects unknown input keys', async () => {
    const { tool, agent } = setup()
    await expect(tool('calls.end').handler(agent, { call_id: 'x', force: true })).rejects.toThrow()
  })
})
