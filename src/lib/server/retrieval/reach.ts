import { and, eq, ne, or, sql, type SQL } from 'drizzle-orm'
import { thought, type MemoryAuthor } from '$lib/server/db/schema'

/**
 * Whose thoughts a read reaches (plan/phase-ai-coworkers.md §7, C4):
 * - 'mine' — the reader's own Memory (every caller's default: unchanged);
 * - 'team' — the AI co-workers' thoughts (company-visible, drizzle/0171) and
 *   colleagues' answers to team questions the reader can read (drizzle/0203: the
 *   question's asker and audience), never the reader's own; any other thought of
 *   a person is theirs alone;
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
  // Answers to team questions: the same audience rule as thought_team_question_read (0203).
  const answers = and(
    ne(thought.userId, readerId),
    sql`${thought.teamQuestionId} IS NOT NULL AND EXISTS (
      SELECT 1 FROM team_questions q
      WHERE q.id = ${thought.teamQuestionId}
        AND (q.author_id = ${readerId}
          OR q.audience_kind = 'company'
          OR ${readerId} = ANY (q.audience_user_ids)
          OR EXISTS (SELECT 1 FROM member_group_member gm WHERE gm.user_id = ${readerId} AND gm.group_id = ANY (q.audience_group_ids))))`,
  )!
  const team = or(coworkers, answers)!
  if (reach === 'mine') return own
  if (reach === 'team') return team
  return or(own, team)!
}
