import type { WebsiteContentKind, WebsiteVisibility } from './store'
import { z } from 'zod'
import type { DecideOptions, DecisionResult } from '$lib/server/decisions/decide'
import { KernelError } from '$lib/kernel/errors'
import { isLlmHttpError, isLlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import { websitePageAudience } from './decision-kinds'

/**
 * Public website content or an internal document? (Contribute: internal
 * documents — pitch decks, project descriptions, funding documents — are
 * never created as website pages; they belong in Drive (Markdown) or
 * Memory › Documents.) The model judges, never keywords (AGENTS.md: LLM + JSON
 * schema): one call through the gateway, on the company's AI provider, cost
 * tracked (`website_page_audience`). Post-LLM code only validates the JSON
 * against the schema. A failure fails loud — never a guessed verdict.
 */

export const AUDIENCE_LOG_CONTEXT = 'website_page_audience'
export const AUDIENCE_MAX_ATTEMPTS = 3
/** The body the judge reads is bounded (a page can be long; the start says what it is). */
export const AUDIENCE_MAX_BODY_CHARS = 12_000

export type PageDraft = {
  slug: string
  title: string
  body: string
  kind: WebsiteContentKind
  visibility: WebsiteVisibility
}

export type PageAudience = {
  audience: 'public_website' | 'internal_document'
  reason: string
}

export type AudienceChat = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  logContext?: string
  responseFormat?: 'json_object'
}) => Promise<unknown>

export type PageAudienceClassifier = (input: { userId: string; page: PageDraft }) => Promise<PageAudience>

/** The answer's JSON Schema — stated to the model verbatim; the zod schema below enforces it. */
export const AUDIENCE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['audience', 'reason'],
  properties: {
    audience: { type: 'string', enum: ['public_website', 'internal_document'] },
    reason: { type: 'string', minLength: 1, maxLength: 300 },
  },
} as const

const outputSchema = z
  .object({
    audience: z.enum(['public_website', 'internal_document']),
    reason: z.string().trim().min(1).max(300),
  })
  .strict()

export const NO_PROVIDER_MESSAGE =
  'The company has no AI provider set up yet, so the website can’t check that this is public website content; nothing was changed. The owner sets one up under Settings → AI provider.'

