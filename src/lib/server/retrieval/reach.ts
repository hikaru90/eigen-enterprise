import { and, eq, ne, or, sql, type SQL } from 'drizzle-orm'
import { thought, type MemoryAuthor } from '$lib/server/db/schema'

/**
 * Whose thoughts a read reaches (plan/phase-ai-coworkers.md §7, C4):
 * - 'mine' — the reader's own Memory (every caller's default: unchanged);
 * - 'team' — the AI co-workers' thoughts (company-visible, drizzle/0171), never
 *   the reader's own and never a person's: a person's thoughts are theirs alone;
 * - 'all'  — both.
 * The condition is part of the SQL that picks candidates, so access is decided
 * before anything is ranked; row level security holds underneath it. An author
 * filter ("only what I wrote myself") narrows the reader's own thoughts only.
 */
export type ThoughtReach = 'mine' | 'team' | 'all'

export const THOUGHT_REACHES = ['mine', 'team', 'all'] as const satisfies readonly ThoughtReach[]

export function thoughtReachCondition(
  readerId: string,
  reach: ThoughtReach,
  authorFilter?: MemoryAuthor,
): SQL {
  const own = and(eq(thought.userId, readerId), authorFilter ? eq(thought.author, authorFilter) : undefined)!
  const coworkers = and(
    ne(thought.userId, readerId),
    sql`EXISTS (SELECT 1 FROM "user" cw WHERE cw.id = ${thought.userId} AND cw.kind = 'coworker')`,
  )!
  if (reach === 'mine') return own
  if (reach === 'team') return coworkers
  return or(own, coworkers)!
}
