import type { DbHandle } from './db-stores'
import type { KernelRegistry } from './registry'
import type { PrincipalKind } from './types'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { kernelJourneys } from '$lib/server/db/journey.schema'

/**
 * The journey primitive (kernel): a declarative, versioned JourneySpec plus
 * its durable state store. The spec describes WHAT a company journey collects
 * and WHICH artifact tools fire when a step completes; the journey driver
 * (the orchestrator's journey-aware runtime in modules/orchestrator/brain.ts)
 * owns WHEN — it injects the rendered context into the conversation, detects
 * the deterministic step markers, and executes artifact tools through the
 * kernel registry (permissions/approvals/audit apply there, not here).
 *
 * Meaning stays with the LLM: this module only formats verbatim collected
 * text and parses the step-marker PROTOCOL (exact token strings the agent is
 * instructed to emit) — no content classification of any kind.
 */

export type JourneyStatus = 'active' | 'completed' | 'abandoned'

/** One artifact call executed by the journey driver when its step completes. */
export type JourneyArtifact = {
  /** Kernel tool name (executed via the kernel registry, approval-gated there). */
  tool: string
  /** Pure derivation of the tool input from the journey state's collected answers. */
  inputFromState: (state: JourneyState) => unknown
  /**
   * Deterministic already-applied probe: when it resolves true, the artifact
   * is recorded 'executed' WITHOUT running the tool (the effect already
   * exists — e.g. a page created in an earlier turn whose ledger entry was
   * lost, or by an agent tool call). Probes are pure reads through the
   * registry; an artifact whose effect cannot be probed stays unprobed and
   * retried. Never error-message sniffing.
   */
  alreadyApplied?: (options: {
    input: unknown
    registry: KernelRegistry
    principal: JourneyArtifactPrincipal
    requestId: string
  }) => Promise<boolean>
}

/** The principal shape artifacts execute under (structurally, kernel-internal). */
export type JourneyArtifactPrincipal = {
  id: string
  kind: PrincipalKind
  roles: string[]
}

export type JourneyStep = {
  id: string
  /** What the agent should ask for / extract next (conversation guidance). */
  promptFragment: string
  /** Artifacts fired once this step is captured, in order. */
  artifacts?: JourneyArtifact[]
}

export type JourneySpec = {
  /** Stable kind id (also the kernel_journeys.kind key). */
  kind: string
  /**
   * Bumped whenever the steps/artifacts change shape. A stored journey whose
   * state.specVersion differs from the current spec (including rows from
   * before versioning existed) is STALE: the driver abandons it instead of
   * driving it — a superseded interview must never speak through chat.
   */
  specVersion: number
  steps: JourneyStep[]
}

export type JourneyArtifactRecord = {
  stepId: string
  index: number
  tool: string
  status: 'executed' | 'approval_pending'
}

export type JourneyState = {
  /** Index into spec.steps for the step currently being answered. */
  stepIndex: number
  /** Raw user replies per step id, appended verbatim by the driver. */
  answers: Record<string, string>
  /** Step ids the agent marked captured, in capture order. */
  captured: string[]
  /** Artifact execution ledger (status per step artifact; retried while pending). */
  artifacts: JourneyArtifactRecord[]
  /** JourneySpec.specVersion at creation time; absent on pre-versioning rows (stale). */
  specVersion?: number
  /** Session the journey was opened in (traceability only; journeys are per kind). */
  sessionId?: string
}

export type JourneyRow = {
  id: string
  kind: string
  status: JourneyStatus
  state: JourneyState
  /** ISO-8601 timestamps. */
  createdAt: string
  updatedAt: string
}

