import type { GuideMime } from './guide'
import { env as privateEnv } from '$lib/server/env/private-env'
import type { ChatAttachment, ChatMessage } from '$lib/server/llm/llm-client'
import { expandSeeds } from '../style-format/expand'
import { brandSeedsSchema, SEED_SHAPE_DESCRIPTION, type BrandSeeds } from '../style-format/seeds'

/**
 * The extraction proposer (phase-2d M2): three gateway calls per round — one
 * per lens, pinned temperature ladder 0.4/0.7/1.0 — each returning a seed
 * block via json_object mode. Post-LLM code parses + zod-validates + expands
 * only; semantics live entirely in the prompts (G14). The transport is
 * injectable so unit tests never hit the network.
 *
 * Two sources, one output: a site capture's computed-style digest (text), or an
 * uploaded brand guide (PDF/image, sent to the model as a gateway attachment).
 * Both return the same seed block, validated and expanded the same way.
 */

export type ChatCompletionFn = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  logContext?: string
  responseFormat?: 'json_object'
  modelOverride?: string
  aiSessionId?: string
}) => Promise<unknown>

export const CANDIDATE_LABELS = ['Color-led', 'Type-led', 'Structure-led'] as const
const TEMPERATURES = [0.4, 0.7, 1.0]

const LENSES: Record<(typeof CANDIDATE_LABELS)[number], string> = {
  'Color-led':
    'Lens: COLOR. Lead from the color evidence — extract the dominant brand hue as seedColor, match neutralTintHue to the neutral grays, and choose chromaCurve from how saturated the observed palette is.',
  'Type-led':
    'Lens: TYPOGRAPHY. Lead from the type evidence — derive baseSize, scaleRatio and scaleSteps from the observed font-size ladder, pick OFL families close to the observed letterforms, and set trackingCurve from the observed letter-spacing direction.',
  'Structure-led':
    'Lens: SPACE + SHAPE. Lead from layout evidence — derive spaceRhythm from the observed spacing set, shapeCharacter + radiusBase from the observed radii, and elevation/motionPersonality from the observed shadows and overall density.',
}

export type PriorRound = {
  round: number
  verdict: { chosen: number | null; note?: string | null }
  candidateLabels: string[]
}

export type ProposedCandidate =
  | {
      label: (typeof CANDIDATE_LABELS)[number]
      seeds: BrandSeeds
      cssVars: Record<string, string>
      darkCssVars: Record<string, string>
    }
  | { label: (typeof CANDIDATE_LABELS)[number]; error: string }

export type ProposeDeps = {
  chatCompletion?: ChatCompletionFn
  /** Test/alternative-env injection; defaults to process env at call time. */
  env?: Record<string, string | undefined>
}

export function brandExtractModelFromEnv(env: Record<string, string | undefined>): string {
  const model = env.BRAND_EXTRACT_MODEL?.trim()
  if (!model) {
    throw new Error(
      'BRAND_EXTRACT_MODEL is not set — seed extraction requires an explicit model env var (fail loud, never a default model)',
    )
  }
  return model
}

function systemPrompt(): string {
  return [
    'You are a design-system extractor. You convert computed-style evidence from a website into the canonical brand seed format.',
    'The seed format (JSON):',
    JSON.stringify(SEED_SHAPE_DESCRIPTION),
    'Rules: choose OFL-licensed font family names only; seedColor chroma stays within 0..0.4; scaleSteps is an integer 4..8; spaceRhythm has 4..8 positive multipliers; darkModeStrategy is always "invert-tone".',
    'Output ONLY JSON of the shape { "seeds": {...} } — no prose, no markdown fence.',
  ].join('\n')
}

function formatPriorRounds(priorRounds: PriorRound[]): string {
  if (priorRounds.length === 0) {
    return 'This is the first proposal round — no prior verdicts exist.'
  }
  return priorRounds
    .map((round) => {
      const chosen =
        round.verdict.chosen === null
          ? 'none (owner rejected all three)'
          : `chosen: ${round.candidateLabels[round.verdict.chosen] ?? `#${round.verdict.chosen}`}`
      const note = round.verdict.note ? ` — corrective note: ${round.verdict.note}` : ''
      return `Round ${round.round}: ${chosen}${note}`
    })
    .join('\n')
}

function userPrompt(lens: string, digest: string, feedback: string): string {
  return [
    'Computed-style digest of the site to extract:',
    digest,
    '',
    `Prior judge verdicts for context (avoid repeating rejected directions, respect corrective notes):`,
    feedback,
    '',
    lens,
    'Produce the seed block now. Output ONLY JSON { "seeds": {...} }.',
  ].join('\n')
}

function extractContent(response: unknown): string {
  const content = (response as { choices?: Array<{ message?: { content?: unknown } }> })
    ?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('gateway response is missing choices[0].message.content (string)')
  }
  return content
}

/** Parse-only cleanup: models occasionally emit a markdown fence despite json_object mode. */
function parseJsonCandidate(content: string): unknown {
  const unfenced = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  return JSON.parse(unfenced)
}

async function defaultChatCompletion(input: Parameters<ChatCompletionFn>[0]): Promise<unknown> {
  // Lazy: keeps the heavy gateway import (and its DB handle) out of unit tests.
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  return llmChatCompletion(input)
}

