import { describe, expect, it } from 'vitest'
import { heardChat, heardTranscriptText, heardTurns } from './brain'
import { chatTurns, MAX_CHAT_BODY, MemoryChatStore, parseChatBody, type ChatMessage } from './chat'
import { CallsError } from './errors'
import { guestIdentity } from './state'
import { fixture } from './test-fixtures'
import { mergeTurns, type TranscriptSegment } from './transcript'

/**
 * Chat in a call (proposal bb05b451): people in a call — members and guests
 * invited by link — write text to each other while it goes on. The lines are
 * the call's (one Calls table for every call), stay after it, and are read
 * with the transcript and by the Company Brain, marked as chat.
 */

const rejection = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    if (err instanceof CallsError) return err.code
    throw err
  }
  throw new Error('expected a refusal')
}

const tokenOf = (url: string) => decodeURIComponent(url.split('/join/')[1]!)

async function liveDm() {
  const f = fixture()
  const call = await f.service.start(f.user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
  await f.service.accept('ben', call.id)
  await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ann' })
  await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ben' })
  return { f, id: call.id }
}

/** A meeting open now: ann hosts, ben invited, one guest who joined the room as "Kim Kunde". */
async function meetingWithGuest(opts: { enterRoom?: boolean } = {}) {
  const f = fixture()
  const out = await f.service.schedule(f.user('ann'), { userIds: ['ben'], guests: ['kunde@example.org'], timeZone: 'Europe/Berlin' })
  const token = tokenOf(out.invitations[0]!.url)
  const id = out.call.id
  const guestId = out.call.guests[0]!.id
  await f.service.guestJoin(token, 'Kim Kunde')
  await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${id}`, identity: 'ann' })
  if (opts.enterRoom !== false) await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${id}`, identity: guestIdentity(guestId) })
  return { f, id, token, guestId }
}

describe('parseChatBody', () => {
  it('trims; refuses empty, non-text and over-long lines', () => {
    expect(parseChatBody('  Hallo zusammen \n')).toBe('Hallo zusammen')
    expect(parseChatBody('Zeile 1\nZeile 2')).toBe('Zeile 1\nZeile 2')
    for (const bad of ['', '   ', 42, null, undefined, 'x'.repeat(MAX_CHAT_BODY + 1)]) {
      expect(() => parseChatBody(bad)).toThrow(CallsError)
    }
    expect(parseChatBody('x'.repeat(MAX_CHAT_BODY))).toHaveLength(MAX_CHAT_BODY)
  })
})

