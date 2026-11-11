import type { Call, CallContextKind, CallRecord, CallsStore, InsertResult, Participant } from './store'
import { and, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm'
import { callParticipants, calls } from '$lib/server/db/calls.schema'
import type { AppDatabase } from '$lib/server/db/context'
import { sameRecord } from './state'

/** Postgres channel every app process LISTENs on; the payload is the call id. */
export const CALLS_NOTIFY_CHANNEL = 'ee_calls'

/** The partial unique index: one live call per DM/channel (drizzle/0122_calls.sql). */
export const LIVE_CONTEXT_INDEX = 'call_live_context_idx'

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
type Db = Tx | AppDatabase

const LIVE = ['ringing', 'active'] as const

/** postgres-js reports a unique violation as code 23505 with the constraint's name (drizzle wraps it in `cause`). */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  for (let e = err as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '23505' && e.constraint_name === constraint) return true
  }
  return false
}

async function withParticipants(db: Db, rows: Call[]): Promise<CallRecord[]> {
  if (rows.length === 0) return []
  const ps = (await db
    .select()
    .from(callParticipants)
    .where(
      inArray(
        callParticipants.callId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(callParticipants.invitedAt, callParticipants.userId)) as Participant[]
  // The starter first, then by invitation (stable across reads).
  return rows.map((call) => ({
    call,
    participants: ps.filter((p) => p.callId === call.id).sort((a, b) => Number(b.userId === call.startedBy) - Number(a.userId === call.startedBy)),
  }))
}

async function select(db: Db, where: SQL | undefined, limit?: number): Promise<CallRecord[]> {
  const q = db.select().from(calls).where(where).orderBy(desc(calls.startedAt), desc(calls.id))
  return withParticipants(db, (await (limit ? q.limit(limit) : q)) as Call[])
}

const one = async (db: Db, where: SQL) => (await select(db, where, 1))[0] ?? null

async function notify(tx: Db, callId: string) {
  // Inside the write's transaction: delivered on commit, to every process.
  await tx.execute(sql`select pg_notify(${CALLS_NOTIFY_CHANNEL}, ${callId})`)
}

export function dbCallsStore(db: AppDatabase): CallsStore {
  return {
    async insert(rec): Promise<InsertResult> {
      try {
        await db.transaction(async (tx) => {
          await tx.insert(calls).values(rec.call)
          if (rec.participants.length > 0) await tx.insert(callParticipants).values(rec.participants)
          await notify(tx, rec.call.id)
        })
        return { ok: true }
      } catch (err) {
        if (!isUniqueViolation(err, LIVE_CONTEXT_INDEX) || rec.call.contextId === null) throw err
        return { ok: false, existing: await this.liveForContext(rec.call.contextKind, rec.call.contextId) }
      }
    },
    get: (id) => one(db, eq(calls.id, id)),
    getByRoom: (roomName) => one(db, eq(calls.roomName, roomName)),
    liveForContext: (kind: CallContextKind, contextId: string) =>
      one(db, and(eq(calls.contextKind, kind), eq(calls.contextId, contextId), inArray(calls.state, [...LIVE]))!),
    async listForUser(userId, limit) {
      const mine = db.select({ id: callParticipants.callId }).from(callParticipants).where(eq(callParticipants.userId, userId))
      return select(db, inArray(calls.id, mine), limit)
    },
    listStartedBy: (principalId, limit) => select(db, eq(calls.startedBy, principalId), limit),
    async liveForUser(userId) {
      const mine = db.select({ id: callParticipants.callId }).from(callParticipants).where(eq(callParticipants.userId, userId))
      return select(db, and(inArray(calls.id, mine), inArray(calls.state, [...LIVE])))
    },
    async ringingStartedBefore(cutoff) {
      const rows = await db
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.state, 'ringing'), lte(calls.startedAt, cutoff)))
      return rows.map((r) => r.id)
    },
    async mutate(id, change) {
      return db.transaction(async (tx) => {
        const [row] = (await tx.select().from(calls).where(eq(calls.id, id)).for('update')) as Call[]
        if (!row) return null
        const [before] = await withParticipants(tx, [row])
        const after = change(structuredClone(before))
        if (sameRecord(before, after)) return { before, after }
        await tx.update(calls).set({ state: after.call.state, endedAt: after.call.endedAt, title: after.call.title }).where(eq(calls.id, id))
        for (const p of after.participants) {
          const was = before.participants.find((x) => x.userId === p.userId)
          if (was && sameRecord({ call: before.call, participants: [was] }, { call: before.call, participants: [p] })) continue
          await tx
            .insert(callParticipants)
            .values(p)
            .onConflictDoUpdate({
              target: [callParticipants.callId, callParticipants.userId],
              set: { joinedAt: p.joinedAt, leftAt: p.leftAt, response: p.response },
            })
        }
        await notify(tx, id)
        return { before, after }
      })
    },
  }
}