/** One round: the three lenses in parallel, each answer parsed, zod-validated and expanded. */
async function runLensRound(args: {
  chatCompletion: ChatCompletionFn
  model: string
  userId: string
  aiSessionId?: string
  logContext: string
  messagesFor: (lens: string) => ChatMessage[]
}): Promise<ProposedCandidate[]> {
  const results = await Promise.all(
    CANDIDATE_LABELS.map(async (label, i): Promise<ProposedCandidate> => {
      try {
        const response = await args.chatCompletion({
          userId: args.userId,
          messages: args.messagesFor(LENSES[label]),
          temperature: TEMPERATURES[i],
          maxTokens: 2048,
          logContext: args.logContext,
          responseFormat: 'json_object',
          modelOverride: args.model,
          ...(args.aiSessionId === undefined ? {} : { aiSessionId: args.aiSessionId }),
        })
        const parsed = parseJsonCandidate(extractContent(response)) as { seeds?: unknown }
        const seeds = brandSeedsSchema.parse(parsed.seeds)
        const expanded = expandSeeds(seeds)
        return { label, seeds, cssVars: expanded.cssVars, darkCssVars: expanded.darkCssVars }
      } catch (err) {
        return { label, error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )

  if (results.every((r) => 'error' in r)) {
    const detail = results.map((r) => `${r.label}: ${'error' in r ? r.error : 'ok'}`).join(' | ')
    throw new Error(`all three extraction candidates invalid — ${detail}`)
  }
  return results
}

export async function proposeCandidates(
  deps: ProposeDeps,
  args: {
    userId: string
    digest: string
    priorRounds: PriorRound[]
    aiSessionId?: string
    env?: Record<string, string | undefined>
  },
): Promise<ProposedCandidate[]> {
  const model = brandExtractModelFromEnv(args.env ?? deps.env ?? privateEnv)
  const feedback = formatPriorRounds(args.priorRounds)
  return runLensRound({
    chatCompletion: deps.chatCompletion ?? defaultChatCompletion,
    model,
    userId: args.userId,
    ...(args.aiSessionId === undefined ? {} : { aiSessionId: args.aiSessionId }),
    logContext: 'brand_extract',
    messagesFor: (lens) => [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(lens, args.digest, feedback) },
    ],
  })
}

/** An uploaded brand guide as the model receives it. */
export type GuideForModel = { filename: string; mime: GuideMime; base64: string }

function guideAttachment(guide: GuideForModel): ChatAttachment {
  return guide.mime === 'application/pdf'
    ? { type: 'pdf', filename: guide.filename, base64: guide.base64 }
    : { type: 'image', mime: guide.mime, base64: guide.base64 }
}

function guideSystemPrompt(): string {
  return [
    "You are a design-system extractor. You convert a company's brand guide (attached as a PDF or an image) into the canonical brand seed format.",
    'The seed format (JSON):',
    JSON.stringify(SEED_SHAPE_DESCRIPTION),
    "Read what the guide specifies first: its named brand colors (convert them to OKLCH), its typefaces and type hierarchy, the colors of its logo, and its rules for spacing, corners, shadows and imagery. Where the guide is silent, infer from how the guide's own pages are designed.",
    'Rules: choose OFL-licensed font family names only — when the guide names a typeface that is not OFL-licensed, choose the closest OFL family; seedColor chroma stays within 0..0.4; scaleSteps is an integer 4..8; spaceRhythm has 4..8 positive multipliers; darkModeStrategy is always "invert-tone".',
    'Output ONLY JSON of the shape { "seeds": {...} } — no prose, no markdown fence.',
  ].join('\n')
}

function guideUserPrompt(lens: string, filename: string, feedback: string): string {
  return [
    `The company's brand guide “${filename}” is attached.`,
    '',
    'Prior judge verdicts for context (avoid repeating rejected directions, respect corrective notes):',
    feedback,
    '',
    lens,
    'Produce the seed block now. Output ONLY JSON { "seeds": {...} }.',
  ].join('\n')
}

/** The same three lenses and seed contract as proposeCandidates, read from an uploaded brand guide. */
export async function proposeCandidatesFromGuide(
  deps: ProposeDeps,
  args: {
    userId: string
    guide: GuideForModel
    priorRounds: PriorRound[]
    aiSessionId?: string
    env?: Record<string, string | undefined>
  },
): Promise<ProposedCandidate[]> {
  const model = brandExtractModelFromEnv(args.env ?? deps.env ?? privateEnv)
  const feedback = formatPriorRounds(args.priorRounds)
  const attachment = guideAttachment(args.guide)
  return runLensRound({
    chatCompletion: deps.chatCompletion ?? defaultChatCompletion,
    model,
    userId: args.userId,
    ...(args.aiSessionId === undefined ? {} : { aiSessionId: args.aiSessionId }),
    logContext: 'brand_extract_guide',
    messagesFor: (lens) => [
      { role: 'system', content: guideSystemPrompt() },
      {
        role: 'user',
        content: guideUserPrompt(lens, args.guide.filename, feedback),
        attachments: [attachment],
      },
    ],
  })
}
