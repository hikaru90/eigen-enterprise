import { z } from 'zod'
import type { DecisionResult } from '$lib/server/decisions/decide'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import {
  addEntry,
  getHandover,
  HandoverError,
  SENTENCE_MAX,
  updateEntry,
  type HandoverActor,
  type HandoverDeps,
  type HandoverEntryView,
} from '$lib/server/memory/handover/service'
import { topicKey, type HandoverStatus } from '$lib/server/memory/handover/store'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import { memoryHandoverStatus, type HandoverStatusInput } from './decision-kinds'

/**
 * The brain's handover upkeep (plan/handover.md §3): from a source — a memory
 * item, a note, a mail, a call recap the brain just read — draft or refresh the
 * handover entry on that topic. The step is split by decision shape (AGENTS.md):
 *
 *   - status, a closed set of three → Jev (memory.handover_status, enforced;
 *     unsure → a question to the owner in Needs you, and the call is pending);
 *   - the one sentence, new text → the gateway LLM, which only writes;
 *   - which entry → structure: the entry on the same topic, else a new one.
 *
 * A status the owner gives (themself or their assistant on their word) is used
 * as is, and Jev is not asked. Only the owner's side drafts on their handover.
 */

export const HANDOVER_SENTENCE_LOG_CONTEXT = 'handover_sentence'

export type SentenceInput = { ownerId: string; handoverTitle: string; topic: string; source: string; previous: string | null }

export type DraftDeps = {
  handover: HandoverDeps
  decideStatus: (input: HandoverStatusInput) => Promise<DecisionResult<HandoverStatus>>
  writeSentence: (input: SentenceInput) => Promise<string>
}

export type DraftInput = {
  handoverId: string
  topic: string
  /** What the entry is drafted from (a memory item's text, a note, a mail, a recap). */
  source: string
  link?: string | null
  /** The owner's own status: used as is, no Jev call. */
  status?: HandoverStatus
}

export type DraftResult =
  | { outcome: 'added' | 'updated'; entry: HandoverEntryView; statusSource: 'given' | 'jev' | 'human' | 'current_judge' }
  | { outcome: 'pending'; questionId: string; message: string }

export const SOURCE_MAX = 16_000

export async function draftEntry(d: DraftDeps, actor: HandoverActor, input: DraftInput): Promise<DraftResult> {
  const handover = await getHandover(d.handover, actor.userId, input.handoverId)
  if (!handover.canEdit) {
    throw new HandoverError('forbidden', `Only ${handover.owner.name} keeps "${handover.title}" up to date: it is their handover.`)
  }
  const topic = input.topic.trim()
  const source = input.source.trim()
  if (!topic) throw new HandoverError('invalid', 'A topic is required.')
  if (!source || source.length > SOURCE_MAX) throw new HandoverError('invalid', `The source needs 1 to ${SOURCE_MAX} characters.`)

  let status: HandoverStatus
  let statusSource: 'given' | 'jev' | 'human' | 'current_judge' = 'given'
  if (input.status) {
    status = input.status
  } else {
    const decision = await d.decideStatus({ handoverId: handover.id, handoverTitle: handover.title, ownerId: handover.owner.id, topic, source })
    if (decision.outcome === 'pending') {
      return {
        outcome: 'pending',
        questionId: decision.questionId,
        message: `The status of "${topic}" is unclear, so ${handover.owner.name} is asked in Needs you. Draft it again once they answered.`,
      }
    }
    if (decision.outcome !== 'decided') throw new Error(`memory.handover_status gave no decision (${decision.outcome}).`)
    status = decision.choice
    statusSource = decision.source
  }

  const existing = handover.entries.find((e) => topicKey(e.topic) === topicKey(topic)) ?? null
  const sentence = await d.writeSentence({ ownerId: handover.owner.id, handoverTitle: handover.title, topic, source, previous: existing?.sentence ?? null })
  if (existing) {
    const entry = await updateEntry(d.handover, actor, {
      entryId: existing.id,
      sentence,
      status,
      ...(input.link !== undefined && input.link !== null ? { link: input.link } : {}),
    })
    return { outcome: 'updated', entry, statusSource }
  }
  const entry = await addEntry(d.handover, actor, { handoverId: handover.id, topic, sentence, status, link: input.link ?? null })
  return { outcome: 'added', entry, statusSource }
}

// ── the sentence call ─────────────────────────────────────────────────────────

export function handoverSentenceMessages(input: Omit<SentenceInput, 'ownerId'>): ChatMessage[] {
  const system = [
    'You keep one entry of a company handover page up to date. A colleague taking the topic over reads it.',
    `Write exactly one sentence (at most ${SENTENCE_MAX} characters) that says the current state of the topic from the source.`,
    'Say what happened and what is open, as a camera could have observed it: no evaluation of people, no advice, no status label.',
    'Write in the language of the source. If a previous sentence is given, replace it with the current state.',
    'Answer with JSON only: {"sentence": "<the sentence>"}',
  ].join('\n')
  const user = [
    `Handover: ${input.handoverTitle}`,
    `Topic: ${input.topic}`,
    `Previous sentence: ${input.previous ?? '(none)'}`,
    '# Source',
    input.source,
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

const sentenceSchema = z.object({ sentence: z.string().trim().min(1).max(SENTENCE_MAX) })

/** Validates the model's JSON. Throws on anything else (no fallback text). */
export function parseHandoverSentence(response: unknown): string {
  const parsed = sentenceSchema.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`handover sentence failed the schema: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`)
  }
  return parsed.data.sentence
}

/** Production wiring: Jev through decide(), the sentence through the gateway in the owner's session on the company provider. */
export async function liveDraftDeps(): Promise<DraftDeps> {
  const { handoverDeps } = await import('$lib/server/memory/handover/live')
  return {
    handover: await handoverDeps(),
    decideStatus: async (input) => {
      const { decide } = await import('$lib/server/decisions/decide')
      return decide(memoryHandoverStatus, input, { requestedBy: input.ownerId, subjectUserId: input.ownerId, judge: { none: true } })
    },
    writeSentence: async (input) => {
      const [{ llmChatCompletion }, { onCompanyProvider }, { withDbUser }] = await Promise.all([
        import('$lib/server/llm/llm-client'),
        import('$lib/server/llm/company-provider'),
        import('$lib/server/db'),
      ])
      const response = await onCompanyProvider(() =>
        withDbUser(input.ownerId, () =>
          llmChatCompletion({
            userId: input.ownerId,
            messages: handoverSentenceMessages(input),
            temperature: 0,
            logContext: HANDOVER_SENTENCE_LOG_CONTEXT,
            responseFormat: 'json_object',
            // The source may be the owner's private Memory: never logged or analysed.
            contentOrigin: 'memory',
          }),
        ),
      )
      return parseHandoverSentence(response)
    },
  }
}
