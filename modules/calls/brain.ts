import type { ChatMessage } from './chat'
import type { BrainListen, CallRecord, SharedBrainAnswer } from './store'
import type { TranscriptSegment, TranscriptTurn } from './transcript'
import { CallsError } from './errors'
import { isLive } from './state'
import { transcriptTurns } from './transcript'

/**
 * The Company Brain in a call (board item 7f5f5423, round 2). Learned from
 * people's experience of an AI in their meetings — it kept replying, offered
 * notes and takes nobody asked for, asked about details, mixed up names and
 * dates: a new employee who interrupts before understanding the room. So:
 *
 *   - OFF by default. A company member in the call switches it on for this
 *     call; everyone in the call sees that it is listening; anyone in it can
 *     switch it off. The call ending switches it off.
 *   - LISTEN-ONLY. While on it reads the call's transcript (what was said
 *     while it listened, ./transcript.ts). It never speaks, never posts,
 *     never asks back, never suggests anything — nothing runs on its own:
 *     no transcript segment, no switch, no call event makes it answer.
 *   - ANSWERS ONLY WHEN ASKED, to the one who asked ("Ask the Brain" in the
 *     call's panel), run as that person: their own Memory (row-level
 *     security), their AI usage. Short; it says it does not know rather than
 *     guess a name, a date or a fact. The asker may share an answer with the
 *     colleagues in the call; guests never see the company's knowledge.
 *   - AFTER THE CALL it offers a recap — generated only when the person who
 *     switched it on asks for one, shown to them, posted nowhere.
 *
 * Guests can neither switch it on nor ask it.
 */

/** The longest question someone may type. */
export const MAX_BRAIN_QUESTION = 1000
/** The longest answer kept (the column's check). */
export const MAX_BRAIN_ANSWER = 20_000
/** The newest transcript the Brain reads for one answer (characters, oldest dropped first). */
export const MAX_HEARD_CHARS = 60_000

/** The open stretch of listening (the Brain is on), or null. */
export const openListen = (rec: CallRecord): BrainListen | null => rec.brainListens.find((l) => l.offAt === null) ?? null

/** Is the Company Brain listening to this call right now? Only in a live call. */
export const brainListening = (rec: CallRecord): boolean => isLive(rec.call.state) && openListen(rec) !== null

/** A member switches the Brain on (already on: nothing changes). Only in a live call. */
export function brainOn(rec: CallRecord, userId: string, now: Date, id: string): CallRecord {
  if (!isLive(rec.call.state)) throw new CallsError('conflict', 'this call is over')
  if (openListen(rec)) return rec
  return { ...rec, brainListens: [...rec.brainListens, { id, callId: rec.call.id, onBy: userId, onAt: now, offAt: null, offBy: null }] }
}

/** Anyone in the call switches the Brain off (already off: nothing changes). */
export function brainOff(rec: CallRecord, userId: string, now: Date): CallRecord {
  const open = openListen(rec)
  if (!open) return rec
  return { ...rec, brainListens: rec.brainListens.map((l) => (l.id === open.id ? { ...l, offAt: now, offBy: userId } : l)) }
}

/** The asker shares one of their answers with the call (shared already: nothing changes). */
export function shareBrainAnswer(rec: CallRecord, answer: Omit<SharedBrainAnswer, 'sharedAt'>, now: Date): CallRecord {
  if (!isLive(rec.call.state)) throw new CallsError('conflict', 'this call is over')
  if (answer.callId !== rec.call.id) throw new Error(`calls: answer ${answer.id} belongs to another call`)
  if (rec.brainShared.some((s) => s.id === answer.id)) return rec
  return { ...rec, brainShared: [...rec.brainShared, { ...answer, sharedAt: now }] }
}

/** People who switched the Brain on in this call (the recap is offered to them). */
export const brainTurnedOnBy = (rec: CallRecord): string[] => [...new Set(rec.brainListens.map((l) => l.onBy))]

/**
 * What the Brain heard: the segments said entirely while it listened (a
 * segment that began before it was switched on, or ran past its switching
 * off, is not heard — what people said while the indicator was off stays
 * out). `now` closes an open stretch.
 */
