import { describe, expect, it, vi } from 'vitest'
import { createGroup, deleteGroup, listGroups, memoryGroupStore, updateGroup } from './groups'

const owner = { id: 'o', role: 'owner' as const }
const admin = { id: 'a', role: 'admin' as const }
const member = { id: 'm', role: 'member' as const }

function setup() {
  const groups = memoryGroupStore(['o', 'a', 'm', 'b'])
  const audit = vi.fn(async () => {})
  return { groups, audit, deps: { groups, audit } }
}

describe('groups', () => {
  it('owner/admin create a group with members; everyone in the company can list it', async () => {
    const { deps, audit } = setup()
    const g = await createGroup(owner, { name: ' Sales ', description: 'Selling things', memberIds: ['b', 'b'] }, deps)
    expect(g).toMatchObject({ name: 'Sales', description: 'Selling things', memberIds: ['b'] })
    expect(audit).toHaveBeenCalledWith({ type: 'members.group_created', principalId: 'o', payload: { groupId: g.id, name: 'Sales', memberIds: ['b'] } })
    expect(await listGroups(member, deps)).toEqual([{ id: g.id, name: 'Sales', description: 'Selling things', memberIds: ['b'] }])
    await createGroup(admin, { name: 'Dev' }, deps)
    expect((await listGroups(member, deps)).map((x) => x.name)).toEqual(['Dev', 'Sales'])
  })

  it('members cannot create, change or delete groups; strangers cannot list', async () => {
    const { deps } = setup()
    const g = await createGroup(owner, { name: 'Sales' }, deps)
    await expect(createGroup(member, { name: 'X' }, deps)).rejects.toThrow(/owner or an admin/)
    await expect(updateGroup(member, { groupId: g.id, name: 'Y' }, deps)).rejects.toThrow(/owner or an admin/)
    await expect(deleteGroup(member, { groupId: g.id }, deps)).rejects.toThrow(/owner or an admin/)
    await expect(listGroups({ id: 'x', role: null }, deps)).rejects.toThrow(/Only company members/)
  })

  it('names are required, unique (case-insensitive) and bounded', async () => {
    const { deps } = setup()
    await createGroup(owner, { name: 'Sales' }, deps)
    await expect(createGroup(owner, { name: '  ' }, deps)).rejects.toThrow(/Give the group a name/)
    await expect(createGroup(owner, { name: 'sales' }, deps)).rejects.toThrow(/already exists/)
    await expect(createGroup(owner, { name: 'x'.repeat(81) }, deps)).rejects.toThrow(/under 80/)
  })

  it('unknown members are refused', async () => {
    const { deps, groups } = setup()
    await expect(createGroup(owner, { name: 'Sales', memberIds: ['ghost'] }, deps)).rejects.toThrow(/No such member: ghost/)
    expect(groups.groups).toEqual([])
  })

  it('updates rename, describe and replace members, auditing who was added and removed', async () => {
    const { deps, audit } = setup()
    const g = await createGroup(owner, { name: 'Sales', memberIds: ['m'] }, deps)
    audit.mockClear()
    const out = await updateGroup(admin, { groupId: g.id, name: 'Sales EU', memberIds: ['b'] }, deps)
    expect(out).toMatchObject({ name: 'Sales EU', memberIds: ['b'] })
    expect(audit).toHaveBeenCalledWith({
      type: 'members.group_updated',
      principalId: 'a',
      payload: { groupId: g.id, name: 'Sales EU', renamedFrom: 'Sales', added: ['b'], removed: ['m'] },
    })
    await expect(updateGroup(admin, { groupId: 'nope', name: 'Z' }, deps)).rejects.toThrow(/No such group/)
  })

  it('deletes a group (audited)', async () => {
    const { deps, audit } = setup()
    const g = await createGroup(owner, { name: 'Sales' }, deps)
    expect(await deleteGroup(owner, { groupId: g.id }, deps)).toEqual({ groupId: g.id, name: 'Sales' })
    expect(await listGroups(member, deps)).toEqual([])
    expect(audit).toHaveBeenLastCalledWith({ type: 'members.group_deleted', principalId: 'o', payload: { groupId: g.id, name: 'Sales' } })
  })
})
