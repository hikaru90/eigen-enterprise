import type { Grant } from './types'
import { describe, expect, it, vi } from 'vitest'
import { memoryAccessStore } from './memory-store'
import { createAccess } from './service'

const g = (resourceType: Grant['resourceType'], resourceId: string, subject: Grant['subject'], level: Grant['level']): Grant => ({
  resourceType,
  resourceId,
  subject,
  level,
})

function setup(grants: Grant[] = []) {
  const store = memoryAccessStore({
    users: { o: 'owner', a: 'admin', m: 'member', n: 'member', s: 'member' },
    groups: { sales: ['s'], dev: ['n'] },
    grants,
  })
  const audit = vi.fn(async () => {})
  const known = new Set(['f-root', 'f-sub', 'f-leaf', 'doc', 'general', 'secret'])
  const exists = async (id: string) => known.has(id)
  const access = createAccess({ store, audit, resolvers: { folder: exists, file: exists, channel: exists } })
  return { store, audit, access }
}

describe('canAccess', () => {
  it('owner and admin always manage; members get nothing without a grant', async () => {
    const { access } = setup()
    expect(await access.canAccess('o', 'channel', 'secret', 'manage')).toBe(true)
    expect(await access.canAccess('a', 'file', 'doc', 'manage')).toBe(true)
    expect(await access.canAccess('m', 'channel', 'secret', 'view')).toBe(false)
  })

  it('a direct user grant gives that level and everything below it, nothing above', async () => {
    const { access } = setup([g('file', 'doc', { kind: 'user', userId: 'm' }, 'edit')])
    expect(await access.canAccess('m', 'file', 'doc', 'view')).toBe(true)
    expect(await access.canAccess('m', 'file', 'doc', 'edit')).toBe(true)
    expect(await access.canAccess('m', 'file', 'doc', 'manage')).toBe(false)
    expect(await access.canAccess('n', 'file', 'doc', 'view')).toBe(false)
  })

  it('group grants apply to the group members only', async () => {
    const { access } = setup([g('channel', 'secret', { kind: 'group', groupId: 'sales' }, 'view')])
    expect(await access.canAccess('s', 'channel', 'secret', 'view')).toBe(true)
    expect(await access.canAccess('n', 'channel', 'secret', 'view')).toBe(false)
  })

  it('a company grant applies to every member', async () => {
    const { access } = setup([g('channel', 'general', { kind: 'company' }, 'edit')])
    for (const u of ['m', 'n', 's']) expect(await access.canAccess(u, 'channel', 'general', 'edit')).toBe(true)
    expect(await access.canAccess('m', 'channel', 'general', 'manage')).toBe(false)
  })

  it('the strongest applicable grant wins (company view + group manage → manage)', async () => {
    const { access } = setup([
      g('folder', 'f-root', { kind: 'company' }, 'view'),
      g('folder', 'f-root', { kind: 'group', groupId: 'sales' }, 'manage'),
    ])
    expect(await access.canAccess('s', 'folder', 'f-root', 'manage')).toBe(true)
    expect(await access.canAccess('m', 'folder', 'f-root', 'manage')).toBe(false)
  })

  it('folder grants inherit to children through the chain argument (nearest parent first)', async () => {
    const { access } = setup([
      g('folder', 'f-root', { kind: 'group', groupId: 'sales' }, 'view'),
      g('folder', 'f-sub', { kind: 'user', userId: 'm' }, 'edit'),
    ])
    const chain = { ancestors: ['f-sub', 'f-root'] }
    expect(await access.canAccess('s', 'file', 'doc', 'view', chain)).toBe(true)
    expect(await access.canAccess('s', 'file', 'doc', 'edit', chain)).toBe(false)
    expect(await access.canAccess('m', 'file', 'doc', 'edit', chain)).toBe(true)
    expect(await access.canAccess('m', 'folder', 'f-leaf', 'edit', { ancestors: ['f-sub', 'f-root'] })).toBe(true)
    // Without the chain the file's own grants are all that count.
    expect(await access.canAccess('s', 'file', 'doc', 'view')).toBe(false)
    // Grants on a sibling or a child never flow upward.
    expect(await access.canAccess('m', 'folder', 'f-root', 'view')).toBe(false)
  })

  it('a grant on a channel id never leaks to a folder or file with the same id', async () => {
    const { access } = setup([g('channel', 'doc', { kind: 'company' }, 'manage')])
    expect(await access.canAccess('m', 'file', 'doc', 'view')).toBe(false)
  })

  it('fails closed: unknown user, unknown resource, empty ids, bad level', async () => {
    const { access } = setup([g('file', 'doc', { kind: 'company' }, 'view'), g('file', 'gone', { kind: 'company' }, 'view')])
    expect(await access.canAccess('ghost', 'file', 'doc', 'view')).toBe(false)
    expect(await access.canAccess('o', 'file', 'gone', 'view')).toBe(false)
    expect(await access.canAccess('m', 'file', 'gone', 'view')).toBe(false)
    expect(await access.canAccess('', 'file', 'doc', 'view')).toBe(false)
    expect(await access.canAccess('m', 'file', '', 'view')).toBe(false)
    expect(await access.canAccess('m', 'file', 'doc', 'own' as never)).toBe(false)
    expect(await access.canAccess('m', 'drive' as never, 'doc', 'view')).toBe(false)
  })

  it('a removed member loses access even though a group still lists nothing for them', async () => {
    const { access, store } = setup([g('channel', 'general', { kind: 'company' }, 'view')])
    delete store.users.m
    expect(await access.canAccess('m', 'channel', 'general', 'view')).toBe(false)
  })

  it('throws for an unregistered resource type and a chain on a channel', async () => {
    const store = memoryAccessStore({ users: { m: 'member' } })
    const access = createAccess({ store, audit: async () => {} })
    await expect(access.canAccess('m', 'file', 'x', 'view')).rejects.toThrow(/no resolver registered for resource type "file"/)
    access.registerResourceResolver('file', async () => true)
    expect(await access.canAccess('m', 'file', 'x', 'view')).toBe(false)
    const { access: a2 } = setup()
    await expect(a2.canAccess('m', 'channel', 'general', 'view', { ancestors: ['f-root'] })).rejects.toThrow(/no folder chain/)
  })
})

