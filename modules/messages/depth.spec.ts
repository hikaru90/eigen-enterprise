import { describe, expect, it } from 'vitest'
import { MessagesHub, type StreamFrame } from './hub'
import { notifyNewMessage, type PushPort } from './notify'
import {
  createChannel,
  deleteMessage,
  editMessage,
  listConversations,
  listMessages,
  listThread,
  openDm,
  postMessage,
  toggleReaction,
  uploadAttachments,
} from './service'
import { depthFixture } from './test-fixtures'

/** C2: threads, reactions, edit/delete + moderation, attachments → Drive. */

const png = (n = 10) => ({ name: 'shot.png', mime: 'image/png', bytes: new Uint8Array(n) })
const md = { name: 'notes.md', mime: 'text/markdown', bytes: new TextEncoder().encode('# hi') }

function live() {
  const f = depthFixture()
  const hub = new MessagesHub(f.deps)
  const pending: Promise<void>[] = []
  f.store.onEvent = (id) => pending.push(hub.dispatch(id))
  const settle = async () => {
    while (pending.length) await pending.shift()
  }
  const inbox = (userId: string) => {
    const frames: StreamFrame[] = []
    hub.subscribe(userId, (fr) => frames.push(fr))
    return frames
  }
  return { ...f, hub, settle, inbox }
}

describe('threads', () => {
  it('a reply lives in the thread, not the main log; the parent carries the reply count and last reply', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: parent } = await postMessage(deps, 'owner', ch.id, 'Plan for Q1?')
    const r1 = await postMessage(deps, 'bea', ch.id, 'I have ideas', { parentId: parent.id })
    await postMessage(deps, 'carl', ch.id, 'me too', { parentId: parent.id })
    expect(r1.parent).toMatchObject({ id: parent.id, replyCount: 1 })

    const log = await listMessages(deps, 'bea', ch.id)
    expect(log.messages.map((m) => m.body)).toEqual(['Plan for Q1?'])
    expect(log.messages[0]).toMatchObject({ replyCount: 2 })
    expect(log.messages[0].lastReplyAt).not.toBeNull()

    const thread = await listThread(deps, 'carl', parent.id)
    expect(thread.parent.id).toBe(parent.id)
    expect(thread.replies.map((m) => [m.authorId, m.body, m.parentId])).toEqual([
      ['bea', 'I have ideas', parent.id],
      ['carl', 'me too', parent.id],
    ])
  })

  it('refuses replies to replies, to other conversations and to deleted messages', async () => {
    const { deps } = depthFixture()
    const a = await createChannel(deps, 'owner', { name: 'a', private: false })
    const b = await createChannel(deps, 'owner', { name: 'b', private: false })
    const { message: p } = await postMessage(deps, 'owner', a.id, 'parent')
    const { message: r } = await postMessage(deps, 'bea', a.id, 'reply', { parentId: p.id })
    await expect(postMessage(deps, 'bea', a.id, 'nested', { parentId: r.id })).rejects.toMatchObject({ code: 'invalid' })
    await expect(postMessage(deps, 'bea', b.id, 'elsewhere', { parentId: p.id })).rejects.toMatchObject({ code: 'not_found' })
    await deleteMessage(deps, 'owner', p.id)
    await expect(postMessage(deps, 'bea', a.id, 'late', { parentId: p.id })).rejects.toMatchObject({ code: 'invalid' })
    await expect(listThread(deps, 'bea', r.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a private channel’s thread stays invisible to non-members', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'lead', private: true, userIds: ['carl'] })
    const { message: p } = await postMessage(deps, 'owner', ch.id, 'secret')
    await expect(listThread(deps, 'bea', p.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(postMessage(deps, 'bea', ch.id, 'x', { parentId: p.id })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('unread counts replies only for the thread’s participants', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: p } = await postMessage(deps, 'bea', ch.id, 'parent by bea')
    // Everyone has read up to now.
    for (const u of ['owner', 'bea', 'carl']) await deps.store.setLastRead(ch.id, u, deps.now!())
    await postMessage(deps, 'owner', ch.id, 'reply by owner', { parentId: p.id })
    const unread = async (u: string) => (await listConversations(deps, u)).find((c) => c.id === ch.id)!.unread
    expect(await unread('bea')).toBe(1) // started the thread
    expect(await unread('carl')).toBe(0) // not in it
    await postMessage(deps, 'carl', ch.id, 'carl joins', { parentId: p.id })
    await postMessage(deps, 'bea', ch.id, 'bea answers', { parentId: p.id })
    expect(await unread('carl')).toBe(2) // joining makes the whole thread his business: owner's + bea's unread replies
    expect(await unread('owner')).toBe(2) // carl + bea
  })

  it('a reply streams to everyone who may see it, with the parent’s fresh reply count', async () => {
    const { deps, settle, inbox } = live()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: p } = await postMessage(deps, 'owner', ch.id, 'parent')
    await settle()
    const bea = inbox('bea')
    await postMessage(deps, 'carl', ch.id, 'reply', { parentId: p.id })
    await settle()
    expect(bea.find((f) => f.event === 'message')).toMatchObject({
      data: { action: 'created', message: { body: 'reply', parentId: p.id }, parent: { id: p.id, replyCount: 1 } },
    })
  })

  it('pushes a reply to the thread’s participants (not the author, not people outside it)', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: p } = await postMessage(deps, 'bea', ch.id, 'parent')
    await postMessage(deps, 'owner', ch.id, 'first reply', { parentId: p.id })
    const sent: Array<{ userId: string; title: string; url: string }> = []
    const push: PushPort = {
      hasSubscription: async () => true,
      send: async (userId, payload) => {
        sent.push({ userId, title: payload.title, url: payload.url })
      },
    }
    const { message, conversation } = await postMessage(deps, 'carl', ch.id, 'second reply', { parentId: p.id })
    expect((await notifyNewMessage(deps, push, conversation, message)).sort()).toEqual(['bea', 'owner'])
    expect(sent[0].title).toBe('Carl Member replied in a thread in #general')
    expect(sent[0].url).toContain(`&t=${p.id}`)
  })
})