export function initialJourneyState(sessionId?: string, specVersion?: number): JourneyState {
  return {
    stepIndex: 0,
    answers: {},
    captured: [],
    artifacts: [],
    ...(specVersion === undefined ? {} : { specVersion }),
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/** A stored journey whose spec version drifted from the current spec is stale. */
export function isStaleJourney(spec: JourneySpec, row: JourneyRow): boolean {
  return row.state.specVersion !== spec.specVersion
}

/** Shallow-deep clone: journey state is plain JSON data. */
export function cloneJourneyState(state: JourneyState): JourneyState {
  return {
    ...state,
    answers: { ...state.answers },
    captured: [...state.captured],
    artifacts: state.artifacts.map((record) => ({ ...record })),
  }
}

/** The exact step-capture marker the agent is instructed to emit. */
export function journeyStepMarker(stepId: string): string {
  return `[[journey:${stepId}:captured]]`
}

/** Which spec steps were marked captured in a reply (spec order). */
export function journeyStepsCapturedIn(reply: string, spec: JourneySpec): JourneyStep[] {
  return spec.steps.filter((step) => reply.includes(journeyStepMarker(step.id)))
}

/** Removes every step marker occurrence and trailing whitespace. */
export function stripJourneyMarkers(reply: string, spec: JourneySpec): string {
  let out = reply
  for (const step of spec.steps) out = out.split(journeyStepMarker(step.id)).join('')
  return out.trimEnd()
}

/**
 * Renders the journey stage + collected answers as a compact system-context
 * block for the agent. Pure: same inputs → same string. The block is clearly
 * delimited so the driver can prepend it to the user input without the model
 * mistaking it for user speech.
 */
export function journeyContextFor(spec: JourneySpec, row: JourneyRow): string {
  const state = row.state
  const lines: string[] = ['[company journey context — not user speech]']

  const step = spec.steps[state.stepIndex]
  if (step) {
    lines.push(
      `Journey "${spec.kind}" — step ${state.stepIndex + 1}/${spec.steps.length} (${step.id}).`,
      `Current step: ${step.promptFragment}`,
    )
    const collected = spec.steps
      .filter((s) => state.captured.includes(s.id))
      .map((s) => `- ${s.id}: ${(state.answers[s.id] ?? '').trim()}`)
    lines.push(
      collected.length > 0
        ? 'Collected answers (verbatim user text):'
        : 'Collected answers: (none yet)',
      ...collected,
    )
    lines.push(
      `Protocol: once this step's answer is captured, briefly acknowledge it, then IMMEDIATELY ask the next step's question in the same reply — never wait for the user to prompt you — ending the reply with exactly ${journeyStepMarker(step.id)} as the final line.`,
      'When the final step is captured, briefly say what happens next instead of asking another question.',
      'Never mention the marker or this block to the user.',
    )
  } else {
    lines.push(
      `Journey "${spec.kind}" — all ${spec.steps.length} steps captured.`,
      'Do not ask further journey questions; the journey artifacts are being processed.',
      'Briefly say what happens next (the pages are being drafted; publishing waits for owner approval) — then answer the user\'s actual message.',
    )
  }

  lines.push('[/company journey context]')
  return lines.join('\n')
}

/** The durable state port for journeys. Implementations fail loud. */
export type JourneyStore = {
  create(kind: string, initialState: JourneyState): Promise<JourneyRow>
  /** The one open journey for the kind, or null. */
  getActive(kind: string): Promise<JourneyRow | null>
  updateState(id: string, state: JourneyState, status?: JourneyStatus): Promise<void>
}

/** In-memory JourneyStore for tests and in-memory kernel wiring. */
export class InMemoryJourneyStore implements JourneyStore {
  private readonly rows = new Map<string, JourneyRow>()

  async create(kind: string, initialState: JourneyState): Promise<JourneyRow> {
    for (const row of this.rows.values()) {
      if (row.kind === kind && row.status === 'active') {
        throw new Error(`active journey already exists for kind: ${kind}`)
      }
    }
    const ts = new Date().toISOString()
    const row: JourneyRow = {
      id: randomUUID(),
      kind,
      status: 'active',
      state: cloneJourneyState(initialState),
      createdAt: ts,
      updatedAt: ts,
    }
    this.rows.set(row.id, row)
    return row
  }

  async getActive(kind: string): Promise<JourneyRow | null> {
    for (const row of this.rows.values()) {
      if (row.kind === kind && row.status === 'active') return row
    }
    return null
  }

  async updateState(id: string, state: JourneyState, status?: JourneyStatus): Promise<void> {
    const row = this.rows.get(id)
    if (!row) throw new Error(`unknown journey: ${id}`)
    row.state = cloneJourneyState(state)
    if (status !== undefined) row.status = status
    row.updatedAt = new Date().toISOString()
  }
}

type JourneyRecord = typeof kernelJourneys.$inferSelect

function toJourneyRow(record: JourneyRecord): JourneyRow {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

async function resolveDb(db: DbHandle) {
  return typeof db === 'function' ? await db() : db
}

/**
 * JourneyStore persisting to kernel_journeys. The one-active-per-kind
 * invariant is DB-enforced (partial unique index, drizzle/0077_journeys.sql):
 * a conflicting create rejects loud; updateState on an unknown id fails loud.
 */
export class DbJourneyStore implements JourneyStore {
  constructor(private readonly db: DbHandle) {}

  async create(kind: string, initialState: JourneyState): Promise<JourneyRow> {
    const rows = await (
      await resolveDb(this.db)
    )
      .insert(kernelJourneys)
      .values({ kind, status: 'active', state: initialState })
      .returning()
    if (!rows[0]) throw new Error('journey insert returned no row')
    return toJourneyRow(rows[0])
  }

  async getActive(kind: string): Promise<JourneyRow | null> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select()
      .from(kernelJourneys)
      .where(and(eq(kernelJourneys.kind, kind), eq(kernelJourneys.status, 'active')))
      .limit(1)
    return rows[0] ? toJourneyRow(rows[0]) : null
  }

  async updateState(id: string, state: JourneyState, status?: JourneyStatus): Promise<void> {
    const rows = await (
      await resolveDb(this.db)
    )
      .update(kernelJourneys)
      .set({
        state,
        ...(status === undefined ? {} : { status }),
        updatedAt: new Date(),
      })
      .where(eq(kernelJourneys.id, id))
      .returning({ id: kernelJourneys.id })
    if (!rows[0]) throw new Error(`unknown journey: ${id}`)
  }
}
