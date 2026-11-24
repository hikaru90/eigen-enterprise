import { canUse, type MessagesDeps } from './service'

/**
 * "<name> is typing…" (Contribute 14aea69d): who is writing a message where,
 * right now. Today the writers are AI co-workers while a turn runs
 * (coworkers/turns.ts starts an entry when the turn starts and stops it when
 * the reply is posted or the turn ends). In memory, one board per os process,
 * like presence ($lib/server/presence): nothing is stored, and the readable
 * fact behind it is the co-worker's running run (coworkers.runs).
 */

export type Typist = { userId: string; threadRootId: string | null }
/** Everyone writing in one conversation (empty: nobody any more). */
export type TypingFrame = { conversationId: string; typists: Typist[] }
export type TypingEntry = { conversationId: string } & Typist

const keyOf = (e: TypingEntry) => `${e.conversationId}|${e.threadRootId ?? ''}|${e.userId}`

export class TypingBoard {
  /** Entry key → how many open starts (two turns of one writer in one place). */
  readonly #open = new Map<string, { entry: TypingEntry; count: number }>()
  readonly #listeners = new Set<(f: TypingFrame) => void>()

  /** Shows `entry` until the returned stop is called (calling it again does nothing). */
  start(entry: TypingEntry): () => void {
    const key = keyOf(entry)
    const open = this.#open.get(key)
    if (open) open.count += 1
    else {
      this.#open.set(key, { entry: { ...entry }, count: 1 })
      this.#tell(entry.conversationId)
    }
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      const o = this.#open.get(key)
      if (!o) return
      o.count -= 1
      if (o.count > 0) return
      this.#open.delete(key)
      this.#tell(entry.conversationId)
    }
  }

  /** Whether this writer is writing anywhere. */
  busy(userId: string): boolean {
    for (const { entry } of this.#open.values()) if (entry.userId === userId) return true
    return false
  }

  /** Every conversation someone is writing in. */
  list(): TypingFrame[] {
    const ids = new Set([...this.#open.values()].map((o) => o.entry.conversationId))
    return [...ids].map((id) => this.#frame(id))
  }

  subscribe(fn: (f: TypingFrame) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #frame(conversationId: string): TypingFrame {
    const typists = [...this.#open.values()]
      .filter((o) => o.entry.conversationId === conversationId)
      .map((o) => ({ userId: o.entry.userId, threadRootId: o.entry.threadRootId }))
    return { conversationId, typists }
  }

  #tell(conversationId: string): void {
    const f = this.#frame(conversationId)
    for (const fn of [...this.#listeners]) {
      try {
        fn(f)
      } catch (err) {
        console.error('[messages] a typing listener failed', { conversationId, err })
      }
    }
  }
}

let board: TypingBoard | null = null
/** This os process's board. */
export function typingBoard(): TypingBoard {
  board ??= new TypingBoard()
  return board
}

export type TypingStream = { start(send: (f: TypingFrame) => void): Promise<() => void> }

/**
 * The typing part of one viewer's live feed: what is being written now, then
 * each change — only conversations the viewer may see, checked per frame.
 * Frames go out in the board's order (one check at a time).
 */
export function typingStreamFor(d: MessagesDeps, b: TypingBoard, viewerId: string): TypingStream {
  const maySee = async (conversationId: string) => {
    const c = await d.store.getConversation(conversationId)
    return c !== null && (await canUse(d, viewerId, c))
  }
  return {
    async start(send) {
      let stopped = false
      let chain = Promise.resolve()
      const forward = (f: TypingFrame) => {
        chain = chain
          .then(async () => {
            if (!stopped && (await maySee(f.conversationId)) && !stopped) send(f)
          })
          .catch((err: unknown) => console.error('[messages] a typing frame failed', { viewerId, conversationId: f.conversationId, err }))
      }
      // Subscribe and snapshot in the same tick: no change falls between them.
      const unsubscribe = b.subscribe(forward)
      for (const f of b.list()) forward(f)
      await chain
      return () => {
        stopped = true
        unsubscribe()
      }
    },
  }
}