describe('reactions', () => {
  it('toggles the actor’s own reaction, counts per emoji, who reacted', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'owner', ch.id, 'ship it')
    await toggleReaction(deps, 'bea', message.id, '👍')
    const after = await toggleReaction(deps, 'carl', message.id, '👍')
    expect(after.reactions).toEqual([{ emoji: '👍', userIds: ['bea', 'carl'], names: ['Bea Member', 'Carl Member'] }])
    const off = await toggleReaction(deps, 'bea', message.id, '👍')
    expect(off.reactions).toEqual([{ emoji: '👍', userIds: ['carl'], names: ['Carl Member'] }])
    expect((await listMessages(deps, 'owner', ch.id)).messages[0].reactions).toHaveLength(1)
  })

  it('only the picker’s emoji, only on visible live messages, only for people who may post', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'lead', private: true })
    const { message } = await postMessage(deps, 'owner', ch.id, 'x')
    await expect(toggleReaction(deps, 'owner', message.id, 'lol')).rejects.toMatchObject({ code: 'invalid' })
    await expect(toggleReaction(deps, 'bea', message.id, '👍')).rejects.toMatchObject({ code: 'not_found' })
    await deleteMessage(deps, 'owner', message.id)
    await expect(toggleReaction(deps, 'owner', message.id, '👍')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a reaction streams live as action "reacted"', async () => {
    const { deps, settle, inbox } = live()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'owner', ch.id, 'hi')
    await settle()
    const owner = inbox('owner')
    await toggleReaction(deps, 'bea', message.id, '🎉')
    await settle()
    expect(owner.at(-1)).toMatchObject({
      event: 'message',
      data: { action: 'reacted', message: { id: message.id, reactions: [{ emoji: '🎉', userIds: ['bea'] }] } },
    })
  })
})

