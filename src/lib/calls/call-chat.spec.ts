import type { CallChatMessageDto, CallChatPage, ChatClient } from './client'
import { describe, expect, it, vi } from 'vitest'
import { CallChat } from './call-chat.svelte'
import { CallRequestError } from './client'

const line = (seq: number, authorId: string, body: string): CallChatMessageDto => ({
  seq,
  authorId,
  authorKind: authorId.startsWith('guest:') ? 'guest' : 'member',
  authorName: authorId.toUpperCase(),
  body,
  createdAt: new Date(Date.UTC(2026, 10, 23, 10, 0, seq)).toISOString(),
})

/** A chat server faked in memory: the lines, paged like the real one (page size 2 here). */
function fakeServer(initial: CallChatMessageDto[] = []) {
  const lines = [...initial]
  const reads: number[] = []
  const client: ChatClient = {
    async readChat(_id, since): Promise<CallChatPage> {
      reads.push(since)
      const after = lines.filter((m) => m.seq > since)
      return { messages: after.slice(0, 2), hasMore: after.length > 2 }
    },
    async postChat(_id, body) {
      const m = line((lines.at(-1)?.seq ?? 0) + 1, 'me', body.trim())
      lines.push(m)
      return m
    },
  }
  return { lines, reads, client }
}

const chatWith = (client: ChatClient) => new CallChat({ callId: 'c1', me: 'me', client })

describe('CallChat (the chat of the call I am in)', () => {
  it('opening it the first time reads the whole chat (paged on with the cursor), in order', async () => {
    const server = fakeServer([
      line(1, 'ann', 'eins'),
      line(2, 'ben', 'zwei'),
      line(3, 'ann', 'drei'),
    ])
    const chat = chatWith(server.client)
    await chat.show()
    expect(chat.messages.map((m) => m.body)).toEqual(['eins', 'zwei', 'drei'])
    expect(server.reads).toEqual([0, 2])
    expect(chat.open).toBe(true)
    expect(chat.unread).toBe(0)
  })

  it('lines from others count as unread while it is closed; opening clears them; my own never count', async () => {
    const chat = chatWith(fakeServer().client)
    chat.receive('c1', line(1, 'ann', 'hallo'))
    chat.receive('c1', line(2, 'me', 'hi'))
    chat.receive('c1', line(3, 'guest:k', 'guten tag'))
    expect(chat.unread).toBe(2)
    await chat.show()
    expect(chat.unread).toBe(0)
    chat.receive('c1', line(4, 'ann', 'noch was')) // read while open
    expect(chat.unread).toBe(0)
    chat.hide()
    chat.receive('c1', line(5, 'ben', 'und?'))
    expect(chat.unread).toBe(1)
  })

  it('ignores lines of other calls and duplicates (a frame and a read can bring the same line)', () => {
    const chat = chatWith(fakeServer().client)
    chat.receive('c2', line(1, 'ann', 'anderer call'))
    chat.receive('c1', line(5, 'ann', 'b'))
    chat.receive('c1', line(3, 'ann', 'a'))
    chat.receive('c1', line(5, 'ann', 'b'))
    expect(chat.messages.map((m) => m.seq)).toEqual([3, 5])
    expect(chat.cursor).toBe(5)
  })

  it('catchUp reads on from the cursor (after a reconnect, on a guest’s refresh)', async () => {
    const server = fakeServer([line(1, 'ann', 'eins')])
    const chat = chatWith(server.client)
    await chat.catchUp()
    server.lines.push(line(2, 'ben', 'zwei'))
    await chat.catchUp()
    expect(server.reads).toEqual([0, 1])
    expect(chat.messages.map((m) => m.body)).toEqual(['eins', 'zwei'])
  })

  it('send: the stored line shows at once; empty text sends nothing; a refusal keeps the text and says why', async () => {
    const server = fakeServer()
    const chat = chatWith(server.client)
    expect(await chat.send('   ')).toBe(false)
    expect(server.lines).toEqual([])
    expect(await chat.send(' Hallo ')).toBe(true)
    expect(chat.messages.map((m) => [m.authorId, m.body])).toEqual([['me', 'Hallo']])
    server.client.postChat = async () => {
      throw new CallRequestError({
        kind: 'failed',
        message: 'join the call before writing in its chat',
        agent: null,
      })
    }
    expect(await chat.send('weg?')).toBe(false)
    expect(chat.problem?.error).toBe('Not sent: join the call before writing in its chat')
    expect(chat.sending).toBe(false)
    chat.dismissProblem()
    expect(chat.problem).toBeNull()
  })

  it('a failed read is shown, not thrown; subscribers hear every change', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const chat = chatWith({
      readChat: async () => {
        throw new CallRequestError({
          kind: 'failed',
          message: 'could not reach the server (offline)',
          agent: null,
        })
      },
      postChat: async () => {
        throw new Error('unused')
      },
    })
    const heard = vi.fn()
    chat.subscribe(heard)
    await chat.show()
    expect(chat.problem?.error).toBe(
      'The chat could not be loaded: could not reach the server (offline)',
    )
    chat.receive('c1', line(1, 'ann', 'x'))
    expect(heard).toHaveBeenCalled()
    errors.mockRestore()
  })
})
