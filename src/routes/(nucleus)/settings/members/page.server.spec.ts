import { describe, expect, it, vi } from 'vitest'

const { roleOf, store, mail, groups } = vi.hoisted(() => ({
  roleOf: { value: 'owner' as 'owner' | 'admin' | 'member' },
  store: { current: null as unknown },
  mail: { send: vi.fn(async () => ({})), isConfigured: vi.fn(async () => true) },
  groups: { current: null as unknown },
}))

vi.mock('$lib/server/members', async () => {
  const service = await import('$lib/server/members/service')
  const { memoryStore } = await import('$lib/server/members/memory-store')
  const groupsMod = await import('$lib/server/members/groups')
  groups.current = groupsMod.memoryGroupStore(['o', 'm'])
  const at = new Date('2026-10-21T10:00:00Z')
  store.current = memoryStore([
    { id: 'o', email: 'owner@k.co', name: 'O', role: 'owner', createdAt: at },
    { id: 'm', email: 'm@k.co', name: 'M', role: 'member', createdAt: at },
  ])
  return {
    ...service,
    ...groupsMod,
    memberDeps: async () => ({ store: store.current, mail, origin: 'https://os.k.co', companyName: 'Kindred' }),
    humanActor: async (id: string) => ({ id, role: roleOf.value }),
    groupDeps: async () => ({ groups: groups.current, audit: async () => {} }),
  }
})

const { actions, load } = await import('./+page.server')

const post = (fields: Record<string, string>, userId = 'o') =>
  ({ locals: { user: { id: userId } }, request: new Request('http://x/settings/members', { method: 'POST', body: new URLSearchParams(fields) }) }) as never

describe('Settings → Members page', () => {
  it('loads members for the owner', async () => {
    roleOf.value = 'owner'
    const data = (await load({ locals: { user: { id: 'o' } } } as never)) as { members: Array<{ email: string; role: string }>; companyName: string }
    expect(data.members).toEqual([
      { id: 'o', email: 'owner@k.co', name: 'O', role: 'owner' },
      { id: 'm', email: 'm@k.co', name: 'M', role: 'member' },
    ])
    expect(data.companyName).toBe('Kindred')
  })

  it('is forbidden to members and sends signed-out visitors to sign in', async () => {
    roleOf.value = 'member'
    await expect(load({ locals: { user: { id: 'm' } } } as never)).rejects.toMatchObject({ status: 403 })
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302, location: '/login' })
  })

  it('invites, changes roles, and refuses to remove the owner', async () => {
    roleOf.value = 'admin'
    expect(await actions.invite(post({ email: 'n@k.co', role: 'admin' }))).toEqual({
      action: 'invite',
      ok: true,
      inviteUrl: expect.stringMatching(/^https:\/\/os\.k\.co\/invite\?token=.{20,}$/),
      inviteEmail: 'n@k.co',
      emailed: true,
    })
    expect(mail.send).toHaveBeenCalledOnce()
    expect(await actions.setRole(post({ userId: 'm', role: 'admin' }))).toEqual({ action: 'setRole', ok: true })
    const refused = (await actions.remove(post({ userId: 'o' }))) as { status: number; data: { error: string } }
    expect(refused.status).toBe(400)
    expect(refused.data.error).toBe("The owner can't be removed.")
    const badRole = (await actions.invite(post({ email: 'x@k.co', role: 'owner' }))) as { status: number }
    expect(badRole.status).toBe(400)
  })
})

describe('Settings → Members: groups', () => {
  const postMany = (fields: Array<[string, string]>) =>
    ({ locals: { user: { id: 'o' } }, request: new Request('http://x/settings/members', { method: 'POST', body: new URLSearchParams(fields) }) }) as never

  it('creates a group with members, renames it, lists it on load, deletes it', async () => {
    roleOf.value = 'owner'
    expect(await actions.createGroup(postMany([['name', 'Sales'], ['description', 'Selling'], ['memberIds', 'm']]))).toEqual({
      action: 'createGroup',
      ok: true,
    })
    let data = (await load({ locals: { user: { id: 'o' } } } as never)) as { groups: Array<{ id: string; name: string; memberIds: string[] }> }
    expect(data.groups).toMatchObject([{ name: 'Sales', description: 'Selling', memberIds: ['m'] }])
    const id = data.groups[0]!.id
    await actions.updateGroup(postMany([['groupId', id], ['name', 'Sales EU'], ['description', ''], ['memberIds', 'o'], ['memberIds', 'm']]))
    data = (await load({ locals: { user: { id: 'o' } } } as never)) as typeof data
    expect(data.groups).toMatchObject([{ name: 'Sales EU', memberIds: ['o', 'm'] }])
    expect(await actions.deleteGroup(postMany([['groupId', id]]))).toEqual({ action: 'deleteGroup', ok: true })
  })

  it('a member cannot create groups', async () => {
    roleOf.value = 'member'
    const out = (await actions.createGroup(postMany([['name', 'X']]))) as { status: number }
    expect(out.status).toBe(403)
  })
})