describe('a member writes in the chat of a call', () => {
  it('stores the line with my name, kind and the server’s time; everyone in the call reads it in order', async () => {
    const { f, id } = await liveDm()
    const at = f.clock.now()
    const first = await f.service.postChat('ann', id, '  Link zum Angebot folgt ')
    expect(first).toMatchObject({ authorId: 'ann', authorKind: 'member', authorName: 'Ann Example', body: 'Link zum Angebot folgt', createdAt: at.toISOString() })
    f.clock.tick(5_000)
    const second = await f.service.postChat('ben', id, 'Danke!')
    expect(second.seq).toBeGreaterThan(first.seq)
    const page = await f.service.chat('ben', id)
    expect(page).toEqual({ messages: [first, second], hasMore: false })
    // A live reader's cursor: only what came after it.
    expect((await f.service.chat('ann', id, first.seq)).messages).toEqual([second])
  })

  it('only people in the live call may write; the chat is over with the call', async () => {
    const f = fixture()
    const call = await f.service.start(f.user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    expect(await rejection(f.service.postChat('dan', call.id, 'hi'))).toBe('not_found') // not in #general
    expect(await rejection(f.service.postChat('cat', call.id, 'hi'))).toBe('conflict') // rung, not accepted
    expect(await rejection(f.service.postChat('ann', call.id, '   '))).toBe('invalid')
    await f.service.postChat('ann', call.id, 'Bin gleich da')
    await f.service.end(f.user('ann'), call.id)
    expect(await rejection(f.service.postChat('ann', call.id, 'noch was'))).toBe('conflict')
  })

  it('no chat of our own for a call on another provider', async () => {
    const f = fixture()
    const out = await f.service.schedule(f.user('ann'), { userIds: ['ben'], externalUrl: 'https://zoom.us/j/123', timeZone: 'UTC' })
    expect(await rejection(f.service.postChat('ann', out.call.id, 'hi'))).toBe('conflict')
  })

  it('reading: people who were in the call (after it too) or are in it now; nobody else', async () => {
    const f = fixture()
    const call = await f.service.start(f.user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    await f.service.accept('ben', call.id)
    // ben accepted (in the call, the join webhook not here yet): reads and writes.
    await f.service.postChat('ben', call.id, 'Hallo')
    expect((await f.service.chat('ben', call.id)).messages).toHaveLength(1)
    expect(await rejection(f.service.chat('cat', call.id))).toBe('forbidden') // rung, never in it
    expect(await rejection(f.service.chat('dan', call.id))).toBe('not_found')
    await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ben' })
    await f.service.end(f.user('ann'), call.id)
    expect((await f.service.chat('ben', call.id)).messages.map((m) => m.body)).toEqual(['Hallo'])
    expect(await rejection(f.service.chat('cat', call.id))).toBe('forbidden')
  })

  it('pages: hasMore when more lines follow than one read returns', async () => {
    const { f, id } = await liveDm()
    for (let i = 0; i < 205; i++) await f.service.postChat('ann', id, `Zeile ${i}`)
    const first = await f.service.chat('ben', id)
    expect(first.messages).toHaveLength(200)
    expect(first.hasMore).toBe(true)
    const rest = await f.service.chat('ben', id, first.messages.at(-1)!.seq)
    expect(rest.messages.map((m) => m.body)).toEqual(['Zeile 200', 'Zeile 201', 'Zeile 202', 'Zeile 203', 'Zeile 204'])
    expect(rest.hasMore).toBe(false)
  })

  it('canReadChat (the live stream’s check per person)', async () => {
    const { f, id } = await liveDm()
    const rec = (await f.service.load(id))!
    expect(await f.service.canReadChat('ann', rec)).toBe(true)
    expect(await f.service.canReadChat('cat', rec)).toBe(false)
    expect(await f.service.canReadChat(guestIdentity('nobody'), rec)).toBe(false)
  })
})

describe('a guest writes in the chat', () => {
  it('as their guest name, while they are in the room; members and the guest read the same chat', async () => {
    const { f, id, token, guestId } = await meetingWithGuest()
    const line = await f.service.guestPostChat(token, ' Guten Tag! ')
    expect(line).toMatchObject({ authorId: guestIdentity(guestId), authorKind: 'guest', authorName: 'Kim Kunde', body: 'Guten Tag!' })
    await f.service.postChat('ann', id, 'Willkommen')
    expect((await f.service.guestChat(token)).messages.map((m) => [m.authorName, m.body])).toEqual([
      ['Kim Kunde', 'Guten Tag!'],
      ['Ann Example', 'Willkommen'],
    ])
    expect((await f.service.chat('ann', id)).messages).toHaveLength(2)
    const rec = (await f.service.load(id))!
    expect(await f.service.canReadChat(guestIdentity(guestId), rec)).toBe(false) // guests read through their link, never the member stream
  })

  it('not before entering the room, not after leaving it, not once the link is withdrawn', async () => {
    const { f, id, token, guestId } = await meetingWithGuest({ enterRoom: false })
    expect(await rejection(f.service.guestPostChat(token, 'hallo?'))).toBe('conflict')
    await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${id}`, identity: guestIdentity(guestId) })
    await f.service.guestPostChat(token, 'jetzt')
    await f.service.applyWebhook({ kind: 'participant_left', room: `ee-call-${id}`, identity: guestIdentity(guestId) })
    expect(await rejection(f.service.guestPostChat(token, 'weg'))).toBe('conflict')
    await f.service.revokeGuest('ann', id, guestId)
    expect(await rejection(f.service.guestPostChat(token, 'zurück'))).toBe('forbidden')
    expect(await rejection(f.service.guestChat(token))).toBe('forbidden')
    expect(await rejection(f.service.guestChat('not-a-real-guest-link-token'))).toBe('not_found')
  })

  it('a guest who never joined (no name yet) reads nothing; the chat closes for guests with the meeting', async () => {
    const f = fixture()
    const out = await f.service.schedule(f.user('ann'), { guests: ['kunde@example.org'], timeZone: 'UTC' })
    const token = tokenOf(out.invitations[0]!.url)
    expect(await rejection(f.service.guestChat(token))).toBe('conflict')
    await f.service.guestJoin(token, 'Kim')
    expect((await f.service.guestChat(token)).messages).toEqual([])
    await f.service.end(f.user('ann'), out.call.id)
    expect(await rejection(f.service.guestChat(token))).toBe('conflict')
  })
})

describe('the chat with the transcript', () => {
  it('transcript() carries the chat lines; transcriptCounts counts them too', async () => {
    const { f, id } = await liveDm()
    await f.service.postChat('ann', id, 'Notiz: Angebot bis Freitag')
    const t = await f.service.transcript('ben', id)
    expect(t.chat.map((m) => m.body)).toEqual(['Notiz: Angebot bis Freitag'])
    expect(t.segments).toEqual([])
    const mine = await f.service.list(f.user('ann'))
    expect(await f.service.transcriptCounts('ann', mine)).toEqual({ [id]: 1 })
  })

  it('the Company Brain reads chat written while it listened, marked (chat), merged by time with what was said', async () => {
    const { f, id } = await liveDm()
    await f.service.postChat('ann', id, 'vor dem Brain')
    f.clock.tick(1_000)
    await f.service.setBrain('ann', id, true)
    f.clock.tick(30_000)
    f.speech.next('Wir reden über das Angebot.')
    await f.service.transcribeChunk('ben', id, { bytes: new Uint8Array(3).fill(7), format: 'webm', durationMs: 20_000 })
    f.clock.tick(1_000)
    await f.service.postChat('ann', id, 'Preis: 4.200 €')
    f.brain.next('Der Preis ist 4.200 €.')
    await f.service.askBrain('ann', id, 'Welcher Preis?')
    const heard = f.brain.asks[0]!.heard
    expect(heard).not.toContain('vor dem Brain')
    expect(heard.split('\n')).toEqual([expect.stringMatching(/Ben Example: Wir reden über das Angebot\.$/), expect.stringMatching(/Ann Example \(chat\): Preis: 4\.200 €$/)])
  })
})

describe('chat turns for the Brain (pure)', () => {
  const msg = (seq: number, authorId: string, s: number, body: string, kind: 'member' | 'guest' = 'member'): ChatMessage => ({
    seq,
    callId: 'c',
    authorId,
    authorKind: kind,
    authorName: authorId.toUpperCase(),
    body,
    createdAt: new Date(s * 1000),
  })
  const seg = (seq: number, speakerId: string, startS: number, endS: number, text: string): TranscriptSegment => ({
    seq,
    callId: 'c',
    speakerId,
    speakerKind: 'member',
    speakerName: speakerId.toUpperCase(),
    startedAt: new Date(startS * 1000),
    endedAt: new Date(endS * 1000),
    text,
    createdAt: new Date(endS * 1000),
  })

  it('each chat line is its own turn; merged with speech by time; never joined into a spoken turn', () => {
    const turns = mergeTurns(heardTurns([seg(1, 'a', 0, 30, 'eins'), seg(2, 'a', 30, 60, 'zwei')]), chatTurns([msg(1, 'a', 40, 'getippt'), msg(2, 'g', 70, 'hallo', 'guest')]))
    expect(turns.map((t) => [t.speakerName, t.source, t.text])).toEqual([
      ['A', 'speech', 'eins zwei'],
      ['A', 'chat', 'getippt'],
      ['G', 'chat', 'hallo'],
    ])
    expect(heardTranscriptText(turns, new Date(0)).split('\n')).toEqual(['[00:00] A: eins zwei', '[00:40] A (chat): getippt', '[01:10] G (guest) (chat): hallo'])
  })

  it('heardChat: only lines written while the Brain listened', async () => {
    const { f, id } = await liveDm()
    await f.service.setBrain('ann', id, true)
    f.clock.tick(10_000)
    await f.service.setBrain('ann', id, false)
    const rec = (await f.service.load(id))!
    const onAt = rec.brainListens[0]!.onAt.getTime() / 1000
    const lines = [msg(1, 'a', onAt - 1, 'davor'), msg(2, 'a', onAt + 5, 'dabei'), msg(3, 'a', onAt + 11, 'danach')]
    expect(heardChat(rec, lines, f.clock.now()).map((m) => m.body)).toEqual(['dabei'])
  })
})

describe('MemoryChatStore', () => {
  it('seq in arrival order; list since a cursor with a limit; get; counts per call', async () => {
    const s = new MemoryChatStore()
    const a = await s.add({ callId: 'c1', authorId: 'ann', authorKind: 'member', authorName: 'Ann', body: 'eins', createdAt: new Date(1) })
    const b = await s.add({ callId: 'c2', authorId: 'ben', authorKind: 'member', authorName: 'Ben', body: 'zwei', createdAt: new Date(2) })
    const c = await s.add({ callId: 'c1', authorId: 'ann', authorKind: 'member', authorName: 'Ann', body: 'drei', createdAt: new Date(3) })
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect((await s.list('c1')).map((m) => m.body)).toEqual(['eins', 'drei'])
    expect((await s.list('c1', a.seq)).map((m) => m.body)).toEqual(['drei'])
    expect((await s.list('c1', 0, 1)).map((m) => m.body)).toEqual(['eins'])
    expect(await s.get(b.seq)).toEqual(b)
    expect(await s.get(99)).toBeNull()
    expect(await s.countByCall(['c1', 'c2', 'c3'])).toEqual(new Map([['c1', 2], ['c2', 1]]))
  })
})
