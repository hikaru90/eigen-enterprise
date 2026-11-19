import type { NewTranscriptSegment, TranscriptSegment, TranscriptStore } from './transcript'
import { and, asc, count, eq, gt, inArray } from 'drizzle-orm'
import { callTranscriptSegments } from '$lib/server/db/calls.schema'
import type { AppDatabase } from '$lib/server/db/context'

/** Call transcript segments in Postgres (call_transcript_segment, migration 0157). */
export function dbTranscriptStore(db: AppDatabase): TranscriptStore {
  return {
    async add(segment: NewTranscriptSegment): Promise<TranscriptSegment> {
      const [row] = await db.insert(callTranscriptSegments).values(segment).returning()
      if (!row) throw new Error(`calls: storing a transcript segment of ${segment.callId} returned nothing`)
      return row as TranscriptSegment
    },
    async list(callId, since) {
      const where = since === undefined ? eq(callTranscriptSegments.callId, callId) : and(eq(callTranscriptSegments.callId, callId), gt(callTranscriptSegments.seq, since))
      return (await db
        .select()
        .from(callTranscriptSegments)
        .where(where)
        .orderBy(asc(callTranscriptSegments.startedAt), asc(callTranscriptSegments.seq))) as TranscriptSegment[]
    },
    async countByCall(callIds) {
      if (callIds.length === 0) return new Map()
      const rows = await db
        .select({ callId: callTranscriptSegments.callId, n: count() })
        .from(callTranscriptSegments)
        .where(inArray(callTranscriptSegments.callId, callIds))
        .groupBy(callTranscriptSegments.callId)
      return new Map(rows.map((r) => [r.callId, Number(r.n)]))
    },
  }
}
