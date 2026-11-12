import { z } from 'zod'
import { isLlmHttpError, isLlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import { ContactsError } from './errors'
import { normaliseTag } from './service'
import { CHANNEL_TYPES, CONTACT_LIMITS, DESCRIBE_TEXT_MAX, type ContactDraft, type LogDraft } from './types'

/**
 * "Tell me about them" (contribute round 4, W5): a person says freely who
 * someone is — typed or dictated — and the AI picks out the contact's fields
 * (AGENTS.md: LLM + JSON schema). One gateway call on the company's AI
 * provider, cost tracked (`contacts_extract`). Post-LLM code only validates:
 * the JSON against the schema, tags against the tags the form offers, days as
 * real days. An unreadable answer is retried, then fails loud — never a
 * guessed field. Nothing is saved here: the draft prefills the form and the
 * person reviews it and presses Save.
 */

export const EXTRACT_MAX_ATTEMPTS = 3
export const EXTRACT_LOG_CONTEXT = 'contacts_extract'

export type ExtractChat = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  logContext?: string
  responseFormat?: 'json_object'
}) => Promise<unknown>

export const NO_PROVIDER_MESSAGE =
  'The company has no AI provider set up yet, so Contacts can’t read what you said. Fill in the form instead — or the owner sets one up under Settings → AI provider.'

// ── the schema ────────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/
const isDay = (v: string) => DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v

/** Free text the model found, or null; an empty string means "not said" too. */
const said = (max: number) =>
  z
    .string()
    .nullable()
    .transform((v) => (v === null || v.trim() === '' ? null : v.trim()))
    .refine((v) => v === null || v.length <= max, `at most ${max} characters`)

const day = z
  .string()
  .nullable()
  .transform((v) => (v === null || v.trim() === '' ? null : v.trim()))
  .refine((v) => v === null || isDay(v), 'a day as YYYY-MM-DD')

const contactSchema = z
  .object({
    name: said(CONTACT_LIMITS.name),
    organisation: said(CONTACT_LIMITS.organisation),
    title: said(CONTACT_LIMITS.title),
    channels: z
      .array(
        z
          .object({
            type: z.enum(CHANNEL_TYPES),
            value: z.string().trim().min(1).max(CONTACT_LIMITS.channelValue),
          })
          .strict(),
      )
      .max(CONTACT_LIMITS.channels),
    met_how: said(CONTACT_LIMITS.metHow),
    why_relevant: said(CONTACT_LIMITS.whyRelevant),
    tags: z.array(z.string()).max(CONTACT_LIMITS.tags),
    last_contacted_on: day,
    next_follow_up_on: day,
    next_step: said(CONTACT_LIMITS.nextStep),
  })
  .strict()

const logSchema = z
  .object({
    in_touch_on: day,
    next_follow_up_on: day,
    next_step: said(CONTACT_LIMITS.nextStep),
  })
  .strict()

const CONTACT_JSON_SCHEMA = `{
  "name": "<their full name>" | null,
  "organisation": "<where they work or what they belong to>" | null,
  "title": "<their role or job title>" | null,
  "channels": [ { "type": one of ${CHANNEL_TYPES.map((t) => `"${t}"`).join(' | ')}, "value": "<the address, number or link exactly as said>" } ],
  "met_how": "<where or how you met>" | null,
  "why_relevant": "<why they matter to the company, what they do that is interesting for us>" | null,
  "tags": [ "<only tags from the offered list>" ],
  "last_contacted_on": "YYYY-MM-DD" | null,
  "next_follow_up_on": "YYYY-MM-DD" | null,
  "next_step": "<the next thing to do with them, short>" | null
}`

const LOG_JSON_SCHEMA = `{
  "in_touch_on": "YYYY-MM-DD" | null,
  "next_follow_up_on": "YYYY-MM-DD" | null,
  "next_step": "<the next thing to do with them, short>" | null
}`

const SHARED_RULES = [
  '- Use only what the person said. A field they did not mention is null (a list is empty). Never guess or invent a value.',
  '- Keep the person’s own language and wording for free text; tidy it into short, plain phrases.',
  '- Resolve relative days ("yesterday", "next Thursday", "in two weeks") against Today. Days are YYYY-MM-DD.',
]

// ── prompts ───────────────────────────────────────────────────────────────────

