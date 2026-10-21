import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from '$lib/server/members/memory-store'
import { createMembersTools } from './tools'

const at = new Date('2026-10-21T10:00:00Z')

function setup() {
  const store = memoryStore([
    { id: 'o', email: 'owner@k.co', name: 'O', role: 'owner', createdAt: at },
    { id: 'm', email: 'm@k.co', name: 'M', role: 'member', createdAt: at },
  ])
  const mail = { send: vi.fn(async () => ({})) }
  const tools = createMembersTools({
    deps: async () => ({ store, mail, origin: 'https://os.k.co', companyName: 'K', now: () => at }),
    actor: async (ctx) => (ctx.principal.kind === 'human' ? { id: ctx.principal.id, role: 'member' } : { id: ctx.principal.id, role: 'admin' }),
  })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const agent = { principal: { id: 'agent:1', kind: 'agent' as const, roles: ['agent'] }, requestId: 'r' }
  return { store, mail, tool, agent }
}

describe('members.* tools', () => {
  it('declares read/mutate classes, approval risk and activity sentences', () => {
    const { tool } = setup()
    expect(tool('members.list').auditClass).toBe('read')
    expect(tool('members.invite')).toMatchObject({ auditClass: 'external', approvalRisk: 'external' })
    expect(tool('members.set_role')).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(tool('members.invite').activity!({ email: 'a@b.co', role: 'admin' }, undefined)).toBe('Invited a@b.co as an admin')
    expect(tool('members.set_role').activity!({ user_id: 'm', role: 'admin' }, { email: 'm@k.co' })).toBe("Changed m@k.co's role to admin")
  })

  it('the agent lists, invites and changes roles, but never the owner', async () => {
    const { tool, agent, mail, store } = setup()
    const list = (await tool('members.list').handler(agent, {})) as { members: Array<{ role: string }> }
    expect(list.members.map((m) => m.role)).toEqual(['owner', 'member'])
    const out = await tool('members.invite').handler(agent, { email: 'n@k.co', role: 'member' })
    expect(out).toMatchObject({ email: 'n@k.co', role: 'member' })
    expect(JSON.stringify(out)).not.toMatch(/token/)
    expect(mail.send).toHaveBeenCalledOnce()
    await tool('members.set_role').handler(agent, { user_id: 'm', role: 'admin' })
    expect((await store.getMember('m'))!.role).toBe('admin')
    await expect(tool('members.set_role').handler(agent, { user_id: 'o', role: 'member' })).rejects.toThrow(/owner's role/)
  })

  it('a person acts with their own role: a member cannot invite', async () => {
    const { tool } = setup()
    const human = { principal: { id: 'm', kind: 'human' as const, roles: ['admin'] }, requestId: 'r' }
    await expect(tool('members.invite').handler(human, { email: 'n@k.co', role: 'member' })).rejects.toThrow(/owner or an admin/)
  })
})
