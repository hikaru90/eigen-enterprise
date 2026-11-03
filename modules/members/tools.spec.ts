import { describe, expect, it, vi } from 'vitest'
import { memoryStore } from '$lib/server/members/memory-store'
import { memoryGroupStore } from '$lib/server/members/groups'
import { createMembersTools } from './tools'

const at = new Date('2026-10-21T10:00:00Z')

function setup() {
  const store = memoryStore([
    { id: 'o', email: 'owner@k.co', name: 'O', role: 'owner', createdAt: at },
    { id: 'm', email: 'm@k.co', name: 'M', role: 'member', createdAt: at },
  ])
  const mail = { send: vi.fn(async () => ({})), isConfigured: vi.fn(async () => true) }
  const groups = memoryGroupStore(['o', 'm'])
  const audit = vi.fn(async () => {})
  const tools = createMembersTools({
    deps: async () => ({ store, mail, origin: 'https://os.k.co', companyName: 'K', now: () => at }),
    groupDeps: async () => ({ groups, audit }),
    actor: async (ctx) => (ctx.principal.kind === 'human' ? { id: ctx.principal.id, role: 'member' } : { id: ctx.principal.id, role: 'admin' }),
  })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const agent = { principal: { id: 'agent:1', kind: 'agent' as const, roles: ['agent'] }, requestId: 'r' }
  return { store, mail, tool, agent, groups, audit }
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

describe('members group tools', () => {
  it('declares read/mutate classes and approval risks', () => {
    const { tool } = setup()
    expect(tool('members.group_list').auditClass).toBe('read')
    expect(tool('members.group_create')).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(tool('members.group_update')).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(tool('members.group_delete')).toMatchObject({ auditClass: 'mutate', approvalRisk: 'destructive' })
    expect(tool('members.group_create').activity!({ name: 'Sales' }, undefined)).toBe('Created the group Sales')
  })

  it('the agent creates, updates, lists and deletes groups (audited)', async () => {
    const { tool, agent, audit } = setup()
    const g = (await tool('members.group_create').handler(agent, { name: 'Sales', member_ids: ['m'] })) as { id: string }
    await tool('members.group_update').handler(agent, { group_id: g.id, description: 'EU sales' })
    expect(await tool('members.group_list').handler(agent, {})).toEqual([{ id: g.id, name: 'Sales', description: 'EU sales', memberIds: ['m'] }])
    await tool('members.group_delete').handler(agent, { group_id: g.id })
    expect(await tool('members.group_list').handler(agent, {})).toEqual([])
    expect(audit.mock.calls.map((c) => (c as unknown as [{ type: string }])[0].type)).toEqual([
      'members.group_created',
      'members.group_updated',
      'members.group_deleted',
    ])
  })

  it('a member reads groups but cannot change them', async () => {
    const { tool } = setup()
    const human = { principal: { id: 'm', kind: 'human' as const, roles: ['admin'] }, requestId: 'r' }
    expect(await tool('members.group_list').handler(human, {})).toEqual([])
    await expect(tool('members.group_create').handler(human, { name: 'X' })).rejects.toThrow(/owner or an admin/)
  })

  it('without company mail the invite tool reports it and still never returns the link', async () => {
    const { tool, agent, mail } = setup()
    mail.isConfigured.mockResolvedValue(false)
    const out = await tool('members.invite').handler(agent, { email: 'n@k.co', role: 'member' })
    expect(mail.send).not.toHaveBeenCalled()
    expect(JSON.stringify(out)).not.toMatch(/token|https?:/)
    expect(out).toMatchObject({ emailed: false, note: expect.stringMatching(/Settings → Members/) })
  })
})