describe('setGrants / listGrants', () => {
  it('manage-level only; replaces the set; audits before/after as a kernel event', async () => {
    const { access, audit } = setup([g('folder', 'f-root', { kind: 'user', userId: 'm' }, 'manage')])
    await expect(
      access.setGrants('n', 'folder', 'f-root', [{ subject: { kind: 'company' }, level: 'view' }]),
    ).rejects.toThrow(/Only people who manage this/)
    expect(audit).not.toHaveBeenCalled()

    const out = await access.setGrants('m', 'folder', 'f-root', [
      { subject: { kind: 'user', userId: 'm' }, level: 'manage' },
      { subject: { kind: 'group', groupId: 'sales' }, level: 'edit' },
      { subject: { kind: 'company' }, level: 'view' },
    ])
    expect(out).toHaveLength(3)
    expect(await access.canAccess('s', 'folder', 'f-root', 'edit')).toBe(true)
    expect(audit).toHaveBeenCalledWith({
      type: 'access.grants_set',
      principalId: 'm',
      payload: {
        resourceType: 'folder',
        resourceId: 'f-root',
        before: [{ subject: 'user:m', level: 'manage' }],
        after: [
          { subject: 'user:m', level: 'manage' },
          { subject: 'group:sales', level: 'edit' },
          { subject: 'company', level: 'view' },
        ],
      },
    })
    expect((await access.listGrants('n', 'folder', 'f-root')).map((x) => x.level)).toEqual(['manage', 'edit', 'view'])
  })

  it('a manager of a parent folder may set grants on a child through the chain', async () => {
    const { access } = setup([g('folder', 'f-root', { kind: 'group', groupId: 'dev' }, 'manage')])
    await access.setGrants('n', 'file', 'doc', [{ subject: { kind: 'user', userId: 'm' }, level: 'view' }], { ancestors: ['f-root'] })
    expect(await access.canAccess('m', 'file', 'doc', 'view')).toBe(true)
  })

  it('rejects unknown subjects, duplicates and bad levels without writing', async () => {
    const { access, store, audit } = setup()
    await expect(access.setGrants('o', 'file', 'doc', [{ subject: { kind: 'user', userId: 'ghost' }, level: 'view' }])).rejects.toThrow(/no such member/)
    await expect(access.setGrants('o', 'file', 'doc', [{ subject: { kind: 'group', groupId: 'nope' }, level: 'view' }])).rejects.toThrow(/no such group/)
    await expect(
      access.setGrants('o', 'file', 'doc', [
        { subject: { kind: 'company' }, level: 'view' },
        { subject: { kind: 'company' }, level: 'edit' },
      ]),
    ).rejects.toThrow(/listed twice/)
    await expect(access.setGrants('o', 'file', 'doc', [{ subject: { kind: 'company' }, level: 'all' as never }])).rejects.toThrow(/unknown access level/)
    expect(store.grants).toEqual([])
    expect(audit).not.toHaveBeenCalled()
  })

  it('listGrants needs view; nobody lists grants of an unknown resource', async () => {
    const { access } = setup()
    await expect(access.listGrants('m', 'file', 'doc')).rejects.toThrow(/don't have access/)
    await expect(access.listGrants('o', 'file', 'missing')).rejects.toThrow(/don't have access/)
    expect(await access.listGrants('o', 'file', 'doc')).toEqual([])
  })
})

describe('initializeGrants (a creator sets the first grants of a new resource)', () => {
  it('a member creator sets the first set, audited as them; afterwards only managers change it', async () => {
    const { access, audit } = setup()
    expect(await access.canAccess('m', 'folder', 'f-root', 'manage')).toBe(false)
    await access.initializeGrants('m', 'folder', 'f-root', [{ subject: { kind: 'user', userId: 'm' }, level: 'manage' }])
    expect(await access.canAccess('m', 'folder', 'f-root', 'manage')).toBe(true)
    expect(audit).toHaveBeenCalledWith({
      type: 'access.grants_set',
      principalId: 'm',
      payload: { resourceType: 'folder', resourceId: 'f-root', before: [], after: [{ subject: 'user:m', level: 'manage' }] },
    })
    await expect(access.initializeGrants('n', 'folder', 'f-root', [{ subject: { kind: 'company' }, level: 'view' }])).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('fails closed: unknown creator, unknown resource, invalid subjects', async () => {
    const { access, audit } = setup()
    await expect(access.initializeGrants('ghost', 'file', 'doc', [])).rejects.toMatchObject({ code: 'forbidden' })
    await expect(access.initializeGrants('m', 'file', 'nope', [])).rejects.toMatchObject({ code: 'forbidden' })
    await expect(access.initializeGrants('m', 'file', 'doc', [{ subject: { kind: 'user', userId: 'ghost' }, level: 'view' }])).rejects.toMatchObject({
      code: 'invalid_grant',
    })
    expect(audit).not.toHaveBeenCalled()
  })
})
