import type { BrainListen, Call, CallContextKind, CallRecord, CallsStore, Guest, InsertResult, Participant, SharedBrainAnswer } from './store'
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm'
import { callBrainAnswers, callBrainListens, callGuests, callParticipants, calls } from '$lib/server/db/calls.schema'
import type { AppDatabase } from '$lib/server/db/context'
import { sameRecord } from './state'

/** Postgres channel every app process LISTENs on; the payload is the call id. */
export const CALLS_NOTIFY_CHANNEL = 'ee_calls'

/** The partial unique index: one live call per DM/channel (drizzle/0122_calls.sql). */
export const LIVE_CONTEXT_INDEX = 'call_live_context_idx'

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]
type Db = Tx | AppDatabase

const LIVE = ['scheduled', 'ringing', 'active'] as const

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
  const gs = (await db
    .select()
    .from(callGuests)
    .where(
      inArray(
        callGuests.callId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(callGuests.invitedAt, callGuests.email)) as Guest[]
  const ids = rows.map((r) => r.id)
  const ls = (await db.select().from(callBrainListens).where(inArray(callBrainListens.callId, ids)).orderBy(asc(callBrainListens.onAt), asc(callBrainListens.id))) as BrainListen[]
  // Only the shared answers belong to the call record; an unshared one is its asker's (brain-db-store.ts).
  const shared = (await db
    .select()
    .from(callBrainAnswers)
    .where(and(inArray(callBrainAnswers.callId, ids), isNotNull(callBrainAnswers.sharedAt)))
    .orderBy(asc(callBrainAnswers.sharedAt), asc(callBrainAnswers.id))) as SharedBrainAnswer[]
  // The starter first, then by invitation (stable across reads).
  return rows.map((call) => ({
    call,
    participants: ps.filter((p) => p.callId === call.id).sort((a, b) => Number(b.userId === call.startedBy) - Number(a.userId === call.startedBy)),
    guests: gs.filter((g) => g.callId === call.id),
    brainListens: ls.filter((l) => l.callId === call.id),
    brainShared: shared.filter((s) => s.callId === call.id),
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
          if (rec.guests.length > 0) await tx.insert(callGuests).values(rec.guests)
          if (rec.participants.length > 0) await tx.insert(callParticipants).values(rec.participants)
          if (rec.brainListens.length > 0 || rec.brainShared.length > 0) throw new Error(`calls: a new call has no Company Brain yet (${rec.call.id})`)
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
    getByGuestTokenHash: (tokenHash) =>
      one(db, inArray(calls.id, db.select({ id: callGuests.callId }).from(callGuests).where(eq(callGuests.tokenHash, tokenHash)))),
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
    async windowsEndedBefore(cutoff) {
      const rows = await db
        .select({ id: calls.id })
        .from(calls)
        .where(and(inArray(calls.state, ['scheduled', 'active']), isNotNull(calls.scheduledEnd), lte(calls.scheduledEnd, cutoff)))
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
        // Guests before participants: a new guest's row exists before its participant row.
        for (const g of after.guests) {
          const was = before.guests.find((x) => x.id === g.id)
          if (!was) await tx.insert(callGuests).values(g)
          else if (was.displayName !== g.displayName || was.revokedAt?.getTime() !== g.revokedAt?.getTime()) {
            await tx.update(callGuests).set({ displayName: g.displayName, revokedAt: g.revokedAt }).where(eq(callGuests.id, g.id))
          }
        }
        for (const p of after.participants) {
          const was = before.participants.find((x) => x.userId === p.userId)
          const only = (x: Participant): CallRecord => ({ call: before.call, participants: [x], guests: [], brainListens: [], brainShared: [] })
          if (was && sameRecord(only(was), only(p))) continue
          await tx
            .insert(callParticipants)
            .values(p)
            .onConflictDoUpdate({
              target: [callParticipants.callId, callParticipants.userId],
              set: { joinedAt: p.joinedAt, leftAt: p.leftAt, response: p.response, transcribe: p.transcribe },
            })
        }
        // The Company Brain: new listening stretches inserted, a closed one updated.
        for (const l of after.brainListens) {
          const was = before.brainListens.find((x) => x.id === l.id)
          if (!was) await tx.insert(callBrainListens).values(l)
          else if (was.offAt?.getTime() !== l.offAt?.getTime() || was.offBy !== l.offBy) {
            await tx.update(callBrainListens).set({ offAt: l.offAt, offBy: l.offBy }).where(eq(callBrainListens.id, l.id))
          }
        }
        // A newly shared answer: its asker's own row, marked shared (it must exist, unshared, theirs).
        for (const s of after.brainShared) {
          if (before.brainShared.some((x) => x.id === s.id)) continue
          const marked = await tx
            .update(callBrainAnswers)
            .set({ sharedAt: s.sharedAt })
            .where(and(eq(callBrainAnswers.id, s.id), eq(callBrainAnswers.callId, id), eq(callBrainAnswers.askedBy, s.askedBy), isNull(callBrainAnswers.sharedAt)))
            .returning({ id: callBrainAnswers.id })
          if (marked.length !== 1) throw new Error(`calls: sharing answer ${s.id} of ${id} matched no unshared answer of its asker`)
        }
        await notify(tx, id)
        return { before, after }
      })
    },
  }
}
