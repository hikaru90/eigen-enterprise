import { describe, expect, it } from 'vitest'
import { MessagesHub } from './hub'
import { createChannel, deleteMessage, editMessage, listMessages, listThread, openDm, postMessage, uploadAttachments } from './service'
import { depthFixture, fixture } from './test-fixtures'

/** Quoted replies (Contribute 2a58bcc8): "Reply" to one message, WhatsApp-style. */
describe('quoted replies', () => {
  it('a reply stores the original and every reader gets the quote: author, first line, its id', async () => {
    const { deps } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: original } = await postMessage(deps, 'bea', ch.id, 'Lunch at noon?\nor later')
    const { message: reply } = await postMessage(deps, 'carl', ch.id, 'Noon works', { replyToId: original.id })
    expect(reply.parentId).toBeNull()
    expect(reply.replyTo).toEqual({
      id: original.id,
      parentId: null,
      deleted: false,
      authorId: 'bea',
      authorName: 'Bea Member',
      snippet: 'Lunch at noon?',
      attachment: null,
      call: false,
    })
    const page = await listMessages(deps, 'owner', ch.id)
    expect(page.messages.map((m) => m.replyTo?.id ?? null)).toEqual([null, original.id])
    expect(page.messages[0].replyTo).toBeNull()
  })

  it('refuses an original from another conversation (as not found — its existence never leaks)', async () => {
    const { deps } = fixture()
    const a = await createChannel(deps, 'owner', { name: 'a', private: false })
    const b = await createChannel(deps, 'owner', { name: 'b', private: false })
    const { message: inA } = await postMessage(deps, 'bea', a.id, 'over here')
    await expect(postMessage(deps, 'bea', b.id, 'cross', { replyToId: inA.id })).rejects.toMatchObject({ code: 'not_found' })
    const dm = await openDm(deps, 'bea', ['carl'])
    await expect(postMessage(deps, 'bea', dm.id, 'cross', { replyToId: inA.id })).rejects.toMatchObject({ code: 'not_found' })
    await expect(postMessage(deps, 'bea', b.id, 'junk', { replyToId: 'not-an-id' })).rejects.toMatchObject({ code: 'not_found' })
    expect((await listMessages(deps, 'owner', b.id)).messages).toEqual([])
  })

  it('refuses replying to a deleted message', async () => {
    const { deps } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: original } = await postMessage(deps, 'bea', ch.id, 'oops')
    await deleteMessage(deps, 'bea', original.id)
    await expect(postMessage(deps, 'carl', ch.id, 'too late', { replyToId: original.id })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('once the original is deleted the quote says so and carries none of its content', async () => {
    const { deps } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: original } = await postMessage(deps, 'bea', ch.id, 'secret plan')
    await postMessage(deps, 'carl', ch.id, 'nice', { replyToId: original.id })
    await deleteMessage(deps, 'bea', original.id)
    const [, reply] = (await listMessages(deps, 'owner', ch.id)).messages
    expect(reply.replyTo).toEqual({
      id: original.id,
      parentId: null,
      deleted: true,
      authorId: null,
      authorName: null,
      snippet: '',
      attachment: null,
      call: false,
    })
  })

  it('an edit of the original shows in the quote', async () => {
    const { deps } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: original } = await postMessage(deps, 'bea', ch.id, 'tpyo')
    await postMessage(deps, 'carl', ch.id, 'what?', { replyToId: original.id })
    await editMessage(deps, 'bea', original.id, 'typo')
    expect((await listMessages(deps, 'owner', ch.id)).messages[1].replyTo?.snippet).toBe('typo')
  })

  it('a quote of a voice message (an audio file) says "Voice message"; of a photo, "Photo"', async () => {
    const { deps } = depthFixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { uploaded } = await uploadAttachments(deps, 'bea', ch.id, [{ name: 'voice.webm', bytes: new Uint8Array(10), mime: 'audio/webm' }])
    const { message: voice } = await postMessage(deps, 'bea', ch.id, '', { attachmentIds: uploaded.map((u) => u.fileId) })
    const { message: reply } = await postMessage(deps, 'carl', ch.id, 'got it', { replyToId: voice.id })
    expect(reply.replyTo).toMatchObject({ snippet: '', attachment: { kind: 'voice', label: 'Voice message', count: 1 } })
  })

  it('a quoted thread reply carries its thread (the click opens it); replies inside a thread may quote too', async () => {
    const { deps } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: top } = await postMessage(deps, 'bea', ch.id, 'top')
    const { message: inThread } = await postMessage(deps, 'carl', ch.id, 'in thread', { parentId: top.id })
    const { message: quoting } = await postMessage(deps, 'bea', ch.id, 'quoting it', { parentId: top.id, replyToId: inThread.id })
    expect(quoting.replyTo).toMatchObject({ id: inThread.id, parentId: top.id })
    const { message: fromLog } = await postMessage(deps, 'owner', ch.id, 'from the log', { replyToId: inThread.id })
    expect(fromLog.replyTo).toMatchObject({ id: inThread.id, parentId: top.id, snippet: 'in thread' })
    expect((await listThread(deps, 'owner', top.id)).replies[1].replyTo?.id).toBe(inThread.id)
  })

  it('the live frame carries the quote (pushed like any other message)', async () => {
    const { deps, store } = fixture()
    const ch = await createChannel(deps, 'owner', { name: 'general', private: false })
    const { message: original } = await postMessage(deps, 'bea', ch.id, 'ping')
    const { message: reply } = await postMessage(deps, 'carl', ch.id, 'pong', { replyToId: original.id })
    const hub = new MessagesHub(deps)
    const event = store.events.find((e) => e.kind === 'message.created' && e.messageId === reply.id)!
    const frame = await hub.frameFor(event, 'owner')
    expect(frame).toMatchObject({ event: 'message', data: { message: { id: reply.id, replyTo: { id: original.id, snippet: 'ping' } } } })
  })
})
