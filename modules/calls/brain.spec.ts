import { describe, expect, it } from 'vitest'
import {
  BRAIN_CALL_SYSTEM_PROMPT,
  BRAIN_RECAP_SYSTEM_PROMPT,
  brainAnswerMessages,
  heardSegments,
  heardTranscriptText,
  MAX_BRAIN_QUESTION,
} from './brain'
import { CallsError } from './errors'
import { guestIdentity } from './state'
import { fixture } from './test-fixtures'
import { transcriptTurns, type TranscriptSegment } from './transcript'

/**
 * The Company Brain in a call (board 7f5f5423): off by default, switched on
 * per call by a member in it (everyone sees it), off by anyone; listen-only;
 * answers only an explicit ask, privately, as the asker; sharing is the
 * asker's choice; a recap after the call only on request, for whoever
 * switched it on. Guests can neither switch it on nor ask it.
 */

const audio = () => ({ bytes: new Uint8Array(3).fill(7), format: 'webm', durationMs: 30_000 })

async function liveDm() {
  const f = fixture()
  const call = await f.service.start(f.user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
  await f.service.accept('ben', call.id)
  await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ann' })
  await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${call.id}`, identity: 'ben' })
  return { f, id: call.id }
}

/** Someone says something: a 30 s chunk arriving now. */
async function say(f: ReturnType<typeof fixture>, who: string, id: string, text: string) {
  f.clock.tick(30_000)
  f.speech.next(text)
  await f.service.transcribeChunk(who, id, audio())
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

describe('Company Brain: on/off per call', () => {
  it('is off by default', async () => {
    const { f, id } = await liveDm()
    expect((await f.service.get('ann', id)).brain).toEqual({ listening: false, by: null, byName: null, since: null, turnedOnBy: [], shared: [] })
  })

  it('a member in the call switches it on — everyone in the call sees it listening, and who switched it on', async () => {
    const { f, id } = await liveDm()
    const at = f.clock.now().toISOString()
    const after = await f.service.setBrain('ann', id, true)
    expect(after.brain).toMatchObject({ listening: true, by: 'ann', byName: 'Ann Example', since: at, turnedOnBy: ['ann'] })
    expect((await f.service.get('ben', id)).brain.listening).toBe(true)
    // Switching on again changes nothing (the same stretch).
    expect((await f.service.setBrain('ben', id, true)).brain).toMatchObject({ by: 'ann', since: at })
  })

  it('anyone in the call can switch it off', async () => {
    const { f, id } = await liveDm()
    await f.service.setBrain('ann', id, true)
    const off = await f.service.setBrain('ben', id, false)
    expect(off.brain).toMatchObject({ listening: false, by: null, since: null, turnedOnBy: ['ann'] })
    expect((await f.service.get('ann', id)).brain.listening).toBe(false)
  })

  it('only people in the live call; the call ending switches it off', async () => {
    const f = fixture()
    const call = await f.service.start(f.user('ann'), { contextKind: 'channel', contextId: 'ch-general' })
    expect(await rejection(f.service.setBrain('dan', call.id, true))).toBe('not_found') // not in the channel
    expect(await rejection(f.service.setBrain('cat', call.id, true))).toBe('conflict') // rung, not in the call
    expect(await rejection(f.service.setBrain('ann', call.id, 'yes' as unknown as boolean))).toBe('invalid')
    await f.service.accept('ben', call.id)
    await f.service.setBrain('ben', call.id, true)
    await f.service.end(f.user('ann'), call.id)
    expect((await f.service.get('ann', call.id)).brain.listening).toBe(false)
    expect(await rejection(f.service.setBrain('ann', call.id, true))).toBe('conflict')
  })

  it('is stored with the call (a fresh read shows the same state)', async () => {
    const { f, id } = await liveDm()
    await f.service.setBrain('ann', id, true)
    const rec = await f.store.get(id)
    expect(rec?.brainListens).toEqual([expect.objectContaining({ onBy: 'ann', offAt: null, offBy: null })])
    await f.service.setBrain('ben', id, false)
    expect((await f.store.get(id))?.brainListens).toEqual([expect.objectContaining({ onBy: 'ann', offBy: 'ben' })])
  })
})

describe('Company Brain: guests', () => {
  async function meetingWithGuest() {
    const f = fixture()
    const out = await f.service.schedule(f.user('ann'), { guests: ['kunde@example.org'], timeZone: 'Europe/Berlin' })
    const token = decodeURIComponent(out.invitations[0]!.url.split('/join/')[1]!)
    await f.service.guestJoin(token, 'Kim Kunde')
    await f.service.applyWebhook({ kind: 'participant_joined', room: `ee-call-${out.call.id}`, identity: 'ann' })
    return { f, id: out.call.id, token, guest: guestIdentity(out.call.guests[0]!.id) }
  }

  it('cannot switch it on or off, nor ask it', async () => {
    const { f, id, guest } = await meetingWithGuest()
    expect(await rejection(f.service.setBrain(guest, id, true))).toBe('forbidden')
    await f.service.setBrain('ann', id, true)
    expect(await rejection(f.service.setBrain(guest, id, false))).toBe('forbidden')
    expect(await rejection(f.service.askBrain(guest, id, 'Wer ist das?'))).toBe('forbidden')
    expect(f.brain.asks).toEqual([])
  })

  it('see that it is listening — but none of the answers shared among colleagues', async () => {
    const { f, id, token } = await meetingWithGuest()
    await f.service.setBrain('ann', id, true)
    f.brain.next('Intern: Angebot 12.000 €.')
    const a = await f.service.askBrain('ann', id, 'Was haben wir angeboten?')
    await f.service.shareBrainAnswer('ann', id, a.id)
    const seen = await f.service.guestCall(token)
    expect(seen.brain).toMatchObject({ listening: true, byName: 'Ann Example', shared: [], turnedOnBy: [] })
    expect(JSON.stringify(seen)).not.toContain('12.000')
  })
})

describe('Company Brain: answers only when asked', () => {
  it('nothing makes it answer on its own: switching, speech, switching off, the call ending', async () => {
    const { f, id } = await liveDm()
    await f.service.setBrain('ann', id, true)
    await say(f, 'ann', id, 'Ben, wann war nochmal der Termin mit Müller?')
    await say(f, 'ben', id, 'Ich glaube am Dienstag.')
    await f.service.setBrain('ben', id, false)
    await f.service.setBrain('ann', id, true)
    await f.service.end(f.user('ann'), id)
    expect(f.brain.asks).toEqual([])
    expect(f.brain.recaps).toEqual([])
  })

  it('an ask runs as the asker, with what it heard while listening (not before) and the people in the call', async () => {
    const { f, id } = await liveDm()
    await say(f, 'ann', id, 'Das hier sagen wir, bevor das Brain zuhört.')
    await f.service.setBrain('ann', id, true)
    await say(f, 'ann', id, 'Das Angebot an Müller geht morgen raus.')
    await say(f, 'ben', id, 'Okay, ich prüfe die Preise.')
    f.brain.next('Ann said the offer to Müller goes out tomorrow.')
    const answer = await f.service.askBrain('ben', id, '  When does the offer go out?  ')
    expect(answer).toMatchObject({ question: 'When does the offer go out?', answer: 'Ann said the offer to Müller goes out tomorrow.', shared: false })
    expect(f.brain.asks).toHaveLength(1)
    const ask = f.brain.asks[0]!
    expect(ask).toMatchObject({ askerId: 'ben', askerName: 'Ben Example', question: 'When does the offer go out?', callTitle: 'Ann Example, Ben Example' })
    expect(ask.people).toEqual(['Ann Example', 'Ben Example'])
    expect(ask.heard).toContain('Ann Example: Das Angebot an Müller geht morgen raus.')
    expect(ask.heard).toContain('Ben Example: Okay, ich prüfe die Preise.')
    expect(ask.heard).not.toContain('bevor das Brain zuhört')
  })

  it('only while it listens, only a real question, only people in the call', async () => {
    const { f, id } = await liveDm()
    expect(await rejection(f.service.askBrain('ann', id, 'Hallo?'))).toBe('conflict') // off
    await f.service.setBrain('ann', id, true)
    expect(await rejection(f.service.askBrain('ann', id, '   '))).toBe('invalid')
    expect(await rejection(f.service.askBrain('ann', id, 'x'.repeat(MAX_BRAIN_QUESTION + 1)))).toBe('invalid')
    expect(await rejection(f.service.askBrain('cat', id, 'Hallo?'))).toBe('not_found')
    await f.service.setBrain('ben', id, false)
    expect(await rejection(f.service.askBrain('ann', id, 'Hallo?'))).toBe('conflict')
    expect(f.brain.asks).toEqual([])
  })

  it('the answer is the asker’s alone: not in the call for others, not in their list', async () => {
    const { f, id } = await liveDm()
    await f.service.setBrain('ann', id, true)
    f.brain.next('Aus deiner Memory: Gehalt von Cat ist 80k.')
    const a = await f.service.askBrain('ben', id, 'Was verdient Cat?')
    expect(JSON.stringify(await f.service.get('ann', id))).not.toContain('80k')
    expect(JSON.stringify(await f.service.get('ben', id))).not.toContain('80k')
    expect(await f.service.myBrainAnswers('ann', id)).toEqual([])
    expect(await f.service.myBrainAnswers('ben', id)).toEqual([expect.objectContaining({ id: a.id, shared: false })])
  })
})

describe('Company Brain: sharing an answer with the call', () => {
  it('the asker shares it: every colleague in the call sees it, from the Brain, asked by them', async () => {
    const { f, id } = await liveDm()
    await f.service.setBrain('ann', id, true)
    f.brain.next('The kickoff was on 3 November.')
    const a = await f.service.askBrain('ben', id, 'When was the kickoff?')
    const shared = await f.service.shareBrainAnswer('ben', id, a.id)
    expect(shared.brain.shared).toEqual([
      expect.objectContaining({ id: a.id, askedBy: 'ben', askedByName: 'Ben Example', question: 'When was the kickoff?', answer: 'The kickoff was on 3 November.' }),
    ])
    expect((await f.service.get('ann', id)).brain.shared).toHaveLength(1)
    expect(await f.service.myBrainAnswers('ben', id)).toEqual([expect.objectContaining({ id: a.id, shared: true })])
    // Twice is once.
    expect((await f.service.shareBrainAnswer('ben', id, a.id)).brain.shared).toHaveLength(1)
  })

  it('nobody else can share it; not after the call', async () => {
    const { f, id } = await liveDm()
    await f.service.setBrain('ann', id, true)
    f.brain.next('Antwort.')
    const a = await f.service.askBrain('ben', id, 'Frage?')
    expect(await rejection(f.service.shareBrainAnswer('ann', id, a.id))).toBe('not_found')
    expect(await rejection(f.service.shareBrainAnswer('ben', id, 'nope'))).toBe('not_found')
    await f.service.end(f.user('ann'), id)
    expect(await rejection(f.service.shareBrainAnswer('ben', id, a.id))).toBe('conflict')
  })
})

describe('Company Brain: the recap after the call', () => {
  it('is generated only when whoever switched it on asks — from what it heard — and posted nowhere', async () => {
    const { f, id } = await liveDm()
    await f.service.setBrain('ann', id, true)
    await say(f, 'ben', id, 'Wir machen das Angebot fertig.')
    await f.service.end(f.user('ann'), id)
    expect(f.brain.recaps).toEqual([])
    const ended = await f.service.get('ann', id)
    expect(ended.brain.turnedOnBy).toEqual(['ann'])
    f.brain.next('Decided: finish the offer.')
    expect(await f.service.brainRecap('ann', id)).toEqual({ recap: 'Decided: finish the offer.' })
    expect(f.brain.recaps).toHaveLength(1)
    expect(f.brain.recaps[0]).toMatchObject({ userId: 'ann', callTitle: 'Ann Example, Ben Example' })
    expect(f.brain.recaps[0]!.heard).toContain('Ben Example: Wir machen das Angebot fertig.')
    expect((await f.service.get('ben', id)).brain.shared).toEqual([])
  })

  it('not for someone who did not switch it on, not while the call goes on, not when it heard nothing', async () => {
    const { f, id } = await liveDm()
    await f.service.setBrain('ann', id, true)
    expect(await rejection(f.service.brainRecap('ann', id))).toBe('conflict') // still going
    await f.service.end(f.user('ann'), id)
    expect(await rejection(f.service.brainRecap('ben', id))).toBe('forbidden')
    expect(await rejection(f.service.brainRecap('ann', id))).toBe('conflict') // nothing heard
    expect(await rejection(f.service.brainRecap('cat', id))).toBe('not_found')
    expect(f.brain.recaps).toEqual([])
  })
})

describe('what the Brain hears and is told', () => {
  const seg = (seq: number, startS: number, endS: number, text: string, speakerName = 'Ann Example'): TranscriptSegment => ({
    seq,
    callId: 'c',
    speakerId: speakerName,
    speakerKind: 'member',
    speakerName,
    startedAt: new Date(startS * 1000),
    endedAt: new Date(endS * 1000),
    text,
    createdAt: new Date(endS * 1000),
  })

  it('only segments said entirely while it listened', () => {
    const rec = {
      brainListens: [
        { id: 'l1', callId: 'c', onBy: 'ann', onAt: new Date(100_000), offAt: new Date(200_000), offBy: 'ben' },
        { id: 'l2', callId: 'c', onBy: 'ann', onAt: new Date(300_000), offAt: null, offBy: null },
      ],
    } as Parameters<typeof heardSegments>[0]
    const segments = [seg(1, 70, 100, 'before'), seg(2, 90, 120, 'straddles on'), seg(3, 100, 130, 'in 1'), seg(4, 190, 220, 'straddles off'), seg(5, 300, 330, 'in 2')]
    expect(heardSegments(rec, segments, new Date(400_000)).map((s) => s.text)).toEqual(['in 1', 'in 2'])
  })

  it('reads the transcript as timed lines, guests marked', () => {
    const turns = transcriptTurns([seg(1, 60, 90, 'Hallo.'), { ...seg(2, 95, 120, 'Guten Tag.', 'Kim Kunde'), speakerKind: 'guest' }])
    expect(heardTranscriptText(turns, new Date(0))).toBe('[01:00] Ann Example: Hallo.\n[01:35] Kim Kunde (guest): Guten Tag.')
  })

  it('the standing instructions: listen only, answer only the question, briefly, never guess names or dates, never ask back', () => {
    expect(BRAIN_CALL_SYSTEM_PROMPT).toContain('You only listen.')
    expect(BRAIN_CALL_SYSTEM_PROMPT).toContain('Never ask a question back.')
    expect(BRAIN_CALL_SYSTEM_PROMPT).toContain('Do not add suggestions, ideas, opinions, notes')
    expect(BRAIN_CALL_SYSTEM_PROMPT).toContain("say plainly that you don't know it")
    expect(BRAIN_CALL_SYSTEM_PROMPT).toContain('a name, a date, a number or a fact')
    expect(BRAIN_RECAP_SYSTEM_PROMPT).toContain('Never guess')
    const [system, user] = brainAnswerMessages({
      askerId: 'ben',
      askerName: 'Ben Example',
      question: 'Wann?',
      callTitle: 'Sync',
      people: ['Ann Example', 'Ben Example'],
      heard: '[00:00] Ann Example: Morgen.',
      memory: 'Not in memory.',
    })
    expect(system).toEqual({ role: 'system', content: BRAIN_CALL_SYSTEM_PROMPT })
    expect(user.content).toContain('[00:00] Ann Example: Morgen.')
    expect(user.content).toContain('Not in memory.')
    expect(user.content).toContain('Ben Example asks: Wann?')
    expect(user.content).toContain("say you don't know")
  })
})
