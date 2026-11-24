import { describe, expect, it } from 'vitest'
import { TypingBoard, typingStreamFor, type TypingFrame } from './typing'
import { addCoworker, fixture } from './test-fixtures'
import { createChannel, openDm } from './service'

describe('TypingBoard (who is writing where, in this process)', () => {
  it('start shows a typist in its conversation; stop clears it, and every change is told', () => {
    const board = new TypingBoard()
    const told: TypingFrame[] = []
    board.subscribe((f) => told.push(f))
    const stop = board.start({ conversationId: 'c1', threadRootId: null, userId: 'ada' })
    expect(board.list()).toEqual([{ conversationId: 'c1', typists: [{ userId: 'ada', threadRootId: null }] }])
    expect(board.busy('ada')).toBe(true)
    stop()
    stop() // twice is harmless
    expect(board.list()).toEqual([])
    expect(board.busy('ada')).toBe(false)
    expect(told).toEqual([
      { conversationId: 'c1', typists: [{ userId: 'ada', threadRootId: null }] },
      { conversationId: 'c1', typists: [] },
    ])
  })

  it('two turns of the same typist in one place: shown until both ended', () => {
    const board = new TypingBoard()
    const a = board.start({ conversationId: 'c1', threadRootId: 't', userId: 'ada' })
    const b = board.start({ conversationId: 'c1', threadRootId: 't', userId: 'ada' })
    expect(board.list()[0].typists).toEqual([{ userId: 'ada', threadRootId: 't' }])
    a()
    expect(board.list()[0].typists).toEqual([{ userId: 'ada', threadRootId: 't' }])
    b()
    expect(board.list()).toEqual([])
  })
})

describe('typingStreamFor (what one viewer is told)', () => {
  it('a snapshot and the changes, only of conversations the viewer may see', async () => {
    const f = fixture()
    addCoworker(f, { id: 'ada', slug: 'ada', name: 'Ada' })
    const open = await createChannel(f.deps, 'owner', { name: 'open' })
    const theirs = await openDm(f.deps, 'owner', ['ada'])
    const board = new TypingBoard()
    board.start({ conversationId: open.id, threadRootId: null, userId: 'ada' })
    const frames: TypingFrame[] = []
    const stop = await typingStreamFor(f.deps, board, 'bea').start((fr) => frames.push(fr))
    expect(frames).toEqual([{ conversationId: open.id, typists: [{ userId: 'ada', threadRootId: null }] }])
    board.start({ conversationId: theirs.id, threadRootId: null, userId: 'ada' })()
    await new Promise((r) => setTimeout(r, 0))
    expect(frames).toHaveLength(1)
    const stopOpen = board.start({ conversationId: open.id, threadRootId: 'root', userId: 'ada' })
    await new Promise((r) => setTimeout(r, 0))
    expect(frames[1]).toEqual({
      conversationId: open.id,
      typists: [
        { userId: 'ada', threadRootId: null },
        { userId: 'ada', threadRootId: 'root' },
      ],
    })
    stop()
    stopOpen()
    await new Promise((r) => setTimeout(r, 0))
    expect(frames).toHaveLength(2)
  })
})
