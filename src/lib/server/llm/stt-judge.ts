import { z } from 'zod'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'

/**
 * Layer 2 of "silence never becomes text" (ported from eigen's `stt-judge.ts`).
 *
 * Speech recognition invents text on quiet or noisy audio that the browser's level check
 * (Layer 1, `$lib/voice/clip-speech.ts`) let through: foreign-script fragments, repeated
 * syllables, subtitle-credit phrases. Whether a transcript is plausibly this person's real
 * dictation is a question about meaning, so an LLM decides it against a fixed catalog with a
 * JSON schema (AGENTS.md "LLM + ontology + JSON schema") — never a regex, a script range or
 * a word list. Post-LLM code only validates the JSON.
 *
 * Evidence for the person's languages is samples of their OWN recent writing (their latest
 * messages, cut short). No writing on record → the prompt says so and the judge decides on
 * recognition patterns alone.
 */

export const TRANSCRIPT_CHECK_CRITERIA = {
  dictation:
    "The text is plausibly what this person really said: a coherent utterance, also short, informal, mixed-language or unfinished speech, in a language that fits the person's own writing, or in any language when none of their writing is shown.",
  artefact:
    'The text is more likely an artefact of speech recognition on silence or noise: repeated syllables or words with no content, a stock subtitle or credit phrase (thanks for watching, subtitles by ...), a stray filler word with no content, or a fragment in a language or script that none of the person\'s own writing uses.',
} as const

export type TranscriptVerdict = keyof typeof TRANSCRIPT_CHECK_CRITERIA
const VERDICTS = Object.keys(TRANSCRIPT_CHECK_CRITERIA) as [TranscriptVerdict, ...TranscriptVerdict[]]

/** How many of the person's own recent messages are shown to the judge. */
export const WRITING_SAMPLE_LIMIT = 6
/** Each sample is cut to this many characters: enough to show the language, no more. */
export const WRITING_SAMPLE_MAX_CHARS = 160
/** Exactly 3 attempts, then a visible failure — the text is never passed through unjudged. */
export const STT_JUDGE_ATTEMPTS = 3
export const STT_JUDGE_LOG_CONTEXT = 'stt_judge'

export type SttJudgeChat = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  logContext?: string
  responseFormat?: 'json_object'
}) => Promise<unknown>

const outputSchema = z.object({
  verdict: z.enum(VERDICTS),
  reason: z.string().optional(),
})

/** Trims, drops empties, cuts each sample short. */
export function toWritingSamples(bodies: readonly string[]): string[] {
  return bodies
    .map((body) => body.trim())
    .filter((body) => body !== '')
    .slice(0, WRITING_SAMPLE_LIMIT)
    .map((body) => body.slice(0, WRITING_SAMPLE_MAX_CHARS))
}

export function buildTranscriptCheckMessages(input: { transcript: string; writingSamples: readonly string[] }): ChatMessage[] {
  const catalog = VERDICTS.map((v) => `- "${v}": ${TRANSCRIPT_CHECK_CRITERIA[v]}`).join('\n')
  const system = [
    "A speech recognition model transcribed a voice message from this person. Is the text plausibly real dictation by this person, or an artefact of recognition on silence or noise? When samples of the person's own recent writing are shown, they show which languages this person uses; they are a sample, not a complete list, and their content is not what is judged.",
    'Return JSON only, exactly this schema:',
    `{ "verdict": "${VERDICTS.join('" | "')}", "reason": "<one short sentence>" }`,
    'verdict must be exactly one key from the catalog:',
    catalog,
  ].join('\n')
  const writing =
    input.writingSamples.length > 0
      ? `Recent writing by this person (samples):\n${input.writingSamples.map((s) => `- ${JSON.stringify(s)}`).join('\n')}`
      : 'No writing by this person is on record yet.'
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${writing}\n\nTranscript to judge:\n${JSON.stringify(input.transcript)}` },
  ]
}

/** Validates the judge's JSON against the schema. Throws on anything else. */
export function parseTranscriptVerdict(response: unknown): TranscriptVerdict {
  const parsed = outputSchema.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) {
    throw new Error(`transcript check failed the schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  }
  return parsed.data.verdict
}

/**
 * One judged transcript, up to {@link STT_JUDGE_ATTEMPTS} attempts at a valid answer. The
 * gateway's own errors (no provider, transport after its retries) are final and surface
 * as-is. Never logs the transcript — only the attempt and the parse error.
 */
export async function judgeTranscript(
  chat: SttJudgeChat,
  input: { userId: string; transcript: string; writingSamples: readonly string[] },
): Promise<TranscriptVerdict> {
  const messages = buildTranscriptCheckMessages(input)
  let lastError = ''
  for (let attempt = 1; attempt <= STT_JUDGE_ATTEMPTS; attempt++) {
    const response = await chat({
      userId: input.userId,
      messages,
      temperature: 0,
      logContext: STT_JUDGE_LOG_CONTEXT,
      responseFormat: 'json_object',
    })
    try {
      return parseTranscriptVerdict(response)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.warn('[stt-judge] attempt failed', { attempt, error: lastError.slice(0, 200) })
    }
  }
  throw new Error(`transcript check failed ${STT_JUDGE_ATTEMPTS} times: ${lastError}`)
}
