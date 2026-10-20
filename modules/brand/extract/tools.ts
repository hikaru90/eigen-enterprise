import type { CaptureResult } from './capture'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import type { ToolDescriptor, ToolContext } from '$lib/kernel/types'
import { digestFacts } from './facts-digest'
import { proposeCandidates, type ProposedCandidate, type PriorRound } from './propose'
import {
  defaultBrandExtractionStore,
  judgeRoundInputSchema,
  type BrandExtractionStore,
  type JudgeRoundInput,
} from './store'

/**
 * Kernel tools for the design-system extraction judge loop (phase-2d M2).
 * The owner judges three candidates per round against the live screenshot;
 * accepting stages a corpus item — staging is not publishing (2c D5), the
 * strategic gate comes with activation in M5.
 *
 * G8: extraction is owner-owned — mutation/external tools require a human
 * admin principal AND the ['admin'] role; reads are admin+agent.
 */

export type ProposeStep = (args: {
  userId: string
  digest: string
  priorRounds: PriorRound[]
  aiSessionId?: string
}) => Promise<ProposedCandidate[]>

export type BrandExtractToolDeps = {
  store?: BrandExtractionStore
  capture?: (url: string) => Promise<CaptureResult>
  /** Overrides the whole propose step (tests inject a fake; default = gateway proposer). */
  propose?: ProposeStep
}

function requireHuman(ctx: ToolContext): void {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError(
      'permission_denied',
      `brand extraction requires a human principal (G8); principal ${ctx.principal.id} is ${ctx.principal.kind}`,
    )
  }
}

const startInput = z.object({ url: z.string().min(1) })
const proposeInput = z.object({ sessionId: z.string().uuid() })
const acceptInput = z.object({ sessionId: z.string().uuid(), name: z.string().min(1) })
const sessionGetInput = z.object({ sessionId: z.string().uuid() })

async function defaultCapture(url: string): Promise<CaptureResult> {
  const { captureSite } = await import('./capture')
  return captureSite(url)
}

async function defaultProposeStep(args: {
  userId: string
  digest: string
  priorRounds: PriorRound[]
  aiSessionId?: string
}): Promise<ProposedCandidate[]> {
  return proposeCandidates({}, args)
}

export function createBrandExtractTools(deps: BrandExtractToolDeps = {}): ToolDescriptor[] {
  const store = deps.store ?? defaultBrandExtractionStore()
  const capture = deps.capture ?? defaultCapture
  const propose = deps.propose ?? defaultProposeStep
  const mutationPermission = { roles: ['admin'] }
  const readPermission = { roles: ['admin', 'agent'] }

  return [
    {
      name: 'brand.extract_start',
      module: 'brand',
      summary:
        'Capture a public site headlessly (SSRF-guarded) and open an extraction session; round 0 stores the computed-style digest and screenshot.',
      auditClass: 'external',
      activity: (input: z.infer<typeof startInput>) => `Started reading the brand of ${input.url}`,
      inputSchema: startInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        const { url } = startInput.parse(input)
        const result = await capture(url)
        const session = await store.createSession({
          url,
          title: result.title ? result.title : null,
        })
        const digest = digestFacts(result.facts)
        await store.createRound({
          sessionId: session.id,
          round: 0,
          digest,
          screenshotB64: result.screenshotB64,
          candidates: [],
        })
        return { sessionId: session.id, title: session.title, digestSummary: digest }
      },
    },
    {
      name: 'brand.extract_propose',
      module: 'brand',
      summary:
        'Propose three seed candidates (color/type/structure lenses) for a session via the LLM gateway; prior judge verdicts feed the next round.',
      auditClass: 'external',
      activity: () => 'Proposed a round of brand looks',
      inputSchema: proposeInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        const { sessionId } = proposeInput.parse(input)
        const session = await store.requireSession(sessionId)
        if (session.status !== 'active') {
          throw new Error(`session ${sessionId} is ${session.status}; only active sessions accept proposals`)
        }
        const rounds = await store.listRounds(sessionId)
        const factsRound = rounds.find((r) => r.round === 0)
        if (!factsRound) {
          throw new Error(`session ${sessionId} has no capture round 0 — start a session first`)
        }
        const priorRounds = rounds
          .filter((r) => r.round >= 1 && r.verdict !== null)
          .map((r) => ({
            round: r.round,
            verdict: r.verdict!,
            candidateLabels: r.candidates.map((c) => c.label),
          }))
        const candidates = await propose({
          userId: ctx.principal.id,
          digest: factsRound.digest,
          priorRounds,
          aiSessionId: sessionId,
        })
        const nextRound = (rounds[rounds.length - 1]?.round ?? -1) + 1
        const round = await store.createRound({
          sessionId,
          round: nextRound,
          digest: factsRound.digest,
          screenshotB64: factsRound.screenshotB64,
          candidates,
        })
        return { sessionId, round: round.round, candidates }
      },
    },
    {
      name: 'brand.extract_judge',
      module: 'brand',
      summary:
        'Record the owner verdict for a candidate round (chosen = candidate index, or null to reject the round, with optional corrective note).',
      auditClass: 'mutate',
      activity: (input: JudgeRoundInput) =>
        input.chosen === null ? 'Turned down a round of brand looks' : 'Picked one of the proposed brand looks',
      inputSchema: judgeRoundInputSchema,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        const parsed = judgeRoundInputSchema.parse(input)
        const round = await store.judgeRound(parsed)
        return { sessionId: round.sessionId, round: round.round, verdict: round.verdict }
      },
    },
    {
      name: 'brand.extract_accept',
      module: 'brand',
      summary:
        'Stage the chosen candidate of a judged round as a brand corpus item (provenance: extraction) and mark the session accepted. Staging is not publishing.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof acceptInput>) => `Saved “${input.name}” to the brand library`,
      inputSchema: acceptInput,
      permission: mutationPermission,
      handler: async (ctx, input) => {
        requireHuman(ctx)
        const { sessionId, name } = acceptInput.parse(input)
        const staged = await store.accept(sessionId, name)
        return { stagedId: staged.id, corpusItem: staged.corpusItem }
      },
    },
    {
      name: 'brand.extract_session_get',
      module: 'brand',
      summary:
        'Read a full extraction session: session state plus every round (digest, screenshot, candidates, verdict).',
      auditClass: 'read',
      inputSchema: sessionGetInput,
      permission: readPermission,
      handler: async (_ctx, input) => {
        const { sessionId } = sessionGetInput.parse(input)
        const session = await store.requireSession(sessionId)
        const rounds = await store.listRounds(sessionId)
        return { session, rounds }
      },
    },
  ]
}
