/**
 * Call transcripts (direction agreed 2026-11-19, option A): each browser in a
 * call records its own microphone in ~30 s chunks and sends them one by one;
 * each chunk is transcribed (qwen/qwen3-asr-1.7b through the gateway) and
 * stored as one segment with its speaker and times. No bot, no audio leaves
 * the call server-side, the audio is never stored. The transcript is every
 * segment of the call merged by time (mergeTranscript).
 *
 * Times are the server's: a segment ends when its chunk arrived and starts
 * `durationMs` before — so every browser's chunks line up on one clock,
 * whatever the browsers' own clocks say.
 *
 * `seq` is arrival order. A live reader (the Company Brain listening to a
 * call, a follow-up) keeps the highest seq it has seen and asks for what
 * came after (TranscriptStore.list(callId, since)).
 *
 * Table: call_transcript_segment (drizzle/0157_call_transcripts.sql).
 */

export type SpeakerKind = 'member' | 'guest'

export type TranscriptSegment = {
  /** Arrival order (bigserial): a live reader's cursor. */
  seq: number
  callId: string
  /** The participant id: a user id, or guest:<id> (guestIdentity). */
  speakerId: string
  speakerKind: SpeakerKind
  /** Their name when they spoke. */
  speakerName: string
  startedAt: Date
  endedAt: Date
  text: string
  createdAt: Date
}

export type NewTranscriptSegment = Omit<TranscriptSegment, 'seq' | 'createdAt'>

export type TranscriptStore = {
  add(segment: NewTranscriptSegment): Promise<TranscriptSegment>
  /** The call's segments merged by time (mergeTranscript); with `since`, only those with seq > since. */
  list(callId: string, since?: number): Promise<TranscriptSegment[]>
  /** Segments per call; calls without any are absent. */
  countByCall(callIds: string[]): Promise<Map<string, number>>
}

/** How long each browser records before sending a chunk. */
export const TRANSCRIPT_CHUNK_MS = 30_000
/** The longest chunk the server accepts (a chunk is 30 s; a late timer may stretch it). */
export const MAX_CHUNK_MS = 60_000
/** The largest chunk upload: 60 s of 32 kbps opus is ≈ 240 KB; generous for container overhead. */
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024
/** The longest text one segment keeps (the column's check). */
export const MAX_SEGMENT_TEXT = 20_000

/** One transcript: by start time, then by arrival. */
export function mergeTranscript(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
  return [...segments].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.seq - b.seq)
}

export type TranscriptTurn = { speakerId: string; speakerKind: SpeakerKind; speakerName: string; startedAt: Date; endedAt: Date; text: string }

/** For reading: one speaker's consecutive segments (in merged order) as one turn. */
export function transcriptTurns(segments: readonly TranscriptSegment[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const s of mergeTranscript(segments)) {
    const last = turns.at(-1)
    if (last && last.speakerId === s.speakerId) {
      last.text = `${last.text} ${s.text}`
      if (s.endedAt > last.endedAt) last.endedAt = s.endedAt
      continue
    }
    turns.push({ speakerId: s.speakerId, speakerKind: s.speakerKind, speakerName: s.speakerName, startedAt: s.startedAt, endedAt: s.endedAt, text: s.text })
  }
  return turns
}

/** The store for specs: the Postgres store's semantics (seq in arrival order, merged reads). */
export class MemoryTranscriptStore implements TranscriptStore {
  readonly segments: TranscriptSegment[] = []
  #seq = 0

  async add(segment: NewTranscriptSegment): Promise<TranscriptSegment> {
    if (segment.text.length === 0 || segment.text.length > MAX_SEGMENT_TEXT) throw new Error('calls: a segment needs 1–20000 characters of text')
    if (segment.endedAt < segment.startedAt) throw new Error('calls: a segment ends after it starts')
    const stored: TranscriptSegment = { ...segment, seq: ++this.#seq, createdAt: new Date(segment.endedAt) }
    this.segments.push(stored)
    return structuredClone(stored)
  }

  async list(callId: string, since?: number): Promise<TranscriptSegment[]> {
    return structuredClone(mergeTranscript(this.segments.filter((s) => s.callId === callId && (since === undefined || s.seq > since))))
  }

  async countByCall(callIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>()
    for (const s of this.segments) if (callIds.includes(s.callId)) counts.set(s.callId, (counts.get(s.callId) ?? 0) + 1)
    return counts
  }
}