export function buildAudienceMessages(page: PageDraft): ChatMessage[] {
  const system = [
    'You check content an AI assistant is about to put on a company’s website. The website is the company’s PUBLIC site: everything on it is meant for visitors — customers, prospects, the press, applicants. A private website page is only an unpublished draft of such a public page.',
    'Internal documents never belong on the website, not even as a private page: pitch decks, investor or funding documents (fundraising, grants, cap tables, financials), project descriptions and briefs, plans and roadmaps, meeting notes, strategy, internal processes and handbooks, drafts of anything for internal use. Those are saved in Drive (Markdown) or in Memory › Documents instead.',
    'Judge what the content is FOR and WHO it addresses: public website content (e.g. home, about, product, pricing, careers, blog post, public docs or FAQ for customers, contact, legal pages), or an internal document.',
    'Return JSON only, exactly this JSON Schema:',
    JSON.stringify(AUDIENCE_JSON_SCHEMA),
    'Rules:',
    '- audience: "public_website" or "internal_document".',
    '- reason: one short, plain sentence in English saying why, from what you can see in the content.',
    '- When the content is meant for the company’s own people or for investors/funders rather than for the public, answer "internal_document".',
  ].join('\n')

  const body =
    page.body.length > AUDIENCE_MAX_BODY_CHARS
      ? `${page.body.slice(0, AUDIENCE_MAX_BODY_CHARS)}\n…(truncated)`
      : page.body
  const user = [
    'Content to check (JSON):',
    JSON.stringify({ slug: page.slug, title: page.title, kind: page.kind, visibility: page.visibility, body }, null, 1),
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** Validates the model's JSON against the schema; the reason becomes one line. Throws on anything else. */
export function parseAudienceOutput(response: unknown): PageAudience {
  const parsed = outputSchema.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) {
    throw new Error(`Audience output failed the schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  }
  return { audience: parsed.data.audience, reason: parsed.data.reason.replace(/\s+/g, ' ') }
}

/** A gateway failure as a plain error; anything that isn't one stays a real failure. */
function gatewayError(err: unknown): unknown {
  if (isLlmNotConfiguredError(err)) return new KernelError('not_configured', NO_PROVIDER_MESSAGE)
  if (isLlmHttpError(err)) {
    const status = (err as { status?: number }).status
    return new Error(
      `The company’s AI provider refused the website content check (HTTP ${status}); nothing was changed. Try again later.`,
      { cause: err },
    )
  }
  return err
}

/**
 * Exactly AUDIENCE_MAX_ATTEMPTS tries at a readable answer, then a plain
 * error. A missing provider or a refusal is not retried.
 */
export function createPageAudienceClassifier(deps: { chat: AudienceChat }): PageAudienceClassifier {
  return async ({ userId, page }) => {
    const messages = buildAudienceMessages(page)
    let lastError = ''
    for (let attempt = 1; attempt <= AUDIENCE_MAX_ATTEMPTS; attempt++) {
      let response: unknown
      try {
        response = await deps.chat({
          userId,
          messages,
          temperature: 0,
          logContext: AUDIENCE_LOG_CONTEXT,
          responseFormat: 'json_object',
        })
      } catch (err) {
        throw gatewayError(err)
      }
      try {
        return parseAudienceOutput(response)
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        console.warn('[website.page_audience] attempt failed', { attempt, error: lastError.slice(0, 200) })
      }
    }
    throw new Error(
      `The website content check’s answer could not be read (${AUDIENCE_MAX_ATTEMPTS} tries: ${lastError}); nothing was changed. Try again.`,
    )
  }
}

/** decide() for the page-audience kind (live: $lib/server/decisions/decide, loaded on first use). */
export type AudienceDecide = (
  kind: typeof websitePageAudience,
  input: PageDraft,
  opts: DecideOptions<PageAudience['audience']>,
) => Promise<DecisionResult<PageAudience['audience']>>

export const liveAudienceDecide: AudienceDecide = async (kind, input, opts) =>
  (await import('$lib/server/decisions/decide')).decide(kind, input, opts)

/**
 * The guard's classifier with the decision kind `website.page_audience` (CB2) around it.
 * Shadow (today): the chat judge's verdict is what the guard acts on — its reason is the one
 * the refusal names — and Jev's answer is logged next to it. Enforced (only after the log was
 * reviewed and the kind's status changed in code): Jev's choice is used and the reason is the
 * criterion of the chosen answer (Jev decides; it writes no reason).
 */
export function shadowedAudienceClassifier(
  classify: PageAudienceClassifier,
  decideAudience: AudienceDecide = liveAudienceDecide,
): PageAudienceClassifier {
  return async (input) => {
    let verdict: PageAudience | null = null
    const result = await decideAudience(websitePageAudience, input.page, {
      requestedBy: input.userId,
      judge: {
        current: async () => {
          verdict = await classify(input)
          return verdict.audience
        },
      },
    })
    if (result.outcome !== 'decided') {
      throw new Error(`website.page_audience gave no decision (${result.outcome}); nothing was changed.`)
    }
    if (result.source === 'current_judge' && verdict) return verdict
    return { audience: result.choice, reason: websitePageAudience.criteria[result.choice] }
  }
}

/** The live gateway call: on the company's AI provider (the owner's), attributed to whoever asked. */
export const liveAudienceChat: AudienceChat = async (input) => {
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  const { onCompanyProvider } = await import('$lib/server/llm/company-provider')
  return onCompanyProvider(() => llmChatCompletion(input))
}
