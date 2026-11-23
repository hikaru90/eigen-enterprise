import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { companyJoin, memberOpenJoin } from '$lib/server/db/auth.schema'
import type { OpenJoinStore } from './open-join'

/** Open join in Postgres (company_join, migration 0166): no row = off. */
export const dbOpenJoinStore: OpenJoinStore = {
  async get() {
    const [row] = await authDb.select({ on: companyJoin.openJoin }).from(companyJoin).where(eq(companyJoin.id, 'company')).limit(1)
    return row?.on ?? false
  },
  async set(on, actorId) {
    await authDb
      .insert(companyJoin)
      .values({ id: 'company', openJoin: on, updatedBy: actorId })
      .onConflictDoUpdate({ target: companyJoin.id, set: { openJoin: on, updatedBy: actorId, updatedAt: new Date() } })
  },
}

/** Whether the company is open to join right now (read with no actor: /signup, /login, the user-create hook). */
export const openJoinOn = (): Promise<boolean> => dbOpenJoinStore.get()

/** Records that this account came in through open join (the user-create hook, after the row exists). */
export async function recordOpenJoin(userId: string): Promise<void> {
  await authDb.insert(memberOpenJoin).values({ userId }).onConflictDoNothing()
}

/** Whether this account came in through open join. */
export async function joinedByOpenJoin(userId: string): Promise<boolean> {
  const rows = await authDb.select({ id: memberOpenJoin.userId }).from(memberOpenJoin).where(eq(memberOpenJoin.userId, userId)).limit(1)
  return rows.length > 0
}
