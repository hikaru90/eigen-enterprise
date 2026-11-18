import type { BrandStore } from '../store'
import type { SocialPostStore } from './store'
import { z } from 'zod'
import { isLlmHttpError, isLlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import { NETWORK_CAPTION_LIMITS, SOCIAL_NETWORK_LABELS, SocialPostError, socialFormat, type SocialNetwork, type SocialPost } from './types'

/**
 * "Suggest captions" (Contribute 6ff283ef): three caption variants per target
 * network, written in the company's brand voice — the active guideline set's
 * context, its good/bad voice examples, lexicon and glossary. Writing is the
 * model's work (AGENTS.md: LLM + JSON schema): one call through the gateway on
 * the company's AI provider, cost tracked (`brand_social_captions`). Post-LLM
 * code only validates the JSON — the asked networks, three non-empty variants
 * each, within the network's length limit. Nothing is saved: the person picks
 * and edits a variant.
 */

export const CAPTION_LOG_CONTEXT = 'brand_social_captions'
export const CAPTION_MAX_ATTEMPTS = 3
export const CAPTION_VARIANTS = 3

export { NETWORK_CAPTION_LIMITS }

export const NO_PROVIDER_MESSAGE =
  'The company has no AI provider set up yet, so captions can’t be suggested. The owner sets one up under Settings → AI provider.'

export type CaptionChat = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  logContext?: string
  responseFormat?: 'json_object'
}) => Promise<unknown>

export type VoiceSource = Pick<BrandStore, 'listSets' | 'listVoiceExamples' | 'listLexicon' | 'listGlossary'>

export type CaptionSuggestions = {
  postId: string
  /** The brand voice's locale the captions were written in; null without an active voice. */
  locale: string | null
  /** Whether an active brand voice shaped the captions. */
  voice: boolean
  captions: Partial<Record<SocialNetwork, string[]>>
}

type Voice = {
  locale: string
  context: Record<string, unknown>
  examples: Array<{ label: 'good' | 'bad'; body: string; contentType: string; rationale: string | null }>
  lexicon: Array<{ term: string; kind: string; replacement: string | null }>
  glossary: Array<{ term: string; definition: string; usageNote: string | null }>
}

/** The active voice to write in: the asked locale, else the only active one. Several without a locale fail loud. */
async function resolveVoice(brand: VoiceSource, locale: string | undefined): Promise<Voice | null> {
  const active = await brand.listSets({ status: 'active', ...(locale === undefined ? {} : { locale }) })
  if (locale !== undefined && active.length === 0) {
    throw new SocialPostError('invalid', `No brand voice is active for ${locale}.`)
  }
  if (active.length === 0) return null
  if (active.length > 1) {
    const locales = active.map((s) => s.locale).sort()
    throw new SocialPostError('invalid', `Several brand voices are active (${locales.join(', ')}): say which language the captions are for.`)
  }
  const set = active[0]
  const [examples, lexicon, glossary] = await Promise.all([
    brand.listVoiceExamples(set.id),
    brand.listLexicon(set.id),
    brand.listGlossary(set.id),
  ])
  return {
    locale: set.locale,
    context: set.context as Record<string, unknown>,
    examples: examples.map((e) => ({ label: e.label, body: e.body, contentType: e.contentType, rationale: e.rationale })),
    lexicon: lexicon.map((l) => ({ term: l.term, kind: l.kind, replacement: l.replacement })),
    glossary: glossary.map((g) => ({ term: g.term, definition: g.definition, usageNote: g.usageNote })),
  }
}

function describePost(post: SocialPost) {
  if (post.source === 'graphic' && post.graphic && post.format) {
    const f = socialFormat(post.format)
    return { kind: `branded graphic, ${f.label} (${f.ratio})`, copy_on_the_graphic: post.graphic }
  }
  const videos = post.media.filter((m) => m.mime.startsWith('video/')).length
  const kind = videos > 0 ? 'video' : post.media.length > 1 ? `carousel of ${post.media.length} images` : 'single image'
  return { kind, files: post.media.map((m) => m.name) }
}

