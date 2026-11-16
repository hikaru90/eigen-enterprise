import { count, eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'

/**
 * Active human members: production accounts in the Better Auth user table
 * (the rows Settings › Members lists). Agents and service principals are
 * kernel principals, never users; harness accounts are excluded.
 */
export async function countSeats(): Promise<number> {
  const [row] = await authDb.select({ n: count() }).from(user).where(eq(user.accountKind, 'production'))
  return row?.n ?? 0
}
