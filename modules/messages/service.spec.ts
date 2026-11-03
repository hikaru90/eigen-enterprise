import { describe, expect, it } from 'vitest'
import {
  createChannel,
  deleteMessage,
  editMessage,
  listConversations,
  listMessages,
  markRead,
  MessagesError,
  openDm,
  postMessage,
} from './service'
import { fixture } from './test-fixtures'

describe('channels and access', () => {
  it('a public channel is visible to every member, who may post in it', async () => {
    const { deps } = fixture()
    const general = await createChannel(deps, 'owner', { name: '#general', private: false })
    expect(general.title).toBe('general')
    expect((await listConversations(deps, 'bea')).map((c) => c.title)).toEqual(['general'])
    await postMessage(deps, 'bea', general.id, 'hello')
    expect((await listMessages(deps, 'owner', general.id)).messages.map((m) => m.body)).toEqual(['hello'])
  })

  it('a private channel is invisible to non-members (not even its existence leaks)', async () => {
    const { deps } = fixture()
    const lead = await createChannel(deps, 'owner', { name: 'leadership', private: true, userIds: ['carl'] })
    expect(await listConversations(deps, 'bea')).toEqual([])
    await expect(listMessages(deps, 'bea', lead.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(postMessage(deps, 'bea', lead.id, 'let me in')).rejects.toMatchObject({ code: 'not_found' })
    await expect(markRead(deps, 'bea', lead.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await listConversations(deps, 'carl')).map((c) => c.title)).toEqual(['leadership'])
  })

  it('a private channel created by a member is visible to an admin (owner/admin always manage)', async () => {
    const { deps } = fixture()
    await createChannel(deps, 'bea', { name: 'side', private: true })
    expect((await listConversations(deps, 'owner')).map((c) => c.title)).toEqual(['side'])
    expect(await listConversations(deps, 'carl')).toEqual([])
  })

  it('maps visibility onto the access contract: company grant for public, people grants for private', async () => {
    const { deps, access } = fixture()
    const pub = await createChannel(deps, 'bea', { name: 'pub', private: false })
    const priv = await createChannel(deps, 'bea', { name: 'priv', private: true, userIds: ['carl'] })
    expect((await access.listGrants('bea', 'channel', pub.id)).map((g) => [g.subject.kind, g.level])).toEqual([
      ['user', 'manage'],
      ['company', 'edit'],
    ])
    expect((await access.listGrants('bea', 'channel', priv.id)).map((g) => [g.subject, g.level])).toEqual([
      [{ kind: 'user', userId: 'bea' }, 'manage'],
      [{ kind: 'user', userId: 'carl' }, 'edit'],
    ])
  })

  it('a view-only grant reads but cannot post', async () => {
    const { deps, access } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'news', private: false })
    await access.setGrants('owner', 'channel', ch.id, [{ subject: { kind: 'company' }, level: 'view' }])
    await expect(listMessages(deps, 'bea', ch.id)).resolves.toMatchObject({ messages: [] })
    await expect(postMessage(deps, 'bea', ch.id, 'hi')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('rejects duplicate names, empty names, and invites on a public channel', async () => {
    const { deps } = fixture()
    await createChannel(deps, 'owner', { name: 'general', private: false })
    await expect(createChannel(deps, 'bea', { name: 'General', private: false })).rejects.toMatchObject({ code: 'conflict' })
    await expect(createChannel(deps, 'bea', { name: '  # ', private: false })).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      createChannel(deps, 'bea', { name: 'x', private: false, userIds: ['carl'] }),
    ).rejects.toBeInstanceOf(MessagesError)
  })
})

describe('direct messages', () => {
  it('are visible to their participants only — admins included in "not"', async () => {
    const { deps } = fixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    expect(dm.title).toBe('Carl Member')
    await postMessage(deps, 'bea', dm.id, 'psst')
    expect((await listConversations(deps, 'carl')).map((c) => c.id)).toEqual([dm.id])
    expect(await listConversations(deps, 'owner')).toEqual([])
    await expect(listMessages(deps, 'owner', dm.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('are deduped by member set, in any order', async () => {
    const { deps } = fixture()
    const a = await openDm(deps, 'bea', ['carl', 'owner'])
    const b = await openDm(deps, 'owner', ['carl', 'bea', 'bea'])
    expect(b.id).toBe(a.id)
    expect((await openDm(deps, 'carl', ['bea'])).id).not.toBe(a.id)
  })

  it('need another known person', async () => {
    const { deps } = fixture()
    await expect(openDm(deps, 'bea', ['bea'])).rejects.toMatchObject({ code: 'invalid' })
    await expect(openDm(deps, 'bea', ['ghost'])).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('unread counts', () => {
  it('count others’ messages since the last read; own messages never count; reading clears', async () => {
    const { deps } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    await postMessage(deps, 'owner', ch.id, 'one')
    await postMessage(deps, 'owner', ch.id, 'two')
    const unread = async (u: string) => (await listConversations(deps, u)).find((c) => c.id === ch.id)!.unread
    expect(await unread('bea')).toBe(2)
    expect(await unread('owner')).toBe(0)
    await markRead(deps, 'bea', ch.id)
    expect(await unread('bea')).toBe(0)
    await postMessage(deps, 'carl', ch.id, 'three')
    expect(await unread('bea')).toBe(1)
    expect(await unread('owner')).toBe(1)
    // posting marks the author's own read point
    await postMessage(deps, 'bea', ch.id, 'reply')
    expect(await unread('bea')).toBe(0)
  })

  it('deleted messages stop counting', async () => {
    const { deps } = fixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    const { message } = await postMessage(deps, 'bea', dm.id, 'oops')
    const unread = async () => (await listConversations(deps, 'carl'))[0].unread
    expect(await unread()).toBe(1)
    await deleteMessage(deps, 'bea', message.id)
    expect(await unread()).toBe(0)
  })
})

describe('history', () => {
  it('pages backwards, oldest first within a page', async () => {
    const { deps } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    for (let i = 1; i <= 5; i++) await postMessage(deps, 'owner', ch.id, `m${i}`)
    const last = await listMessages(deps, 'bea', ch.id, { limit: 2 })
    expect(last).toMatchObject({ hasMore: true })
    expect(last.messages.map((m) => m.body)).toEqual(['m4', 'm5'])
    const earlier = await listMessages(deps, 'bea', ch.id, { limit: 2, beforeId: last.messages[0].id })
    expect(earlier.messages.map((m) => m.body)).toEqual(['m2', 'm3'])
    const first = await listMessages(deps, 'bea', ch.id, { limit: 2, beforeId: earlier.messages[0].id })
    expect(first).toMatchObject({ hasMore: false })
    expect(first.messages.map((m) => m.body)).toEqual(['m1'])
  })

  it('keeps Markdown source; rejects empty and trims trailing whitespace', async () => {
    const { deps } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'owner', ch.id, '**bold**\nline two  \n\n')
    expect(message.body).toBe('**bold**\nline two')
    await expect(postMessage(deps, 'owner', ch.id, ' \n ')).rejects.toMatchObject({ code: 'invalid' })
  })

  it('only the author edits or deletes a message', async () => {
    const { deps } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'bea', ch.id, 'draft')
    await expect(editMessage(deps, 'carl', message.id, 'hijack')).rejects.toMatchObject({ code: 'forbidden' })
    await editMessage(deps, 'bea', message.id, 'final')
    const [m] = (await listMessages(deps, 'carl', ch.id)).messages
    expect(m).toMatchObject({ body: 'final', deleted: false })
    expect(m.editedAt).not.toBeNull()
  })
})
