import { z } from 'zod'
import type { AiTaskId } from '$lib/ai-usage/tasks'
import { isLlmHttpError, isLlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import { resolveBrandVoice, type BrandVoice, type VoiceSource } from '../voice'
import { MATERIAL_FORMAT_IDS, formatById, sizeLabel, type MaterialFormat } from './formats'
import { MATERIAL_COPY_LIMITS, MaterialError, type MaterialCopy } from './types'

/**
 * "Write the texts" for brand material (Contribute 288dc1d2): three variants
 * of the piece's copy — headline, text and button; a slogan for merch — in
 * the company's brand voice (the active guideline set's context, examples,
 * lexicon and glossary), sized for the format. Writing is the model's work:
 * one call through the gateway on the company's AI provider, cost tracked
 * (`brand_material_texts`). Post-LLM code only validates the JSON — three
 * variants, the fields the format carries, within the copy limits. Nothing
 * is saved: the person picks a variant and edits it before exporting.
 */

export const MATERIAL_TEXT_MAX_ATTEMPTS = 3
export const MATERIAL_TEXT_VARIANTS = 3

export const MATERIAL_NO_PROVIDER_MESSAGE =
  'The company has no AI provider set up yet, so texts can’t be written. The owner sets one up under Settings → AI provider.'

export type MaterialChat = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  task: AiTaskId
  responseFormat?: 'json_object'
}) => Promise<unknown>

export type MaterialTextSuggestions = {
  formatId: string
  /** The brand voice's locale the texts were written in; null without an active voice. */
  locale: string | null
  /** Whether an active brand voice shaped the texts. */
  voice: boolean
  variants: MaterialCopy[]
}

const PURPOSE: Record<MaterialFormat['kind'], string> = {
  flyer: 'a digital / printed flyer: a strong headline, one or two sentences of text and a short call to action',
  banner: 'a banner: a short headline readable at a distance, one sentence of text and a short call to action',
  poster: 'a trade-fair poster: a big headline readable from across the hall, one or two sentences and a short call to action',
  merch: 'merchandise (T-shirt, mug, bag): one short, memorable slogan only — no text, no call to action',
}

export function buildMaterialTextMessages(format: MaterialFormat, voice: BrandVoice | null, brief: string | undefined): ChatMessage[] {
  const merch = format.kind === 'merch'
  const one = merch ? '{ "headline": "<slogan>" }' : '{ "headline": "…", "body": "…", "cta": "…" }'
  const system = [
    'You write the copy for a company’s brand material, in its brand voice.',
    `The piece is ${PURPOSE[format.kind]}. Format: ${format.label}, ${sizeLabel(format)}.`,
    `Write exactly ${MATERIAL_TEXT_VARIANTS} clearly different variants. Return JSON only, exactly this schema:`,
    `{ "variants": [${one}, ${one}, ${one}] }`,
    merch
      ? `Limits (characters, hard): slogan (the "headline" field) at most ${MATERIAL_COPY_LIMITS.slogan}.`
      : `Limits (characters, hard): headline at most ${MATERIAL_COPY_LIMITS.headline}, body at most ${MATERIAL_COPY_LIMITS.body}, cta at most ${MATERIAL_COPY_LIMITS.cta}.`,
    voice
      ? `Write in the brand voice below, in the language of its locale (${voice.locale}). Follow the good examples, avoid what the bad ones do, never use banned terms (use the replacement), use required terms, and use glossary terms as defined.`
      : 'No brand voice is set up: write plain, clear and friendly copy in the language of the person’s request (English when there is none).',
    'Never invent facts, dates, prices, places or claims that are not in the request. Do not add placeholder text in brackets.',
  ].join('\n')
  const user = JSON.stringify(
    {
      piece: { kind: format.kind, format: format.label, size: sizeLabel(format) },
      ...(brief ? { request_from_the_person: brief } : {}),
      brand_voice: voice
        ? { locale: voice.locale, context: voice.context, voice_examples: voice.examples, lexicon: voice.lexicon, glossary: voice.glossary }
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

/** Validates the model's JSON: three variants with exactly the fields the format carries, within the limits. */
export function parseMaterialTextOutput(response: unknown, format: MaterialFormat): MaterialCopy[] {
  const text = (max: number) => z.string().trim().min(1).max(max)
  const variant =
    format.kind === 'merch'
      ? z.object({ headline: text(MATERIAL_COPY_LIMITS.slogan) }).strict()
      : z
          .object({ headline: text(MATERIAL_COPY_LIMITS.headline), body: text(MATERIAL_COPY_LIMITS.body), cta: text(MATERIAL_COPY_LIMITS.cta) })
          .strict()
  const parsed = z
    .object({ variants: z.array(variant).length(MATERIAL_TEXT_VARIANTS) })
    .strict()
    .safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`Material text output failed the schema at ${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'}`)
  }
  return parsed.data.variants
}

function gatewayError(err: unknown): unknown {
  if (isLlmNotConfiguredError(err)) return new MaterialError('unavailable', MATERIAL_NO_PROVIDER_MESSAGE, { cause: err })
  if (isLlmHttpError(err)) {
    return new MaterialError('upstream', `The company’s AI provider refused the request (HTTP ${err.status}); try again later.`, { cause: err })
  }
  return err
}

export async function suggestMaterialTexts(
  deps: { brand: VoiceSource; chat: MaterialChat },
  input: { formatId: string; userId: string; locale?: string; brief?: string },
): Promise<MaterialTextSuggestions> {
  if (!MATERIAL_FORMAT_IDS.includes(input.formatId)) throw new MaterialError('invalid', `No material format ${input.formatId}.`)
  const format = formatById(input.formatId)
  const voice = await resolveBrandVoice(deps.brand, input.locale, (message) => new MaterialError('invalid', message), 'texts')
  const messages = buildMaterialTextMessages(format, voice, input.brief?.trim() || undefined)
  let lastError = ''
  for (let attempt = 1; attempt <= MATERIAL_TEXT_MAX_ATTEMPTS; attempt++) {
    let response: unknown
    try {
      response = await deps.chat({ userId: input.userId, messages, temperature: 0.7, task: 'branding.material_texts', responseFormat: 'json_object' })
    } catch (err) {
      throw gatewayError(err)
    }
    try {
      return { formatId: format.id, locale: voice?.locale ?? null, voice: voice !== null, variants: parseMaterialTextOutput(response, format) }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.warn('[brand.material_text_suggest] attempt failed', { attempt, error: lastError.slice(0, 200) })
    }
  }
  throw new MaterialError('upstream', `The AI’s texts couldn’t be read (${MATERIAL_TEXT_MAX_ATTEMPTS} tries: ${lastError}). Try again.`)
}

/** The live gateway call: on the company's AI provider, attributed to whoever asked. */
export const liveMaterialChat: MaterialChat = async (input) => {
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  const { onCompanyProvider } = await import('$lib/server/llm/company-provider')
  return onCompanyProvider(() => llmChatCompletion(input))
}
