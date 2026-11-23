import type { CoworkerRunStore } from './run-store'
import { runEntry, type CoworkerRunEntry } from './run-log'
import { CoworkerError } from './service'

/**
 * "Needs you" for proactive work (plan/phase-ai-coworkers.md §3 "proactive
 * results land in their Needs you", C6): every finished or stopped rhythm or
 * assignment run is a notice for the co-worker's accountable human, and for an
 * assignment also for the person who gave the task, until they acknowledge it
 * (coworkers.notice_seen). Stored (coworker_run_notice), written when the run
 * ends (turns.ts afterWork).
 */

export type CoworkerNotice = {
  run: CoworkerRunEntry
  coworker: { id: string; name: string }
  /** When the notice was made (the run's end). */
  at: string
  /** Where to look: the post or the task when the reader may see it, else the co-worker's profile (its run log). */
  href: string
}

export type NoticeDeps = {
  runs: Pick<CoworkerRunStore, 'openNotices' | 'markNoticeSeen'>
  /** A co-worker's name (removed ones included). */
  nameOf(coworkerId: string): Promise<string>
  /** The conversations, of these, the reader may see. */
  visible(readerId: string, conversationIds: string[]): Promise<Set<string>>
  now?: () => Date
}

export const profileUrlOf = (userId: string) => `/settings/org/${encodeURIComponent(userId)}`

export async function needsYouNotices(d: NoticeDeps, userId: string): Promise<CoworkerNotice[]> {
  const open = await d.runs.openNotices(userId)
  if (open.length === 0) return []
  const visible = await d.visible(
    userId,
    open.flatMap((n) => (n.run.conversationId ? [n.run.conversationId] : [])),
  )
  const names = new Map<string, string>()
  for (const id of new Set(open.map((n) => n.run.coworkerUserId))) names.set(id, await d.nameOf(id))
  return open.map((n) => {
    const run = runEntry(n.run, visible, userId)
    return {
      run,
      coworker: { id: n.run.coworkerUserId, name: names.get(n.run.coworkerUserId)! },
      at: n.createdAt.toISOString(),
      href: run.threadUrl ?? run.taskUrl ?? profileUrlOf(n.run.coworkerUserId),
    }
  })
}

/** The person acknowledged a notice ("Got it"). */
export async function markNoticeSeen(d: NoticeDeps, userId: string, runId: string): Promise<{ runId: string; seen: true }> {
  if (!(await d.runs.markNoticeSeen(runId, userId, d.now ? d.now() : new Date()))) {
    throw new CoworkerError('not_found', `You have nothing from this co-worker run (${runId}) in your Needs you.`)
  }
  return { runId, seen: true }
}