export function buildCaptionMessages(
  post: SocialPost,
  networks: readonly SocialNetwork[],
  voice: Voice | null,
  brief: string | undefined,
): ChatMessage[] {
  const schema = `{ "captions": { ${networks.map((n) => `"${n}": ["<variant 1>", "<variant 2>", "<variant 3>"]`).join(', ')} } }`
  const system = [
    'You write social media captions for a company, in its brand voice.',
    `For each network below write exactly ${CAPTION_VARIANTS} different caption variants that fit the network's conventions (tone, length, hashtags, line breaks, call to action).`,
    'Return JSON only, exactly this schema:',
    schema,
    'Network limits (characters, hard):',
    ...networks.map((n) => `- "${n}" (${SOCIAL_NETWORK_LABELS[n]}): at most ${NETWORK_CAPTION_LIMITS[n]}`),
    voice
      ? `Write in the brand voice below, in the language of its locale (${voice.locale}). Follow the good examples, avoid what the bad ones do, never use banned terms (use the replacement), use required terms, and use glossary terms as defined.`
      : 'No brand voice is set up: write plain, clear and friendly captions in the language of the post copy.',
    'Never invent facts, dates, prices or claims that are not in the post. Do not add placeholder text in brackets.',
  ].join('\n')
  const user = JSON.stringify(
    {
      post: { title: post.title, ...describePost(post), existing_captions: post.captions },
      ...(brief ? { request_from_the_person: brief } : {}),
      brand_voice: voice
        ? {
            locale: voice.locale,
            context: voice.context,
            voice_examples: voice.examples,
            lexicon: voice.lexicon,
            glossary: voice.glossary,
          }
        : null,
    },
    null,
    1,
  )
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** Validates the model's JSON: exactly the asked networks, three non-empty variants each within the network's limit. */
export function parseCaptionOutput(response: unknown, networks: readonly SocialNetwork[]): Partial<Record<SocialNetwork, string[]>> {
  const shape = z
    .object({
      captions: z
        .object(
          Object.fromEntries(
            networks.map((n) => [n, z.array(z.string().trim().min(1).max(NETWORK_CAPTION_LIMITS[n])).length(CAPTION_VARIANTS)]),
          ),
        )
        .strict(),
    })
    .strict()
  const parsed = shape.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`Caption output failed the schema at ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`)
  }
  const out: Partial<Record<SocialNetwork, string[]>> = {}
  for (const n of networks) out[n] = (parsed.data.captions as Record<string, string[]>)[n].map((c) => c.trim())
  return out
}

function gatewayError(err: unknown): unknown {
  if (isLlmNotConfiguredError(err)) return new SocialPostError('unavailable', NO_PROVIDER_MESSAGE, { cause: err })
  if (isLlmHttpError(err)) {
    return new SocialPostError('upstream', `The company’s AI provider refused the request (HTTP ${err.status}); try again later.`, { cause: err })
  }
  return err
}

export async function suggestCaptions(
  deps: { posts: SocialPostStore; brand: VoiceSource; chat: CaptionChat },
  input: { postId: string; userId: string; networks?: SocialNetwork[]; locale?: string; brief?: string },
): Promise<CaptionSuggestions> {
  const post = await deps.posts.get(input.postId)
  if (!post) throw new SocialPostError('not_found', `No social post ${input.postId}.`)
  const networks = input.networks?.length ? [...new Set(input.networks)] : post.networks
  const stray = networks.filter((n) => !post.networks.includes(n))
  if (stray.length) throw new SocialPostError('invalid', `The post does not target: ${stray.join(', ')}.`)

  const voice = await resolveVoice(deps.brand, input.locale)
  const messages = buildCaptionMessages(post, networks, voice, input.brief?.trim() || undefined)
  let lastError = ''
  for (let attempt = 1; attempt <= CAPTION_MAX_ATTEMPTS; attempt++) {
    let response: unknown
    try {
      response = await deps.chat({ userId: input.userId, messages, temperature: 0.7, logContext: CAPTION_LOG_CONTEXT, responseFormat: 'json_object' })
    } catch (err) {
      throw gatewayError(err)
    }
    try {
      return { postId: post.id, locale: voice?.locale ?? null, voice: voice !== null, captions: parseCaptionOutput(response, networks) }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.warn('[brand.social_caption_suggest] attempt failed', { attempt, error: lastError.slice(0, 200) })
    }
  }
  throw new SocialPostError('upstream', `The AI’s captions couldn’t be read (${CAPTION_MAX_ATTEMPTS} tries: ${lastError}). Try again.`)
}

/** The live gateway call: on the company's AI provider, attributed to whoever asked. */
export const liveCaptionChat: CaptionChat = async (input) => {
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  const { onCompanyProvider } = await import('$lib/server/llm/company-provider')
  return onCompanyProvider(() => llmChatCompletion(input))
}
