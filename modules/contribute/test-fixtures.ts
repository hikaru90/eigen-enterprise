import type { JudgeChat } from './judge'
import type { ContributeDeps } from './service'
import { memoryContributeStore } from './memory-store'
import { memoryShareState, memoryShareStore } from './share/memory-store'

/** A judge answer as the gateway returns it. */
export const judged = (json: unknown) => ({ choices: [{ message: { content: JSON.stringify(json) } }] })

/**
 * Deps over the in-memory store; the judge answers from a queue (fails loud
 * when empty). `share` is the sharing state the store's outbox hooks write to
 * (sharing on unless `sharing: false`).
 */
export function fixture(answers: unknown[] = [], opts: { sharing?: boolean } = {}) {
  let clock = Date.parse('2026-11-10T10:00:00Z')
  const shareState = memoryShareState(opts.sharing ?? true, () => new Date(clock))
  const store = memoryContributeStore(shareState)
  const share = memoryShareStore(shareState)
  const queue = [...answers]
  const calls: Parameters<JudgeChat>[0][] = []
  const events: Array<{ type: string; principalId: string; payload: Record<string, unknown> }> = []
  let ids = 0
  const chat: JudgeChat = async (input) => {
    calls.push(input)
    if (queue.length === 0) throw new Error('fixture judge has no answer queued')
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  }
  const deps: ContributeDeps = {
    store,
    directory: { names: async () => new Map([['ana', 'Ana Lind'], ['ben', 'Ben Ode'], ['owner', 'Olga Owner']]) },
    chat,
    companyName: async () => 'Kindred Digital Labs',
    audit: async (e) => {
      events.push(e)
    },
    now: () => new Date((clock += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  }
  const tick = (ms: number) => {
    clock += ms
    return new Date(clock)
  }
  return { deps, store, calls, events, queue, share, shareState, now: () => new Date(clock), tick }
}
