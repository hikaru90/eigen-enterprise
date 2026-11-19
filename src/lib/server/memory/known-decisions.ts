import { and, count, eq, ne } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { thought } from '$lib/server/db/schema'

/**
 * The `decision` thought category (ontology-db/seed-default-cognitive.ts): the
 * LLM's typed classification of a thought as "a choice made or actively being
 * weighed". `thought.category` is the single type axis, so this is a typed
 * key — the same way `'task'` is read elsewhere — never a guess from the text.
 */
const DECISION_CATEGORY = 'decision'

/**
 * How many decisions the person's Memory knows: their thoughts classified as
 * decisions that are still known — open or completed; archived means "not
 * relevant" and is left out. Memory is per person (RLS scopes every thought to
 * the signed-in user, enable_rls.sql), so this is never a company-wide total:
 * another account, whatever its role, counts none of them.
 */
export async function countKnownDecisions(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(thought)
    .where(
      and(
        eq(thought.userId, userId),
        eq(thought.category, DECISION_CATEGORY),
        ne(thought.lifecycleStatus, 'archived'),
      ),
    )
  if (!row) throw new Error('countKnownDecisions: count() returned no row')
  return row.n
}
