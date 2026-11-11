import { describe, expect, it } from 'vitest'
import { createChannel, editMessage, listConversations, listMessages, MessagesError, openDm, postCallLine, postMessage } from './service'
import { fixture } from './test-fixtures'

/**
 * Call lines (plan/video-calls.md §2): when a DM/channel call ends, Calls
 * posts one structured line into the conversation through the composition
 * root ("Call, 4 min" / "Missed call") — a message with call data, never a
 * free-text body parsed later.
 */

const CALL = '11111111-1111-4111-8111-111111111111'

describe('postCallLine', () => {
  it('adds a top-level message with the call data and an empty body, as a message.created event', async () => {
    const { deps, store } = fixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    const line = await postCallLine(deps, {
      conversationId: dm.id,
      authorId: 'bea',
      call: { callId: CALL, outcome: 'ended', durationSeconds: 245 },
    })
    expect(line).toMatchObject({ authorId: 'bea', body: '', parentId: null, call: { callId: CALL, outcome: 'ended', durationSeconds: 245 } })
    const page = await listMessages(deps, 'carl', dm.id)
    expect(page.messages.map((m) => m.call)).toEqual([{ callId: CALL, outcome: 'ended', durationSeconds: 245 }])
    expect(store.events.at(-1)).toMatchObject({ kind: 'message.created', conversationId: dm.id, messageId: line!.id })
  })

  it('posts once per call: a second post for the same call changes nothing and returns null', async () => {
    const { deps, store } = fixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    const call = { callId: CALL, outcome: 'missed' as const, durationSeconds: null }
    expect(await postCallLine(deps, { conversationId: dm.id, authorId: 'bea', call })).not.toBeNull()
    const events = store.events.length
    expect(await postCallLine(deps, { conversationId: dm.id, authorId: 'bea', call })).toBeNull()
    expect((await listMessages(deps, 'bea', dm.id)).messages).toHaveLength(1)
    expect(store.events.length).toBe(events)
  })

  it('a missed call counts as unread for the person called, not for the caller', async () => {
    const { deps } = fixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    await postCallLine(deps, { conversationId: dm.id, authorId: 'bea', call: { callId: CALL, outcome: 'missed', durationSeconds: null } })
    expect((await listConversations(deps, 'carl')).find((c) => c.id === dm.id)?.unread).toBe(1)
    expect((await listConversations(deps, 'bea')).find((c) => c.id === dm.id)?.unread).toBe(0)
  })

  it('refuses a malformed call (fail loud): unknown conversation, bad outcome, duration on a missed call', async () => {
    const { deps } = fixture()
    const general = await createChannel(deps, 'owner', { name: 'general', private: false })
    await expect(
      postCallLine(deps, { conversationId: '00000000-0000-4000-8000-999999999999', authorId: 'bea', call: { callId: CALL, outcome: 'ended', durationSeconds: 1 } }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      // @ts-expect-error — an outcome outside the contract
      postCallLine(deps, { conversationId: general.id, authorId: 'bea', call: { callId: CALL, outcome: 'hung', durationSeconds: null } }),
    ).rejects.toBeInstanceOf(MessagesError)
    await expect(
      postCallLine(deps, { conversationId: general.id, authorId: 'bea', call: { callId: CALL, outcome: 'missed', durationSeconds: 30 } }),
    ).rejects.toMatchObject({ code: 'invalid' })
    await expect(
      postCallLine(deps, { conversationId: general.id, authorId: 'bea', call: { callId: CALL, outcome: 'ended', durationSeconds: -1 } }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a call line cannot be edited; ordinary messages carry call: null', async () => {
    const { deps } = fixture()
    const dm = await openDm(deps, 'bea', ['carl'])
    const { message } = await postMessage(deps, 'bea', dm.id, 'hi')
    expect(message.call).toBeNull()
    const line = await postCallLine(deps, { conversationId: dm.id, authorId: 'bea', call: { callId: CALL, outcome: 'ended', durationSeconds: 60 } })
    await expect(editMessage(deps, 'bea', line!.id, 'changed')).rejects.toMatchObject({ code: 'invalid' })
  })
})
