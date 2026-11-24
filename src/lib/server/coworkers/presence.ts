import type { CoworkerPresencePort, CoworkerPresenceStatus } from '../../../../modules/messages/presence'
import type { TypingBoard } from '../../../../modules/messages/typing'
import type { CoworkerView } from './service'

/**
 * The co-workers' presence in Messages (Contribute 14aea69d), from facts: a
 * switched-on co-worker is available, busy while the typing board shows it
 * writing (a turn runs in this process), paused when switched off; a removed
 * one has no status. Changes: co-worker changes in this process and the board.
 */
export function coworkerPresencePort(deps: {
  list(): Promise<CoworkerView[]>
  board: Pick<TypingBoard, 'busy' | 'subscribe'>
  onCoworkersChanged(fn: () => void): () => void
}): CoworkerPresencePort {
  return {
    async statuses() {
      const out = new Map<string, CoworkerPresenceStatus>()
      for (const c of await deps.list()) {
        if (c.removedAt) continue
        out.set(c.id, !c.enabled ? 'paused' : deps.board.busy(c.id) ? 'busy' : 'available')
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
  const [{ listCoworkers }, { typingBoard }, { onCoworkersChanged }] = await Promise.all([
    import('./index'),
    import('../../../../modules/messages/typing'),
    import('./changes'),
  ])
  return coworkerPresencePort({ list: listCoworkers, board: typingBoard(), onCoworkersChanged })
}
