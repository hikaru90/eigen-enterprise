import { z } from 'zod'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import type { JudgeChat } from '../judge'

/**
 * The scrub (plan/contribute-phone-home.md §4.2): one gateway call on the
 * company's AI provider rewrites a proposal's title as a short English product
 * request without people, contacts, the company, places, URLs, IDs, secrets,
 * remarks or moods. Post-LLM code checks the schema and the length, nothing
 * else (no regex second opinion on meaning). 3 bad answers → ScrubFailedError;
 * the raw title is never a substitute.
 */

export const SCRUB_MAX_ATTEMPTS = 3
export const SCRUB_LOG_CONTEXT = 'contribute_scrub'
export const SCRUB_SUMMARY_MAX = 500

export const SCRUB_REMOVED_KINDS = ['person', 'contact', 'company', 'location', 'credential', 'url', 'other'] as const

const outputSchema = z
  .object({
    summary: z.string().trim().min(1).max(SCRUB_SUMMARY_MAX),
    language: z.string().trim().min(2).max(35),
    removed: z.array(z.enum(SCRUB_REMOVED_KINDS)),
  })
  .strict()

export type ScrubResult = z.infer<typeof outputSchema>

/** The scrub gave no valid answer in 3 attempts: nothing is sent for this proposal. */
export class ScrubFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScrubFailedError'
  }
}

const JSON_SCHEMA = `{ "summary": "<the request in English, at most ${SCRUB_SUMMARY_MAX} characters>", "language": "<BCP-47 tag of the original's language, e.g. de, en, fr>", "removed": [ ${SCRUB_REMOVED_KINDS.map((k) => `"${k}"`).join(' | ')} ] }`

export function buildScrubMessages(title: string): ChatMessage[] {
  const system = [
    'You prepare a proposal someone made inside their company app (eigenEnterprise) for the app makers, who must not learn anything about the person or the company.',
    'Restate the proposal in English as a short product request: what the app should do or fix, and where in the app.',
    'Leave out: names of people, emails, phone numbers, the company or its customers and products, domains, URLs and hostnames, IDs and numbers that identify something, passwords, keys and tokens, places, and personal remarks or moods.',
    'Never add content that is not in the proposal. If almost nothing is left, say only what the app should do.',
    'removed lists the kinds of things you left out (empty when nothing was left out).',
    'Return JSON only, exactly this schema:',
    JSON_SCHEMA,
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Proposal:\n${JSON.stringify(title)}` },
  ]
}

/** Validate the scrub's JSON. Throws on anything else. */
export function parseScrubOutput(response: unknown): ScrubResult {
  const parsed = outputSchema.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) throw new Error(`Scrub output failed the schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  let language: string
  try {
    ;[language] = Intl.getCanonicalLocales(parsed.data.language)
  } catch {
    throw new Error(`Scrub language "${parsed.data.language}" is not a BCP-47 tag`)
  }
  return { ...parsed.data, language }
}

/**
 * Exactly 3 attempts on a bad answer, then ScrubFailedError. The gateway's
 * own errors (no provider, no credits, transport) are not retried here: they
 * surface as is and the worker decides.
 */
export async function scrubTitle(chat: JudgeChat, input: { userId: string; title: string }): Promise<ScrubResult> {
  const messages = buildScrubMessages(input.title)
  let lastError = ''
  for (let attempt = 1; attempt <= SCRUB_MAX_ATTEMPTS; attempt++) {
    const response = await chat({ userId: input.userId, messages, temperature: 0, logContext: SCRUB_LOG_CONTEXT, responseFormat: 'json_object' })
    try {
      return parseScrubOutput(response)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.warn('[contribute.scrub] attempt failed', { attempt, error: lastError.slice(0, 200) })
    }
  }
  throw new ScrubFailedError(`The scrub gave no valid answer in ${SCRUB_MAX_ATTEMPTS} attempts: ${lastError}`)
}
