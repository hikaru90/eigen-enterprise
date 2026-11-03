import { describe, expect, it, vi } from 'vitest'
import { memoryAccessStore } from '$lib/server/access/memory-store'
import { createAccess } from '$lib/server/access/service'
import { accessPortFrom } from './access-port'
import { MemoryDirectory, MemoryMessagesStore } from './memory-store'
import { createChannel, listConversations, listMessages, postMessage, type MessagesDeps } from './service'

/** C1 through the REAL access module (createAccess over its in-memory store). */
function realAccessFixture() {
  const store = new MemoryMessagesStore()
  const accessStore = memoryAccessStore({
    users: { olga: 'owner', bea: 'member', carl: 'member', dana: 'member' },
    groups: { leads: ['dana'] },
  })
  const audit = vi.fn(async () => {})
  const access = createAccess({ store: accessStore, audit })
  access.registerResourceResolver('channel', async (id) => (await store.getConversation(id))?.kind === 'channel')
  const directory = new MemoryDirectory(
    ['olga', 'bea', 'carl', 'dana'].map((id) => ({ id, name: id, email: `${id}@co.test` })),
    new Map([
      ['olga', 'owner'],
      ['bea', 'member'],
      ['carl', 'member'],
      ['dana', 'member'],
    ]),
  )
  const port = accessPortFrom({
    access,
    listGroups: async () => [{ id: 'leads', name: 'Leads', memberIds: ['dana'] }],
  })
  const deps: MessagesDeps = { store, access: port, directory }
  return { deps, access, accessStore, audit }
}

describe('messages × real access module', () => {
  it('a member creates a private channel (initial grants), people + groups get in, others do not', async () => {
    const { deps, access, audit } = realAccessFixture()
    const ch = await createChannel(deps, 'bea', { name: 'leadership', private: true, userIds: ['carl'], groupIds: ['leads'] })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'access.grants_set', principalId: 'bea' }))
    expect(await access.canAccess('bea', 'channel', ch.id, 'manage')).toBe(true)
    expect(await access.canAccess('carl', 'channel', ch.id, 'edit')).toBe(true)
    expect(await access.canAccess('dana', 'channel', ch.id, 'edit')).toBe(true) // via group
    expect(await listConversations(deps, 'olga')).toHaveLength(1) // owner always manages
    await postMessage(deps, 'dana', ch.id, 'hi from a group member')
    expect(await listConversations(deps, 'bea')).toHaveLength(1)
    await expect(listMessages(deps, 'nobody', ch.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a member without a grant does not see a private channel', async () => {
    const { deps } = realAccessFixture()
    const ch = await createChannel(deps, 'bea', { name: 'secret', private: true })
    expect(await listConversations(deps, 'carl')).toEqual([])
    await expect(listMessages(deps, 'carl', ch.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a public channel is the company grant: everyone reads and posts', async () => {
    const { deps, access } = realAccessFixture()
    const ch = await createChannel(deps, 'bea', { name: 'general', private: false })
    expect(await access.canAccess('carl', 'channel', ch.id, 'edit')).toBe(true)
    expect(await access.canAccess('carl', 'channel', ch.id, 'manage')).toBe(false)
    await postMessage(deps, 'carl', ch.id, 'hello')
    expect((await listMessages(deps, 'dana', ch.id)).messages).toHaveLength(1)
  })

  it('initGrants refuses once grants exist', async () => {
    const { deps } = realAccessFixture()
    const ch = await createChannel(deps, 'bea', { name: 'x', private: true })
    await expect(deps.access.initGrants('carl', 'channel', ch.id, [{ subject: { kind: 'company' }, level: 'edit' }])).rejects.toThrow(
      /already has grants/,
    )
  })

  it('first grants: a member creator goes through access.initializeGrants, an owner/admin through setGrants', async () => {
    const { deps, access } = realAccessFixture()
    const init = vi.spyOn(access, 'initializeGrants')
    const set = vi.spyOn(access, 'setGrants')
    const mine = await createChannel(deps, 'bea', { name: 'beas', private: true })
    expect(init).toHaveBeenCalledTimes(1)
    expect(init).toHaveBeenCalledWith('bea', 'channel', mine.id, [{ subject: { kind: 'user', userId: 'bea' }, level: 'manage' }])
    expect(set).not.toHaveBeenCalled()
    const owners = await createChannel(deps, 'olga', { name: 'olgas', private: false })
    expect(init).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledWith('olga', 'channel', owners.id, [
      { subject: { kind: 'user', userId: 'olga' }, level: 'manage' },
      { subject: { kind: 'company' }, level: 'edit' },
    ])
  })
})
