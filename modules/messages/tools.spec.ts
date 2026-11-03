import { describe, expect, it } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { createChannel, openDm, postMessage } from './service'
import { fixture } from './test-fixtures'
import { createMessagesTools } from './tools'

const ctx = (id: string, kind: 'human' | 'agent'): ToolContext => ({
  principal: { id, kind, roles: [kind === 'human' ? 'admin' : 'agent'] },
  requestId: 'r1',
})

async function seeded() {
  const f = fixture()
  const general = await createChannel(f.deps, 'owner', { name: 'general', private: false })
  const lead = await createChannel(f.deps, 'owner', { name: 'leadership', private: true, userIds: ['carl'] })
  const dm = await openDm(f.deps, 'bea', ['carl'])
  await postMessage(f.deps, 'bea', general.id, 'hello **team**')
  await postMessage(f.deps, 'owner', lead.id, 'secret')
  await postMessage(f.deps, 'carl', dm.id, 'private dm')
  const tools = Object.fromEntries(createMessagesTools({ deps: async () => f.deps }).map((t) => [t.name, t]))
  return { ...f, general, lead, dm, tools }
}

describe('messages.* tools (read only)', () => {
  it('there is no posting tool', () => {
    expect(createMessagesTools().map((t) => t.name)).toEqual(['messages.list_channels', 'messages.read'])
  })

  it('the agent sees company-visible channels only — never private channels or DMs', async () => {
    const { tools, general, lead, dm } = await seeded()
    const listed = (await tools['messages.list_channels'].handler(ctx('agent-1', 'agent'), {})) as {
      conversations: Array<{ id: string }>
    }
    expect(listed.conversations.map((c) => c.id)).toEqual([general.id])
    const read = (await tools['messages.read'].handler(ctx('agent-1', 'agent'), { channel: '#general' })) as {
      messages: Array<{ body: string }>
    }
    expect(read.messages.map((m) => m.body)).toEqual(['hello **team**'])
    await expect(tools['messages.read'].handler(ctx('agent-1', 'agent'), { conversation_id: lead.id })).rejects.toThrow(/not found/)
    await expect(tools['messages.read'].handler(ctx('agent-1', 'agent'), { conversation_id: dm.id })).rejects.toThrow(/not found/)
  })

  it('a person reads with their own access', async () => {
    const { tools, dm, lead } = await seeded()
    const read = (await tools['messages.read'].handler(ctx('bea', 'human'), { conversation_id: dm.id })) as {
      messages: Array<{ body: string }>
    }
    expect(read.messages.map((m) => m.body)).toEqual(['private dm'])
    await expect(tools['messages.read'].handler(ctx('bea', 'human'), { conversation_id: lead.id })).rejects.toMatchObject({ code: 'not_found' })
  })
})
