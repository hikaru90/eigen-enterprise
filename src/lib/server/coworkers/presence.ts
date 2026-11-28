import type { CoworkerPresencePort, CoworkerPresenceStatus } from '../../../../modules/messages/presence'
import type { TypingBoard } from '../../../../modules/messages/typing'
import type { CoworkerView } from './service'

/**
 * The co-workers' presence in Messages (Contribute 14aea69d), from facts: a
 * switched-on co-worker is available, busy while the typing board shows it
 * writing (a turn runs in this process), capped when today's AI budget is used
 * up (wish 32162c64), paused when switched off; a removed
 * one has no status. Changes: co-worker changes in this process and the board.
 */
export function coworkerPresencePort(deps: {
  list(): Promise<CoworkerView[]>
  board: Pick<TypingBoard, 'busy' | 'subscribe'>
  onCoworkersChanged(fn: () => void): () => void
  /** USD the co-worker spent on AI today (UTC), the same ledger its daily cap is checked against. */
  spentToday(userId: string): Promise<number>
}): CoworkerPresencePort {
  return {
    async statuses() {
      const out = new Map<string, CoworkerPresenceStatus>()
      for (const c of await deps.list()) {
        if (c.removedAt) continue
        if (!c.enabled) out.set(c.id, 'paused')
        else if (deps.board.busy(c.id)) out.set(c.id, 'busy')
        else out.set(c.id, (await deps.spentToday(c.id)) >= c.dailyCapUsd ? 'capped' : 'available')
      }
      return out
    },
    subscribe(onChange) {
      const a = deps.board.subscribe(() => onChange())
      const b = deps.onCoworkersChanged(onChange)
      return () => {
        a()
        b()
      }
    },
  }
}

/** Production: the database co-workers, this process's typing board and change bus. */
export async function liveCoworkerPresence(): Promise<CoworkerPresencePort> {
  const [{ listCoworkers }, { typingBoard }, { onCoworkersChanged }, { ledgerSpentUsdToday }] = await Promise.all([
    import('./index'),
    import('../../../../modules/messages/typing'),
    import('./changes'),
    import('../agent/ledger-spend'),
  ])
  return coworkerPresencePort({ list: listCoworkers, board: typingBoard(), onCoworkersChanged, spentToday: ledgerSpentUsdToday })
}
