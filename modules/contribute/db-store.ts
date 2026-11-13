import type { ContributeStore, Contribution, ContributionWithVotes } from './store'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { contributionVotes as votes, contributions } from '$lib/server/db/contribute.schema'
import { enqueueSql, markDirtySql } from './share/db-store'

/**
 * ContributeStore over Postgres (company-level tables, migration 0121). Each
 * write also keeps the sharing outbox (migration 0136) in the same
 * transaction: a new proposal gets a pending row while sharing is on; a
 * status/note/vote change marks its row dirty.
 */
export function dbContributeStore(db: AppDatabase): ContributeStore {
  async function attachVotes(rows: Contribution[]): Promise<ContributionWithVotes[]> {
    if (rows.length === 0) return []
    const all = await db
      .select({ id: votes.contributionId, userId: votes.userId, direction: votes.direction })
      .from(votes)
      .where(inArray(votes.contributionId, rows.map((r) => r.id)))
    const byId = new Map<string, Map<string, 1 | -1>>()
    for (const v of all) {
      if (v.direction !== 1 && v.direction !== -1) throw new Error(`contribution vote ${v.id}/${v.userId} has direction ${v.direction}`)
      const m = byId.get(v.id) ?? new Map<string, 1 | -1>()
      m.set(v.userId, v.direction)
      byId.set(v.id, m)
    }
    return rows.map((r) => {
      const m = byId.get(r.id) ?? new Map<string, 1 | -1>()
      let score = 0
      for (const d of m.values()) score += d
      return { ...r, votes: m, score }
    })
  }

  return {
    async insert(c) {
      await db.transaction(async (tx) => {
        await tx.insert(contributions).values(c)
        await tx.insert(votes).values({ contributionId: c.id, userId: c.authorId, direction: 1 })
        await tx.execute(enqueueSql(c.id))
      })
    },
    async get(id) {
      const rows = await db.select().from(contributions).where(eq(contributions.id, id)).limit(1)
      const [row] = await attachVotes(rows as Contribution[])
      return row ?? null
    },
    async list(statuses) {
      if (statuses.length === 0) return []
      const rows = await db
        .select()
        .from(contributions)
        .where(inArray(contributions.status, [...statuses]))
        .orderBy(desc(contributions.createdAt))
      return attachVotes(rows as Contribution[])
    },
    async update(id, patch) {
      await db.transaction(async (tx) => {
        const out = await tx.update(contributions).set(patch).where(eq(contributions.id, id)).returning({ id: contributions.id })
        if (out.length === 0) throw new Error(`contribution ${id} not found`)
        await tx.execute(markDirtySql(id))
      })
    },
    async setVote(id, userId, direction) {
      await db.transaction(async (tx) => {
        if (direction === 0) {
          await tx.delete(votes).where(and(eq(votes.contributionId, id), eq(votes.userId, userId)))
        } else {
          await tx
            .insert(votes)
            .values({ contributionId: id, userId, direction })
            .onConflictDoUpdate({ target: [votes.contributionId, votes.userId], set: { direction } })
        }
        await tx.execute(markDirtySql(id))
      })
    },
  }
}
