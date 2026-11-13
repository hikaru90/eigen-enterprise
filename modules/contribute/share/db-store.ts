import type { OutboxEntry, OutboxState, ShareSettings, ShareStore } from './store'
import { desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { contributeOutbox as outbox, contributeShareSettings as settingsTable } from '$lib/server/db/contribute.schema'

/** ShareStore over Postgres (migration 0136; company-level tables, no RLS). */

type OutboxRow = typeof outbox.$inferSelect

const toEntry = (r: OutboxRow): OutboxEntry => ({
  contributionId: r.contributionId,
  state: r.state as OutboxState,
  summary: r.summary,
  language: r.language,
  lastSentHash: r.lastSentHash,
  attempts: r.attempts,
  nextAttemptAt: r.nextAttemptAt,
  lastError: r.lastError,
  sentAt: r.sentAt,
  updatedAt: r.updatedAt,
})

/** The SQL a contribute store runs in its insert transaction: a pending row, only while sharing is on. */
export const enqueueSql = (id: string) => sql`
  INSERT INTO contribute_outbox (contribution_id, state)
  SELECT ${id}::uuid, 'pending' FROM contribute_share_settings WHERE id = 1 AND enabled
  ON CONFLICT (contribution_id) DO NOTHING`

/** The SQL a contribute store runs with a status/note/vote change: a sent row is due again; any live row's claim token moves. */
export const markDirtySql = (id: string) => sql`
  UPDATE contribute_outbox SET
    state = CASE WHEN state = 'sent' THEN 'scrubbed' ELSE state END,
    next_attempt_at = CASE WHEN state = 'sent' THEN now() ELSE next_attempt_at END,
    updated_at = now()
  WHERE contribution_id = ${id}::uuid AND state IN ('pending', 'scrubbed', 'sent')`

const LIVE = sql`${outbox.state} IN ('pending', 'scrubbed')`

export function dbShareStore(db: AppDatabase): ShareStore {
  const setSettings = async (patch: Partial<typeof settingsTable.$inferInsert>) => {
    const out = await db.update(settingsTable).set(patch).where(eq(settingsTable.id, 1)).returning({ id: settingsTable.id })
    if (out.length === 0) throw new Error('contribute_share_settings has no row (migration 0136 seeds it)')
  }
  const patchRow = async (id: string, patch: Partial<typeof outbox.$inferInsert>) => {
    await db.update(outbox).set(patch).where(eq(outbox.contributionId, id))
  }

  return {
    async settings(): Promise<ShareSettings> {
      const [r] = await db.select().from(settingsTable).where(eq(settingsTable.id, 1)).limit(1)
      if (!r) throw new Error('contribute_share_settings has no row (migration 0136 seeds it)')
      return { enabled: r.enabled, installId: r.installId, registeredAt: r.registeredAt, revokedAt: r.revokedAt, lastError: r.lastError, updatedAt: r.updatedAt }
    },
    setEnabled: (enabled, at) => setSettings({ enabled, updatedAt: at }),
    setInstallId: (installId, at) => setSettings({ installId, updatedAt: at }),
    setRegistered: (registeredAt, at) => setSettings({ registeredAt, ...(registeredAt ? { lastError: null } : {}), updatedAt: at }),
    setRevoked: (revokedAt, lastError) => setSettings({ revokedAt, lastError, updatedAt: revokedAt }),
    setLastError: (lastError, at) => setSettings({ lastError, updatedAt: at }),

    async entry(id) {
      const [r] = await db.select().from(outbox).where(eq(outbox.contributionId, id)).limit(1)
      return r ? toEntry(r) : null
    },
    async entries(ids) {
      if (ids.length === 0) return new Map()
      const rows = await db.select().from(outbox).where(inArray(outbox.contributionId, [...ids]))
      return new Map(rows.map((r) => [r.contributionId, toEntry(r)]))
    },
    async counts() {
      const [c] = await db
        .select({
          waiting: sql<number>`count(*) FILTER (WHERE ${LIVE})::int`,
          sent: sql<number>`count(*) FILTER (WHERE ${outbox.state} = 'sent')::int`,
          failed: sql<number>`count(*) FILTER (WHERE ${outbox.state} = 'failed')::int`,
          withdrawing: sql<number>`count(*) FILTER (WHERE ${outbox.state} = 'excluded' AND ${outbox.lastSentHash} IS NOT NULL)::int`,
        })
        .from(outbox)
      const [e] = await db
        .select({ message: outbox.lastError, at: outbox.updatedAt })
        .from(outbox)
        .where(isNotNull(outbox.lastError))
        .orderBy(desc(outbox.updatedAt))
        .limit(1)
      return {
        waiting: c?.waiting ?? 0,
        sent: c?.sent ?? 0,
        failed: c?.failed ?? 0,
        withdrawing: c?.withdrawing ?? 0,
        lastError: e?.message ? { message: e.message, at: e.at } : null,
      }
    },

    async exclude(id, at) {
      const values = { contributionId: id, state: 'excluded' as const, nextAttemptAt: at, attempts: 0, lastError: null, updatedAt: at }
      await db
        .insert(outbox)
        .values(values)
        .onConflictDoUpdate({ target: outbox.contributionId, set: { state: 'excluded', nextAttemptAt: at, attempts: 0, lastError: null, updatedAt: at } })
    },
    async hasDue(now) {
      const rows = await db.execute<{ one: number }>(sql`
        SELECT 1 AS one FROM contribute_outbox
        WHERE next_attempt_at <= ${now.toISOString()}::timestamptz
          AND (state IN ('pending', 'scrubbed') OR (state = 'excluded' AND last_sent_hash IS NOT NULL))
        LIMIT 1`)
      return [...rows].length > 0
    },
    /** One statement, FOR UPDATE SKIP LOCKED: two tickers (blue-green slots) never claim the same row; the lease keeps it claimed. */
    async claimDue(now, limit, leaseUntil) {
      const at = now.toISOString()
      const claimed = await db.execute<{ contribution_id: string }>(sql`
        UPDATE contribute_outbox SET next_attempt_at = ${leaseUntil.toISOString()}::timestamptz, updated_at = ${at}::timestamptz
        WHERE contribution_id IN (
          SELECT contribution_id FROM contribute_outbox
          WHERE next_attempt_at <= ${at}::timestamptz
            AND (state IN ('pending', 'scrubbed') OR (state = 'excluded' AND last_sent_hash IS NOT NULL))
          ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        RETURNING contribution_id`)
      const ids = [...claimed].map((r) => r.contribution_id)
      if (ids.length === 0) return []
      const rows = await db.select().from(outbox).where(inArray(outbox.contributionId, ids)).orderBy(outbox.contributionId)
      return rows.map(toEntry)
    },
    async saveScrub(id, { summary, language }) {
      await db
        .update(outbox)
        .set({ summary, language, state: sql`CASE WHEN ${outbox.state} = 'pending' THEN 'scrubbed' ELSE ${outbox.state} END` })
        .where(eq(outbox.contributionId, id))
    },
    async markSent(id, hash, at, claimToken) {
      const untouched = sql`(${outbox.updatedAt} = ${claimToken.toISOString()}::timestamptz AND ${LIVE})`
      await db
        .update(outbox)
        .set({
          lastSentHash: hash,
          sentAt: at,
          attempts: 0,
          lastError: null,
          state: sql`CASE WHEN ${untouched} THEN 'sent' ELSE ${outbox.state} END`,
          nextAttemptAt: sql`CASE WHEN ${untouched} THEN ${outbox.nextAttemptAt} ELSE ${at.toISOString()}::timestamptz END`,
          updatedAt: sql`CASE WHEN ${untouched} THEN ${at.toISOString()}::timestamptz ELSE ${outbox.updatedAt} END`,
        })
        .where(eq(outbox.contributionId, id))
    },
    markRetry: (id, lastError, attempts, nextAttemptAt, at) => patchRow(id, { lastError, attempts, nextAttemptAt, updatedAt: at }),
    async markFailed(id, lastError, at) {
      await db
        .update(outbox)
        .set({ lastError, updatedAt: at, state: sql`CASE WHEN ${LIVE} THEN 'failed' ELSE ${outbox.state} END` })
        .where(eq(outbox.contributionId, id))
    },
    markWithdrawn: (id, at) => patchRow(id, { lastSentHash: null, sentAt: null, attempts: 0, lastError: null, updatedAt: at }),
    async withdrawAll(at) {
      await db
        .update(outbox)
        .set({ state: 'excluded', lastSentHash: null, sentAt: null, attempts: 0, lastError: null, nextAttemptAt: at, updatedAt: at })
    },
  }
}
