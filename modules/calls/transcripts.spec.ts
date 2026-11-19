import { describe, expect, it } from 'vitest'
import { CallsError } from './errors'
import { guestIdentity } from './state'
import { fixture } from './test-fixtures'
import { mergeTranscript, transcriptTurns, type TranscriptSegment } from './transcript'

/**
 * Call transcripts (option A, owner 2026-11-19): every browser sends its own
 * microphone in ~30 s chunks; each chunk is transcribed (qwen3-asr via the
 * gateway) and stored with its speaker and server-side timestamps; the
 * transcript is all segments merged by time. The audio is never stored.
 */

const audio = (n = 3) => ({ bytes: new Uint8Array(n).fill(7), format: 'webm', durationMs: 30_000 })

async function liveDm() {
  const f = fixture()
  const call = await f.service.start(f.user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
  await f.service.accept('ben', call.id)
  await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ann' })
  await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ben' })
  return { f, id: call.id }
}

const rejection = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    if (err instanceof CallsError) return err.code
    throw err
  }
  throw new Error('expected a refusal')
}

describe('transcribing a chunk of my microphone', () => {
  it('becomes a segment: my words, my name, timed by the server (end = receipt, start = end − duration)', async () => {
    const { f, id } = await liveDm()
    f.speech.next('Hallo Ben, kurz zum Angebot.')
    const received = f.clock.now()
    const out = await f.service.transcribeChunk('ann', id, audio())
    expect(out.segment).toMatchObject({
      speakerId: 'ann',
      speakerKind: 'member',
      speakerName: 'Ann Example',
      text: 'Hallo Ben, kurz zum Angebot.',
      endedAt: received.toISOString(),
      startedAt: new Date(received.getTime() - 30_000).toISOString(),
    })
    // The audio went to speech-to-text once, billed to me; it is not kept anywhere.
    expect(f.speech.calls).toEqual([{ userId: 'ann', audio: { bytes: audio().bytes, format: 'webm' } }])
    expect(JSON.stringify(await f.service.listTranscriptSegments(id))).not.toContain('"bytes"')
  })

  it('a chunk that held no speech ("") stores nothing', async () => {
    const { f, id } = await liveDm()
    f.speech.next('')
    expect((await f.service.transcribeChunk('ann', id, audio())).segment).toBeNull()
    expect(await f.service.listTranscriptSegments(id)).toEqual([])
  })

  it('only people in the live call, with their transcription on, and sane chunks', async () => {
    const { f, id } = await liveDm()
    expect(await rejection(f.service.transcribeChunk('cat', id, audio()))).toBe('not_found') // not in the DM
    expect(await rejection(f.service.transcribeChunk('ann', id, { ...audio(), durationMs: 0 }))).toBe('invalid')
    expect(await rejection(f.service.transcribeChunk('ann', id, { ...audio(), durationMs: 61_000 }))).toBe('invalid')
    expect(await rejection(f.service.transcribeChunk('ann', id, { ...audio(0) }))).toBe('invalid')
    await f.service.setTranscription('ann', id, false)
    expect(await rejection(f.service.transcribeChunk('ann', id, audio()))).toBe('conflict')
    await f.service.end(f.user('ann'), id)
    expect(await rejection(f.service.transcribeChunk('ben', id, audio()))).toBe('conflict')
    expect(f.speech.calls).toEqual([])
  })

  it('someone invited who has not accepted cannot send audio', async () => {
    const f = fixture()
    const call = await f.service.start(f.user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    expect(await rejection(f.service.transcribeChunk('cat', call.id, audio()))).toBe('conflict')
  })
})

describe('consent: my own transcription switch', () => {
  it('is on for everyone by default and visible to all in the call', async () => {
    const { f, id } = await liveDm()
    const seen = await f.service.get('ben', id)
    expect(seen.participants.map((p) => [p.userId, p.transcribing])).toEqual([
      ['ann', true],
      ['ben', true],
    ])
    const after = await f.service.setTranscription('ben', id, false)
    expect(after.participants.find((p) => p.userId === 'ben')?.transcribing).toBe(false)
    expect((await f.service.get('ann', id)).participants.find((p) => p.userId === 'ben')?.transcribing).toBe(false)
    const back = await f.service.setTranscription('ben', id, true)
    expect(back.participants.find((p) => p.userId === 'ben')?.transcribing).toBe(true)
  })

  it('only my own, only in a live call I am part of', async () => {
    const { f, id } = await liveDm()
    expect(await rejection(f.service.setTranscription('cat', id, false))).toBe('not_found')
    await f.service.end(f.user('ann'), id)
    expect(await rejection(f.service.setTranscription('ann', id, false))).toBe('conflict')
  })
})

describe('guests', () => {
  async function meetingWithGuest() {
    const f = fixture()
    const out = await f.service.schedule(f.user('ann'), { guests: ['kunde@example.org'], timeZone: 'Europe/Berlin' })
    const token = decodeURIComponent(out.invitations[0]!.url.split('/join/')[1]!)
    await f.service.guestJoin(token, 'Kim Kunde')
    return { f, id: out.call.id, token, guestId: out.call.guests[0]!.id }
  }

  it('a guest’s chunk is spoken by the guest (their name), billed to the host who invited them', async () => {
    const { f, id, token, guestId } = await meetingWithGuest()
    f.speech.next('Guten Tag zusammen.')
    const out = await f.service.guestTranscribeChunk(token, audio())
    expect(out.segment).toMatchObject({ speakerId: guestIdentity(guestId), speakerKind: 'guest', speakerName: 'Kim Kunde', text: 'Guten Tag zusammen.' })
    expect(f.speech.calls.map((c) => c.userId)).toEqual(['ann'])
    expect((await f.service.listTranscriptSegments(id)).map((s) => s.speakerKind)).toEqual(['guest'])
  })

  it('a guest turns their own transcription off; a withdrawn link sends nothing', async () => {
    const { f, id, token, guestId } = await meetingWithGuest()
    const off = await f.service.guestSetTranscription(token, false)
    expect(off.participants.find((p) => p.userId === guestIdentity(guestId))?.transcribing).toBe(false)
    expect(await rejection(f.service.guestTranscribeChunk(token, audio()))).toBe('conflict')
    await f.service.guestSetTranscription(token, true)
    await f.service.revokeGuest('ann', id, guestId)
    expect(await rejection(f.service.guestTranscribeChunk(token, audio()))).toBe('forbidden')
    expect(f.speech.calls).toEqual([])
  })
})

describe('reading the transcript', () => {
  it('is one transcript merged by time across speakers, however late each chunk arrived', async () => {
    const { f, id } = await liveDm()
    f.clock.tick(60_000)
    f.speech.next('Ben: zweiter Satz')
    await f.service.transcribeChunk('ben', id, { ...audio(), durationMs: 20_000 }) // spoke t+40s … t+60s
    f.speech.next('Ann: erster Satz')
    await f.service.transcribeChunk('ann', id, { ...audio(), durationMs: 30_000 }) // spoke t+30s … t+60s, arrived second
    f.clock.tick(30_000)
    f.speech.next('Ann: dritter Satz')
    await f.service.transcribeChunk('ann', id, audio())
    const read = await f.service.transcript('ben', id)
    expect(read.segments.map((s) => s.text)).toEqual(['Ann: erster Satz', 'Ben: zweiter Satz', 'Ann: dritter Satz'])
    expect(read.call.id).toBe(id)
  })

  it('only for those who were in the call; outsiders do not even see it exists', async () => {
    const f = fixture()
    const call = await f.service.start(f.user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    await f.service.accept('ben', call.id)
    await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ann' })
    await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ben' })
    f.speech.next('Hallo')
    await f.service.transcribeChunk('ann', call.id, audio())
    await f.service.end(f.user('ann'), call.id)
    expect((await f.service.transcript('ben', call.id)).segments).toHaveLength(1)
    expect(await rejection(f.service.transcript('cat', call.id))).toBe('forbidden') // in #general, never joined
    expect(await rejection(f.service.transcript('dan', call.id))).toBe('not_found') // not in #general
  })

  it('listTranscriptSegments(callId, since) gives a live reader only what is new (by seq)', async () => {
    const { f, id } = await liveDm()
    f.speech.next('eins')
    await f.service.transcribeChunk('ann', id, audio())
    const first = await f.service.listTranscriptSegments(id)
    expect(first.map((s) => s.text)).toEqual(['eins'])
    f.clock.tick(30_000)
    f.speech.next('zwei')
    await f.service.transcribeChunk('ben', id, audio())
    const next = await f.service.listTranscriptSegments(id, first.at(-1)!.seq)
    expect(next.map((s) => s.text)).toEqual(['zwei'])
    expect(await f.service.listTranscriptSegments(id, next.at(-1)!.seq)).toEqual([])
  })

  it('transcriptCounts: how many segments each of my calls has, only for calls I was in', async () => {
    const { f, id } = await liveDm()
    f.speech.next('eins')
    await f.service.transcribeChunk('ann', id, audio())
    const other = await f.service.start(f.user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    const mine = await f.service.list(f.user('ann'))
    expect(await f.service.transcriptCounts('ann', mine)).toEqual({ [id]: 1 })
    const cats = await f.service.list(f.user('cat'))
    expect(cats.map((c) => c.id)).toEqual([other.id])
    expect(await f.service.transcriptCounts('cat', cats)).toEqual({})
  })
})

describe('mergeTranscript / transcriptTurns (pure)', () => {
  const seg = (seq: number, speakerId: string, startS: number, endS: number, text: string): TranscriptSegment => ({
    seq,
    callId: 'c',
    speakerId,
    speakerKind: 'member',
    speakerName: speakerId.toUpperCase(),
    startedAt: new Date(startS * 1000),
    endedAt: new Date(endS * 1000),
    text,
    createdAt: new Date(seq * 1000),
  })

  it('orders by start time, then by arrival (seq)', () => {
    const merged = mergeTranscript([seg(3, 'b', 10, 30, 'b1'), seg(1, 'a', 0, 30, 'a1'), seg(2, 'a', 10, 40, 'a2')])
    expect(merged.map((s) => s.text)).toEqual(['a1', 'a2', 'b1'])
  })

  it('joins one speaker’s back-to-back segments into one turn', () => {
    const turns = transcriptTurns([seg(1, 'a', 0, 30, 'eins'), seg(2, 'a', 30, 60, 'zwei'), seg(3, 'b', 61, 70, 'drei'), seg(4, 'a', 71, 80, 'vier')])
    expect(turns.map((t) => [t.speakerName, t.text, t.startedAt.getTime() / 1000, t.endedAt.getTime() / 1000])).toEqual([
      ['A', 'eins zwei', 0, 60],
      ['B', 'drei', 61, 70],
      ['A', 'vier', 71, 80],
    ])
  })
})