export function heardSegments(rec: CallRecord, segments: readonly TranscriptSegment[], now: Date): TranscriptSegment[] {
  const stretches = rec.brainListens.map((l) => ({ from: l.onAt.getTime(), to: (l.offAt ?? now).getTime() }))
  return segments.filter((s) => stretches.some((w) => s.startedAt.getTime() >= w.from && s.endedAt.getTime() <= w.to))
}

/** The call's chat lines written while the Brain listened (the same stretches as heardSegments). */
export function heardChat(rec: CallRecord, messages: readonly ChatMessage[], now: Date): ChatMessage[] {
  const stretches = rec.brainListens.map((l) => ({ from: l.onAt.getTime(), to: (l.offAt ?? now).getTime() }))
  return messages.filter((m) => stretches.some((w) => m.createdAt.getTime() >= w.from && m.createdAt.getTime() <= w.to))
}

/** The heard call as the Brain reads it: one line per turn (chat lines marked "(chat)"), the newest MAX_HEARD_CHARS. */
export function heardTranscriptText(turns: readonly TranscriptTurn[], since: Date): string {
  const lines = turns.map(
    (t) =>
      `[${clock(t.startedAt.getTime() - since.getTime())}] ${t.speakerName}${t.speakerKind === 'guest' ? ' (guest)' : ''}${t.source === 'chat' ? ' (chat)' : ''}: ${t.text}`,
  )
  const kept: string[] = []
  let size = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 1
    if (size > MAX_HEARD_CHARS) break
    kept.unshift(lines[i])
  }
  if (kept.length < lines.length) kept.unshift('(earlier parts of the call are left out)')
  return kept.join('\n')
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`
}

/** The turns the Brain reads (re-exported for the service). */
export const heardTurns = (segments: readonly TranscriptSegment[]): TranscriptTurn[] => transcriptTurns(segments)

/**
 * One answer the Brain gave one person (call_brain_answer). Private to its
 * asker — it may come from their own Memory — until they share it
 * (sharedAt; the call record's brainShared is the shared view of the same rows).
 */
export type BrainAnswer = {
  id: string
  callId: string
  askedBy: string
  question: string
  answer: string
  askedAt: Date
  sharedAt: Date | null
}

export type BrainAnswerStore = {
  add(answer: Omit<BrainAnswer, 'sharedAt'>): Promise<void>
  get(id: string): Promise<BrainAnswer | null>
  /** One person's answers in one call, oldest first. */
  listMine(callId: string, userId: string): Promise<BrainAnswer[]>
  /** Keeps the recap the Brain wrote for this person (a newer one replaces it). */
  saveRecap(callId: string, userId: string, recap: string, at: Date): Promise<void>
  /** This person's kept recaps per call; calls without one are absent. */
  recapsFor(userId: string, callIds: string[]): Promise<Map<string, string>>
}

/** The store for specs (in memory). Sharing is the call record's (brainShared); the service reads it from there. */
export class MemoryBrainAnswerStore implements BrainAnswerStore {
  readonly answers: BrainAnswer[] = []

  async add(answer: Omit<BrainAnswer, 'sharedAt'>): Promise<void> {
    if (this.answers.some((a) => a.id === answer.id)) throw new Error(`calls: answer ${answer.id} exists`)
    this.answers.push({ ...structuredClone(answer), sharedAt: null })
  }

  async get(id: string): Promise<BrainAnswer | null> {
    const a = this.answers.find((x) => x.id === id)
    return a ? structuredClone(a) : null
  }

  async listMine(callId: string, userId: string): Promise<BrainAnswer[]> {
    return structuredClone(this.answers.filter((a) => a.callId === callId && a.askedBy === userId))
  }

  readonly recaps = new Map<string, string>()

  async saveRecap(callId: string, userId: string, recap: string): Promise<void> {
    this.recaps.set(`${callId}|${userId}`, recap)
  }

  async recapsFor(userId: string, callIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const id of callIds) {
      const r = this.recaps.get(`${id}|${userId}`)
      if (r !== undefined) out.set(id, r)
    }
    return out
  }
}

/** What one answer is built from (the service gathers it; the live wiring adds the asker's Memory). */
export type BrainAskInput = {
  /** Who asked: the answer runs as them (their Memory, their AI usage). */
  askerId: string
  askerName: string
  question: string
  callTitle: string
  /** Everyone in the call, by name (guests marked). */
  people: string[]
  /** What the Brain heard so far (heardTranscriptText); '' when nothing yet. */
  heard: string
}

export type BrainRecapInput = {
  /** Who asked for the recap: it runs as them. */
  userId: string
  callTitle: string
  people: string[]
  heard: string
}

/**
 * The answering side the service is handed (live: ./brain-live.ts, the
 * assistant's answer path — the asker's Memory through composeAnswer under
 * their row-level security, then one gateway completion with these prompts;
 * specs: a fake). Called ONLY from an explicit ask or recap request.
 */
export type CallBrain = {
  answer(input: BrainAskInput): Promise<string>
  recap(input: BrainRecapInput): Promise<string>
}

/** The Brain's standing instructions in a call (the system prompt of every answer). */
export const BRAIN_CALL_SYSTEM_PROMPT = [
  "You are the company's Brain, listening in on a video call because someone in it switched you on.",
  'You only listen. You speak only when one person asks you something, and only that person sees your answer.',
  'Answer exactly the question asked — nothing else. Do not add suggestions, ideas, opinions, notes, summaries, follow-up offers or questions.',
  'Never ask a question back. Never ask for project details or more context: answer with what you have, or say what you do not know.',
  'Be brief: one to three short sentences, unless the question asks for a list.',
  "Never guess. If the transcript or the asker's memory does not clearly say a name, a date, a number or a fact, say plainly that you don't know it — never fill the gap with something plausible.",
  'Keep people apart: attribute what was said only to the speaker the transcript names. If you are not sure who said something, say so.',
  'The transcript is speech-to-text: words, names and numbers in it can be misheard. When an answer rests on a doubtful word, say it may be misheard.',
  "Use the asker's memory only when it answers the question. It is theirs: do not mention memories that are not needed for the answer.",
].join('\n')

/** The messages for one answer: the standing prompt, then the call, what was heard, the asker's memory, the question. */
export function brainAnswerMessages(input: BrainAskInput & { memory: string }): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: BRAIN_CALL_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Call: ${input.callTitle}`,
        `People in the call: ${input.people.join(', ')}`,
        `Asked by: ${input.askerName}`,
        '',
        'What was said while you listened (speech-to-text, merged by time):',
        input.heard.trim() === '' ? '(nothing has been transcribed since you were switched on)' : input.heard,
        '',
        `What ${input.askerName}'s own memory says about the question (only they can see it):`,
        input.memory.trim() === '' ? '(nothing)' : input.memory,
        '',
        `${input.askerName} asks: ${input.question}`,
        '',
        "Answer briefly, in the language of the question, without citation ids. If it isn't clearly in the transcript or the memory above, say you don't know.",
      ].join('\n'),
    },
  ]
}

/** The recap's instructions (generated after the call, only on request). */
export const BRAIN_RECAP_SYSTEM_PROMPT = [
  "You are the company's Brain. A call is over, and the person who switched you on asked you for a recap of what you heard.",
  'Write a short recap from the transcript only: what was discussed, what was decided, who agreed to do what.',
  'Use short bullet points under the headings "Discussed", "Decided" and "To do" (leave a heading out when the transcript has nothing for it).',
  'Never guess: do not invent names, dates, numbers, owners or decisions the transcript does not clearly contain. If something is unclear, write that it is unclear.',
  'Attribute statements only to the speaker the transcript names. The transcript is speech-to-text and can contain misheard words.',
  'Add no suggestions, opinions, next-step ideas or questions of your own.',
].join('\n')

export function brainRecapMessages(input: BrainRecapInput): { role: 'system' | 'user'; content: string }[] {
  return [
    { role: 'system', content: BRAIN_RECAP_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [`Call: ${input.callTitle}`, `People in the call: ${input.people.join(', ')}`, '', 'What was said while you listened:', input.heard].join('\n'),
    },
  ]
}