describe('edit and delete', () => {
  it('edit marks edited; delete shows as deleted with no body, reactions or files', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'bea', ch.id, 'tpyo')
    await editMessage(deps, 'bea', message.id, 'typo')
    await toggleReaction(deps, 'owner', message.id, '👍')
    let [m] = (await listMessages(deps, 'owner', ch.id)).messages
    expect(m.body).toBe('typo')
    expect(m.editedAt).not.toBeNull()
    await deleteMessage(deps, 'bea', message.id)
    ;[m] = (await listMessages(deps, 'owner', ch.id)).messages
    expect(m).toMatchObject({ deleted: true, body: '', reactions: [], attachments: [] })
  })

  it('members cannot edit or delete others’ messages', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'bea', ch.id, 'mine')
    await expect(editMessage(deps, 'carl', message.id, 'hacked')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(deleteMessage(deps, 'carl', message.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(editMessage(deps, 'owner', message.id, 'not even admins edit')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('owner/admin may delete any channel message (moderation), audited; never in a DM', async () => {
    const { deps, audits, directory } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'bea', ch.id, 'spam')
    await deleteMessage(deps, 'owner', message.id)
    expect(audits).toEqual([
      {
        type: 'messages.message_moderated',
        principalId: 'owner',
        payload: { conversationId: ch.id, channel: 'general', messageId: message.id, authorId: 'bea' },
      },
    ])
    // Deleting one's own message is not moderation.
    const own = await postMessage(deps, 'owner', ch.id, 'oops')
    await deleteMessage(deps, 'owner', own.message.id)
    expect(audits).toHaveLength(1)

    directory.roles.set('carl', 'admin')
    const dm = await openDm(deps, 'bea', ['owner'])
    const { message: dmMsg } = await postMessage(deps, 'bea', dm.id, 'private')
    await expect(deleteMessage(deps, 'owner', dmMsg.id)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a moderation delete without an audit sink fails loud (no silent unaudited deletes)', async () => {
    const { deps } = depthFixture()
    deps.audit = undefined
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message } = await postMessage(deps, 'bea', ch.id, 'x')
    await expect(deleteMessage(deps, 'owner', message.id)).rejects.toThrow(/audit/)
    expect((await listMessages(deps, 'owner', ch.id)).messages[0].deleted).toBe(false)
  })
})

describe('attachments → Drive', () => {
  it('the first attachment creates "Messages / #general" with the channel’s access mirrored', async () => {
    const { deps, drive } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { uploaded, errors } = await uploadAttachments(deps, 'bea', ch.id, [png(), md])
    expect(errors).toEqual([])
    expect(uploaded.map((u) => [u.name, u.image])).toEqual([
      ['shot.png', true],
      ['notes.md', false],
    ])
    const root = drive.folders.find((f) => f.name === 'Messages')!
    const folder = drive.folders.find((f) => f.name === '#general')!
    expect(root.parentId).toBeNull()
    expect(folder.parentId).toBe(root.id)
    expect(folder.grants).toEqual([
      { subject: { kind: 'user', userId: 'owner' }, level: 'manage' },
      { subject: { kind: 'company' }, level: 'edit' },
    ])
    // Second upload reuses the folder.
    await uploadAttachments(deps, 'carl', ch.id, [md])
    expect(drive.folders.filter((f) => f.name === '#general')).toHaveLength(1)
  })

  it('a message carries its files; everyone in the channel sees them, outsiders get nothing', async () => {
    const { deps, drive } = depthFixture()
    const ch = await createChannel(deps, 'bea', { name: 'lead', private: true, userIds: ['owner'] })
    const { uploaded } = await uploadAttachments(deps, 'bea', ch.id, [png(), md])
    const { message } = await postMessage(deps, 'bea', ch.id, '', { attachmentIds: uploaded.map((u) => u.fileId) })
    expect(message.attachments.map((a) => a.name)).toEqual(['shot.png', 'notes.md'])
    expect((await listMessages(deps, 'owner', ch.id)).messages[0].attachments).toHaveLength(2)
    // carl is not in #lead: the Drive refuses the file too.
    expect(await drive.fileInfo('carl', uploaded[0].fileId)).toBeNull()
    expect(await drive.fileInfo('bea', uploaded[0].fileId)).not.toBeNull()
  })

  it('a DM folder is shared with exactly the DM’s members', async () => {
    const { deps, drive } = depthFixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    const { uploaded } = await uploadAttachments(deps, 'bea', dm.id, [md])
    const folder = drive.folders.find((f) => f.name.startsWith('DM'))!
    expect(folder.name).toBe('DM · Bea Member, Carl Member')
    expect(folder.grants?.map((g) => g.subject).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      { kind: 'user', userId: 'bea' },
      { kind: 'user', userId: 'carl' },
    ])
    expect(await drive.fileInfo('carl', uploaded[0].fileId)).not.toBeNull()
  })

  it('the Drive size limit refuses per file, in its own words', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { uploaded, errors } = await uploadAttachments(deps, 'bea', ch.id, [png(5000), md])
    expect(uploaded.map((u) => u.name)).toEqual(['notes.md'])
    expect(errors).toEqual(['“shot.png” is too large; files can be at most 1000 B.'])
  })

  it('refuses attaching files from elsewhere or someone else’s upload, and uploads to private channels by outsiders', async () => {
    const { deps } = depthFixture()
    const a = await createChannel(deps, 'owner', { name: 'a', private: false })
    const b = await createChannel(deps, 'owner', { name: 'b', private: false })
    const lead = await createChannel(deps, 'owner', { name: 'lead', private: true })
    const { uploaded } = await uploadAttachments(deps, 'bea', a.id, [md])
    await expect(postMessage(deps, 'bea', b.id, 'x', { attachmentIds: [uploaded[0].fileId] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(postMessage(deps, 'carl', a.id, 'x', { attachmentIds: [uploaded[0].fileId] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(postMessage(deps, 'bea', a.id, 'x', { attachmentIds: ['nope'] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(uploadAttachments(deps, 'bea', lead.id, [md])).rejects.toMatchObject({ code: 'not_found' })
  })

  it('an empty body is fine with files, refused without', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    await expect(postMessage(deps, 'bea', ch.id, '  ')).rejects.toMatchObject({ code: 'invalid' })
    const { uploaded } = await uploadAttachments(deps, 'bea', ch.id, [md])
    const { message } = await postMessage(deps, 'bea', ch.id, '  ', { attachmentIds: [uploaded[0].fileId] })
    expect(message.body).toBe('')
  })
})