export function buildContactExtractMessages(input: { text: string; today: string; tags: readonly string[] }): ChatMessage[] {
  const system = [
    'You fill in a contact card from what a person at a company said about someone they know: who the person is, what they do, why they are interesting for the company, how they met, how to keep in touch, and what comes next.',
    'Return JSON only, exactly this schema:',
    CONTACT_JSON_SCHEMA,
    'Rules:',
    ...SHARED_RULES,
    `- channels: every way to reach them that was said (email addresses, phone numbers, LinkedIn profiles, websites; anything else as "other"). Channel types: ${CHANNEL_TYPES.join(', ')}.`,
    '- tags: the offered tags that fit why this person matters (their relationship to the company). Only tags from the offered list, spelled as offered; none fitting is [].',
    '- last_contacted_on: the day they were last in touch, if said (never after Today). next_follow_up_on and next_step: when and what to do next, if said.',
  ].join('\n')
  const user = [
    `Today: ${input.today}`,
    `Offered tags (JSON): ${JSON.stringify(input.tags)}`,
    'What the person said (JSON string):',
    JSON.stringify(input.text),
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export function buildLogExtractMessages(input: { text: string; today: string }): ChatMessage[] {
  const system = [
    'A person at a company was in touch with someone they know and says, in their own words, when that was and what comes next.',
    'Return JSON only, exactly this schema:',
    LOG_JSON_SCHEMA,
    'Rules:',
    ...SHARED_RULES,
    '- in_touch_on: the day they were in touch (never after Today); null if not said. next_follow_up_on and next_step: when and what to do next, if said.',
  ].join('\n')
  const user = [`Today: ${input.today}`, 'What the person said (JSON string):', JSON.stringify(input.text)].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

// ── validation ────────────────────────────────────────────────────────────────

function readJson<T>(response: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`Contact reading failed the schema: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid'}`)
  }
  return parsed.data
}

function notAfterToday(value: string | null, today: string, field: string): void {
  if (value !== null && value > today) throw new Error(`${field} ${value} is after today (${today})`)
}

/** Validates the model's JSON against the schema, the offered tags and today. Throws on anything else. */
export function parseContactExtractOutput(response: unknown, ctx: { tags: readonly string[]; today: string }): ContactDraft {
  const out = readJson(response, contactSchema)
  const offered = new Set(ctx.tags.map(normaliseTag))
  const tags = [...new Set(out.tags.map(normaliseTag))]
  for (const tag of tags) if (!offered.has(tag)) throw new Error(`Tag "${tag}" is not one the form offers`)
  notAfterToday(out.last_contacted_on, ctx.today, 'last_contacted_on')
  return {
    name: out.name,
    organisation: out.organisation,
    title: out.title,
    channels: out.channels,
    metHow: out.met_how,
    whyRelevant: out.why_relevant,
    tags,
    lastContactedOn: out.last_contacted_on,
    nextFollowUpOn: out.next_follow_up_on,
    nextStep: out.next_step,
  }
}

export function parseLogExtractOutput(response: unknown, ctx: { today: string }): LogDraft {
  const out = readJson(response, logSchema)
  notAfterToday(out.in_touch_on, ctx.today, 'in_touch_on')
  return { on: out.in_touch_on, nextFollowUpOn: out.next_follow_up_on, nextStep: out.next_step }
}

// ── the call ──────────────────────────────────────────────────────────────────

function describedText(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ContactsError('invalid', 'Say or type something about them first.')
  const text = value.trim()
  if (text.length > DESCRIBE_TEXT_MAX) {
    throw new ContactsError('invalid', `That’s more than ${DESCRIBE_TEXT_MAX} characters — keep it to this one person.`)
  }
  return text
}

/** A gateway failure as a plain Contacts error; anything that isn't one stays a real failure. */
function gatewayError(err: unknown): unknown {
  if (isLlmNotConfiguredError(err)) return new ContactsError('unavailable', NO_PROVIDER_MESSAGE, { cause: err })
  if (isLlmHttpError(err)) {
    return new ContactsError('upstream', `The company’s AI provider refused the request (HTTP ${err.status}); try again later.`, {
      cause: err,
    })
  }
  return err
}

/**
 * Exactly EXTRACT_MAX_ATTEMPTS tries at a readable answer, then a plain error.
 * A missing provider or a refusal is not retried (the gateway retries
 * transport failures itself).
 */
async function ask<T>(chat: ExtractChat, userId: string, messages: ChatMessage[], parse: (response: unknown) => T): Promise<T> {
  let lastError = ''
  for (let attempt = 1; attempt <= EXTRACT_MAX_ATTEMPTS; attempt++) {
    let response: unknown
    try {
      response = await chat({ userId, messages, temperature: 0, logContext: EXTRACT_LOG_CONTEXT, responseFormat: 'json_object' })
    } catch (err) {
      throw gatewayError(err)
    }
    try {
      return parse(response)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.warn('[contacts.extract] attempt failed', { attempt, error: lastError.slice(0, 200) })
    }
  }
  throw new ContactsError(
    'upstream',
    `The AI’s answer couldn’t be read (${EXTRACT_MAX_ATTEMPTS} tries: ${lastError}). Try again, or fill in the form yourself.`,
  )
}

/** The contact form's prefill from a free description. */
export async function extractContactDraft(
  chat: ExtractChat,
  input: { userId: string; text: unknown; today: string; tags: readonly string[] },
): Promise<ContactDraft> {
  const text = describedText(input.text)
  const messages = buildContactExtractMessages({ text, today: input.today, tags: input.tags })
  return ask(chat, input.userId, messages, (r) => parseContactExtractOutput(r, input))
}

/** "Log a contact"'s prefill from a free description. */
export async function extractLogDraft(chat: ExtractChat, input: { userId: string; text: unknown; today: string }): Promise<LogDraft> {
  const text = describedText(input.text)
  return ask(chat, input.userId, buildLogExtractMessages({ text, today: input.today }), (r) => parseLogExtractOutput(r, input))
}

/** The live gateway call: on the company's AI provider (the owner's), attributed to whoever asked. */
export const liveExtractChat: ExtractChat = async (input) => {
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  const { onCompanyProvider } = await import('$lib/server/llm/company-provider')
  return onCompanyProvider(() => llmChatCompletion(input))
}
