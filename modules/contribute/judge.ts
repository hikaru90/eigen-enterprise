import { z } from 'zod'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { parseLlmJsonPayload } from '$lib/server/memory/llm-json-content'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import { AREA_CATALOG, KIND_CATALOG } from './catalog'
import { ContributeError } from './errors'
import { CONTRIBUTION_AREAS, CONTRIBUTION_KINDS, type ContributionArea, type ContributionKind, type ContributionStatus } from './types'

/**
 * The one LLM judge a proposal runs (Eigen's board judge, AGENTS.md "LLM +
 * ontology + JSON schema"): it classifies kind and area from the catalog and
 * decides whether the draft asks for the same thing as one of the open
 * proposals. Post-LLM code validates the JSON against the schema and the
 * candidate ids; it never re-decides meaning from the strings. The call goes
 * through the gateway (cost tracked, `contribute_judge`).
 */

export const JUDGE_MAX_ATTEMPTS = 3
export const JUDGE_FAILED_MESSAGE = "Couldn't check your proposal — try again"
export const JUDGE_LOG_CONTEXT = 'contribute_judge'

export type JudgeCandidate = {
  id: string
  title: string
  kind: ContributionKind
  area: ContributionArea
  status: ContributionStatus
}

export type JudgeDecision = {
  kind: ContributionKind
  area: ContributionArea
  duplicateOfId: string | null
}

export type JudgeChat = (input: {
  userId: string
  messages: ChatMessage[]
  temperature?: number
  logContext?: string
  responseFormat?: 'json_object'
}) => Promise<unknown>

const outputSchema = z.object({
  kind: z.enum(CONTRIBUTION_KINDS),
  area: z.enum(CONTRIBUTION_AREAS),
  duplicate_of: z.string().trim().min(1).nullable(),
  reason: z.string().optional(),
})

const JSON_SCHEMA = `{ "kind": "${CONTRIBUTION_KINDS.join('" | "')}", "area": "${CONTRIBUTION_AREAS.join('" | "')}", "duplicate_of": "<candidate id>" | null, "reason": "<one short sentence>" }`

export function buildJudgeMessages(
  companyName: string | null,
  title: string,
  candidates: readonly JudgeCandidate[],
): ChatMessage[] {
  const kinds = CONTRIBUTION_KINDS.map((k) => `- "${k}": ${KIND_CATALOG[k]}`).join('\n')
  const areas = CONTRIBUTION_AREAS.map((a) => `- "${a}": ${AREA_CATALOG[a]}`).join('\n')
  const company = companyName ? `the company ${companyName}` : 'a company'
  const system = [
    `You triage an improvement someone at ${company} is proposing for their company app (eigenEnterprise: the company's website, email, team chat, memory, drive, brand and AI assistant in one place).`,
    'Return JSON only, exactly this schema:',
    JSON_SCHEMA,
    'Rules:',
    '- kind must be exactly one key from the kind catalog; area exactly one key from the area catalog. No synonyms.',
    '- duplicate_of is the id of a candidate ONLY when the draft asks for the same change as that candidate (a paraphrase, another wording, another language). Being in the same area, sharing words, or being related is NOT enough: a different request is not a duplicate.',
    '- If no candidate is the same request, duplicate_of is null. Never invent an id; use only ids from the candidate list.',
    'Kind catalog:',
    kinds,
    'Area catalog:',
    areas,
  ].join('\n')

  const list =
    candidates.length === 0
      ? 'Candidates: (no open proposals to compare against — duplicate_of must be null)'
      : [
          'Candidates (open proposals, newest first):',
          ...candidates.map((c) => `- id: ${c.id} | ${c.kind} in ${c.area} | ${c.status} | ${JSON.stringify(c.title)}`),
        ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: `Draft:\n${JSON.stringify(title)}\n\n${list}` },
  ]
}

/** Validate the judge's JSON against the schema and the candidate ids. Throws on anything else. */
export function parseJudgeOutput(response: unknown, candidateIds: ReadonlySet<string>): JudgeDecision {
  const parsed = outputSchema.safeParse(parseLlmJsonPayload(extractChatContent(response)))
  if (!parsed.success) {
    throw new Error(`Judge output failed the schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  }
  const dup = parsed.data.duplicate_of
  if (dup !== null && !candidateIds.has(dup)) {
    throw new Error(`Judge duplicate_of "${dup}" is not one of the candidates`)
  }
  return { kind: parsed.data.kind, area: parsed.data.area, duplicateOfId: dup }
}

/**
 * Exactly 3 attempts, then a plain error (502) — no fallback kind, no "assume
 * not a duplicate". A missing AI provider or an empty wallet is not retried:
 * the gateway's own error surfaces as-is.
 */
export async function judgeProposal(
  chat: JudgeChat,
  input: { userId: string; companyName: string | null; title: string; candidates: readonly JudgeCandidate[] },
): Promise<JudgeDecision> {
  const messages = buildJudgeMessages(input.companyName, input.title, input.candidates)
  const ids = new Set(input.candidates.map((c) => c.id))
  let lastError = ''
  for (let attempt = 1; attempt <= JUDGE_MAX_ATTEMPTS; attempt++) {
    // The gateway retries transport failures itself; its errors (no provider, no credits) are final.
    const response = await chat({ userId: input.userId, messages, temperature: 0, logContext: JUDGE_LOG_CONTEXT, responseFormat: 'json_object' })
    try {
      return parseJudgeOutput(response, ids)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.warn('[contribute.judge] attempt failed', { attempt, error: lastError.slice(0, 200) })
    }
  }
  throw new ContributeError('upstream', `${JUDGE_FAILED_MESSAGE}. (The check failed ${JUDGE_MAX_ATTEMPTS} times: ${lastError})`)
}
