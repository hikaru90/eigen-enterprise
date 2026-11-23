import { and, count, eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'

/**
 * Active human members: production accounts in the Better Auth user table
 * (the rows Settings › Members lists). Agents and service principals are
 * kernel principals, never users; harness accounts are excluded. AI
 * co-workers (user.kind 'coworker') are no seat until the owner decides
 * otherwise (plan/phase-ai-coworkers.md §9).
 */
export async function countSeats(): Promise<number> {
  const [row] = await authDb
    .select({ n: count() })
    .from(user)
    .where(and(eq(user.accountKind, 'production'), eq(user.kind, 'human')))
  return row?.n ?? 0
}
