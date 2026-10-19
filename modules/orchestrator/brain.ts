import { randomUUID } from 'node:crypto'
import type { AgentConfig } from '$lib/kernel/agent'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import type { AgentRuntimeOptions, DispatchOptions } from '$lib/kernel/agent-runtime'
import { KERNEL_EVENT_SOURCE } from '$lib/kernel/cloudevents'
import type { EngineStreamSinks, EngineSurfaceEvent } from '$lib/kernel/engine'
import { BuiltinJsonLoop, type LlmCompleteFn } from '$lib/kernel/engines/builtin-json'
import { KernelError } from '$lib/kernel/errors'
import { emitKernelEvent, type EventSink } from '$lib/kernel/events'
import type { Brain, TelegramSessionRef } from '$lib/kernel/gateway'
import {
  cloneJourneyState,
  initialJourneyState,
  isStaleJourney,
  journeyContextFor,
  journeyStepsCapturedIn,
  stripJourneyMarkers,
  type JourneyArtifact,
  type JourneyArtifactPrincipal,
  type JourneyRow,
  type JourneySpec,
  type JourneyState,
  type JourneyStore,
} from '$lib/kernel/playbook'
import type { KernelRegistry } from '$lib/kernel/registry'
import type { AgentSessionLog } from '$lib/kernel/session-log'
import { disciplineSections } from './discipline'
import { resolveDispatchEngine, type OrchestratorEngineId } from './engine-choice'
import {
  ONBOARDING_HANDOFF_INSTRUCTION,
  ONBOARDING_START_WEBSITE_MARKER,
  assistedOnboardingActive,
  onboardingContextBlock,
  replyStartsWebsite,
  stripOnboardingMarkers,
  type OnboardingFacts,
  type OnboardingFactsResolver,
} from './onboarding-context'

/**
 * The orchestrator is no longer a brain with kernel privileges — it is one
 * hosted agent config (plan/phase-1b-harness.md demotion #1). This file keeps
 * only orchestrator-identity data (principal, persona prompt, LLM identity),
 * the website-founding JourneySpec, and a thin Brain adapter — plus the
 * journey-aware runtime subclass that drives the journey around the harness
 * dispatch (the chatbox dispatches via runtime.dispatch directly, so journey
 * logic lives there, not in the Brain).
 */

/**
 * The orchestrator principal: the company agent that executes kernel tools on
 * behalf of gateway users. Every tool call runs under this principal —
 * permissions, approval gate, and audit all see it.
 */
export const ORCHESTRATOR_PRINCIPAL: {
  id: string
  kind: 'agent'
  roles: string[]
} = { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }

export const ORCHESTRATOR_AGENT_ID = ORCHESTRATOR_PRINCIPAL.id

/**
 * Gateway billing/config identity for the orchestrator's LLM calls. The
 * llm-client resolves platform credentials for it (LLM_BASE_URL /
 * SERVICE_API_KEY_* env or the platform DB config).
 */
export const ORCHESTRATOR_LLM_USER_ID = 'orchestrator'

/**
 * The website-founding journey: brand Q&A (tone, name, positioning) → site
 * skeleton → publish (owner-approval gated). Declarative, versioned data on
 * the kernel playbook primitive; artifact tools execute through the kernel
 * registry under ORCHESTRATOR_PRINCIPAL.
 *
 * The journey is OPENED BY ONBOARDING (the welcome wizard's founding
 * interview — src/lib/server/onboarding/founding.ts), never by chat replies:
 * onboarding questions must not leak into ordinary chat. Two entry points
 * share one artifact semantics via executeStepArtifacts():
 * - onboarding: records all answers as a fully-captured journey + runs the
 *   artifacts immediately (publishes gate → approval_pending).
 * - chat driver (JourneyAwareAgentRuntime): continues active journeys —
 *   legacy mid-interview rows and approval retries.
 *
 * Deterministic protocol (no string heuristics for meaning — these are exact
 * protocol tokens the agent is instructed to emit, never user-text
 * classification):
 * - STEP CAPTURE: the agent appends `[[journey:<id>:captured]]` from the
 *   context block's protocol line; the driver strips the markers and advances.
 */
/**
 * Already-applied probes for the founding artifacts: pure reads through the
 * registry (website.list_pages), never error sniffing. A create whose slug
 * already exists, and a publish whose page already sits at the target
 * visibility, are ledger-recorded executed instead of re-run — a retried
 * turn (e.g. a plain "hi" while publishes wait on approval) must never
 * surface `duplicate website slug`.
 */
async function listPagesViaRegistry(
  registry: KernelRegistry,
  ctx: { principal: JourneyArtifactPrincipal; requestId: string },
): Promise<Array<{ slug: string; visibility: string }>> {
  const rows = await registry.execute('website.list_pages', {}, ctx)
  return rows as Array<{ slug: string; visibility: string }>
}

const createPageApplied: NonNullable<JourneyArtifact['alreadyApplied']> = async ({
  input,
  registry,
  principal,
  requestId,
}) => {
  const pages = await listPagesViaRegistry(registry, { principal, requestId })
  const slug = (input as { slug: string }).slug
  return pages.some((page) => page.slug === slug)
}

const publishPageApplied: NonNullable<JourneyArtifact['alreadyApplied']> = async ({
  input,
  registry,
  principal,
  requestId,
}) => {
  const pages = await listPagesViaRegistry(registry, { principal, requestId })
  const { slug, visibility } = input as { slug: string; visibility: string }
  const page = pages.find((entry) => entry.slug === slug)
  return page?.visibility === visibility
}

export const WEBSITE_FOUNDING_JOURNEY: JourneySpec = {
  kind: 'website_founding',
  // v2: the phase-2e founding order (company_name → positioning → tone).
  // Rows stored under v1 (or pre-versioning) are stale — the driver abandons
  // them instead of driving a superseded interview through chat.
  specVersion: 2,
  // Phase-2e order: the boot sequence's seeded greeting asks the company name
  // first, then what the company does, then tone — artifacts run on the step
  // where every answer they need is already captured.
  steps: [
    {
      id: 'company_name',
      promptFragment: 'Ask for the company name (one short answer).',
    },
    {
      id: 'positioning',
      promptFragment: 'Ask for a one-sentence description of what the company does.',
      artifacts: [
        {
          tool: 'website.create_page',
          alreadyApplied: createPageApplied,
          inputFromState: (state: JourneyState) => ({
            slug: 'home',
            title: 'Home',
            kind: 'page',
            visibility: 'private',
            body: [
              `# ${state.answers.company_name ?? 'Home'}`,
              '',
              state.answers.positioning ?? '',
              '',
              '(Placeholder skeleton from the founding journey — replace this copy.)',
            ].join('\n'),
          }),
        },
        {
          tool: 'website.create_page',
          alreadyApplied: createPageApplied,
          inputFromState: (state: JourneyState) => ({
            slug: 'about',
            title: 'About',
            kind: 'page',
            visibility: 'private',
            body: [
              `# About ${state.answers.company_name ?? 'us'}`,
              '',
              state.answers.positioning ?? '',
              '',
              '(Placeholder skeleton from the founding journey — replace this copy.)',
            ].join('\n'),
          }),
        },
        {
          tool: 'website.create_page',
          alreadyApplied: createPageApplied,
          inputFromState: (state: JourneyState) => ({
            slug: 'contact',
            title: 'Contact',
            kind: 'page',
            visibility: 'private',
            body: [
              `# Contact ${state.answers.company_name ?? 'us'}`,
              '',
              'Tell us what you need — this placeholder page ships with the founding journey skeleton.',
            ].join('\n'),
          }),
        },
        {
          tool: 'website.publish_page',
          alreadyApplied: publishPageApplied,
          inputFromState: () => ({ slug: 'home', visibility: 'public' }),
        },
        {
          tool: 'website.publish_page',
          alreadyApplied: publishPageApplied,
          inputFromState: () => ({ slug: 'about', visibility: 'public' }),
        },
        {
          tool: 'website.publish_page',
          alreadyApplied: publishPageApplied,
          inputFromState: () => ({ slug: 'contact', visibility: 'public' }),
        },
      ],
    },
    {
      // Final step: the brand doc needs the tone answer, so it is this step's
      // artifact — by the time tone is captured, name + positioning exist too.
      id: 'tone',
      promptFragment:
        'Collect the company’s tone of voice — three words the user gives (or confirms) count as captured.',
      artifacts: [
        {
          tool: 'website.create_page',
          alreadyApplied: createPageApplied,
          inputFromState: (state: JourneyState) => ({
            slug: 'brand-tone-of-voice',
            title: 'Brand — Tone of Voice',
            kind: 'doc',
            visibility: 'private',
            body: [
              '# Brand — Tone of Voice',
              '',
              `Tone of voice: ${state.answers.tone ?? ''}`,
              `Company name: ${state.answers.company_name ?? ''}`,
              '',
              '(Captured verbatim during the website founding journey.)',
            ].join('\n'),
          }),
        },
      ],
    },
  ],
}

/**
 * Journey protocol for chat surfaces. Journeys are opened ONLY by onboarding
 * (the welcome wizard's founding interview) — the persona never asks journey
 * questions proactively, so onboarding content never interrupts the chat.
 * When a journey context block IS present (an active journey from onboarding,
 * or a legacy mid-interview row), the agent follows its capture protocol.
 */
export const ORCHESTRATOR_JOURNEY_PROMPT = [
  'JOURNEY: when a journey context block is present in the user message, follow it — the journey drives itself: after capturing an answer, ask the next step’s question unprompted in the same reply. Ask one question per reply, no lists unless asked. Never stop mid-journey and wait for the user to ask “and now?”.',
  'When a journey context block gives you a step-capture marker protocol and the step’s answer is captured, append exactly that marker as the final line of your reply. Never show or mention markers to the user.',
].join('\n')

/**
 * Assisted onboarding protocol: after the scripted setup the orchestrator
 * guides the owner (website first, then the other modules). The per-turn
 * facts arrive in the onboarding context block (modules/orchestrator/onboarding-context.ts).
 */
export const ORCHESTRATOR_ONBOARDING_PROMPT = [
  `ONBOARDING: when a company onboarding context block is present in the user message, you are guiding the owner right after setup — follow its order and protocol (start marker ${ONBOARDING_START_WEBSITE_MARKER} only once the owner agreed to start the website). This block overrides the “you do not interview” posture for the website founding journey.`,
].join('\n')

/** Persona preamble handed to BOTH orchestrator engines (builtin-json + durable) as the system prompt. */
export const ORCHESTRATOR_PERSONA_PROMPT = [
  'You are the orchestrator: the general assistant of this company.',
  'You can act through kernel tools. Every tool call is permission-checked, audited, and (for external actions) gated behind owner approval.',
  'ORCHESTRATOR POSTURE — you route, you do not interview:',
  '- The chat is mission control, not a questionnaire. Never walk the human through a multi-step intake (founding questions, branding extraction, provider setup) in conversation; those live in their own surfaces (welcome wizard, /brand, /settings).',
  '- Know what the company CAN do — name the modules (memory, website, brand, email, repo, chat-gateway, recap, roadmap), say in one line what each does, and offer the relevant one.',
  '- When a request belongs to a module, say so and hand off: point at its surface or offer to run its kernel tools — do not silently start doing a module’s job in general chat.',
  '- Answer anything directly that needs no module (questions, status, small talk, quick kernel lookups).',
  ORCHESTRATOR_JOURNEY_PROMPT,
  ORCHESTRATOR_ONBOARDING_PROMPT,
  ...disciplineSections(),
].join('\n')

/** The orchestrator as harness config: zero code privilege, full harness inherited. */
export function orchestratorAgentConfig(
  options: { spendCapUsd?: number; loopEngine?: 'builtin-json' | 'durable' } = {},
): AgentConfig {
  return {
    id: ORCHESTRATOR_AGENT_ID,
    personaName: 'Orchestrator',
    description:
      'The company general assistant: executes kernel tools on behalf of gateway users.',
    loopEngine: options.loopEngine ?? 'builtin-json',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    ...(options.spendCapUsd === undefined ? {} : { spendCapUsd: options.spendCapUsd }),
    enabled: true,
  }
}

/** The orchestrator's loop: the extracted builtin-json engine with its persona. */
export function buildOrchestratorEngine(options: {
  complete?: LlmCompleteFn
  llmUserId?: string
  sessionLog: AgentSessionLog
}): BuiltinJsonLoop {
  return new BuiltinJsonLoop({
    ...(options.complete === undefined ? {} : { complete: options.complete }),
    sessionLog: options.sessionLog,
    systemPrompt: ORCHESTRATOR_PERSONA_PROMPT,
    llmUserId: options.llmUserId ?? ORCHESTRATOR_LLM_USER_ID,
    logContext: 'orchestrator_brain',
  })
}

const JOURNEY_CONTEXT_SEPARATOR = '\n\n---\n\n'
const JOURNEY_APPROVAL_NOTE =
  '\n\n(Website publishing needs owner approval — the request is queued; it completes once the owner approves.)'

export type JourneyAwareRuntimeOptions = AgentRuntimeOptions & {
  journeys: JourneyStore
  spec: JourneySpec
  /** Assisted-onboarding facts for the conversing human (boot wires the DB). Absent = never active. */
  onboardingFacts?: OnboardingFactsResolver
  /** Operator pin (EE_ORCHESTRATOR_ENGINE); null/absent = the recorded per-provider choice decides. */
  enginePin?: OrchestratorEngineId | null
  /** The engine recorded at connect time for the conversing user's active provider (null = none). */
  recordedEngineFor?: (llmUserId: string) => Promise<OrchestratorEngineId | null>
}

/**
 * Journey driver around the harness dispatch. Subclass by design: the chatbox
 * (src/routes/api/chat) and the Telegram brain both dispatch through
 * runtime.dispatch for the orchestrator agent — this is the one seam where
 * per-dispatch journey context enters WITHOUT touching kernel engine files.
 * For every OTHER agent it is pure passthrough.
 *
 * Deterministic seam (documented):
 * - START: journeys are created by onboarding (founding interview) — never by
 *   chat replies. With no active journey the driver is a pure passthrough.
 * - ANSWERS: while a journey is active, every user reply is appended verbatim
 *   to the current step's answer slot; the rendered journey context block is
 *   prepended to the user input (clearly delimited; the engine's history keeps
 *   the block — harmless context continuity, engine files stay untouched).
 * - STEP CAPTURE: the agent appends the exact `[[journey:<id>:captured]]`
 *   protocol token; the driver strips markers from the user-facing reply,
 *   advances the state, and fires the step's artifact tools DIRECTLY via the
 *   kernel registry under ORCHESTRATOR_PRINCIPAL — permissions, audit, and the
 *   approval gate apply there. `approval_required` is expected control flow:
 *   the ledger records 'approval_pending' and retries on later turns; any
 *   other artifact error fails loud (no silent degradation).
 * - COMPLETION: all steps captured + all artifacts executed → status
 *   'completed' + a `journey.completed` kernel event (metadata only).
 */
export class JourneyAwareAgentRuntime extends AgentRuntime {
  private readonly journeys: JourneyStore
  private readonly spec: JourneySpec
  private readonly kernelRegistry: KernelRegistry
  private readonly kernelEventSink: EventSink
  private readonly onboardingFacts: OnboardingFactsResolver | undefined
  private readonly enginePin: OrchestratorEngineId | null
  private readonly recordedEngineFor: JourneyAwareRuntimeOptions['recordedEngineFor']

  constructor(options: JourneyAwareRuntimeOptions) {
    super(options)
    this.journeys = options.journeys
    this.spec = options.spec
    this.kernelRegistry = options.registry
    this.kernelEventSink = options.eventSink
    this.onboardingFacts = options.onboardingFacts
    this.enginePin = options.enginePin ?? null
    this.recordedEngineFor = options.recordedEngineFor
  }

  /**
   * The assisted-onboarding hand-off: the orchestrator's FIRST turn after the
   * scripted setup, generated by the agent from the onboarding context block
   * plus the hand-off instruction (no user speech). The hand-off request IS
   * the signal that the scripted setup ended (the welcome wizard persists its
   * stamp concurrently), so only the website state gates it. Fails loud when
   * there is nothing to hand off — a hand-off out of context would greet a
   * founder who is already past it.
   */
  async dispatchOnboardingHandoff(
    sessionId: string,
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
  ): Promise<string> {
    const resolved = this.onboardingFacts ? await this.onboardingFacts(options?.llmUserId) : null
    const facts = resolved ? { ...resolved, welcomeCompleted: true } : null
    if (!facts || !assistedOnboardingActive(facts)) {
      throw new KernelError(
        'onboarding_inactive',
        'onboarding hand-off requested but assisted onboarding is not active for this user',
      )
    }
    return this.dispatchOnboardingTurn(facts, sessionId, ONBOARDING_HANDOFF_INSTRUCTION, sinks, options)
  }

  /** Adds the explicit per-dispatch engine choice (pin > recorded > engine of record). */
  private async withEngine(options?: DispatchOptions): Promise<DispatchOptions | undefined> {
    if (!this.recordedEngineFor && this.enginePin === null) return options
    const recorded =
      options?.llmUserId && this.recordedEngineFor ? await this.recordedEngineFor(options.llmUserId) : null
    return { ...options, loopEngine: resolveDispatchEngine({ pin: this.enginePin, recorded }) }
  }

  private async activeOnboardingFacts(llmUserId: string | undefined): Promise<OnboardingFacts | null> {
    if (!this.onboardingFacts) return null
    const facts = await this.onboardingFacts(llmUserId)
    return facts && assistedOnboardingActive(facts) ? facts : null
  }

  private async dispatchOnboardingTurn(
    facts: OnboardingFacts,
    sessionId: string,
    input: string,
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
  ): Promise<string> {
    const firstStep = this.spec.steps[0]
    if (!firstStep) throw new Error(`journey spec ${this.spec.kind} has no steps`)
    const reply = await super.dispatch(
      ORCHESTRATOR_AGENT_ID,
      sessionId,
      `${onboardingContextBlock(facts, firstStep.promptFragment)}${JOURNEY_CONTEXT_SEPARATOR}${input}`,
      sinks,
      await this.withEngine(options),
    )
    // The agent decided the owner agreed (exact protocol token only): the
    // website journey opens EMPTY — the agreement is not an answer.
    if (replyStartsWebsite(reply) && !(await this.journeys.getActive(this.spec.kind))) {
      await this.journeys.create(this.spec.kind, initialJourneyState(sessionId, this.spec.specVersion))
    }
    return stripOnboardingMarkers(reply)
  }

  override async dispatch(
    agentId: string,
    sessionId: string,
    input: string,
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
  ): Promise<string> {
    if (agentId !== ORCHESTRATOR_AGENT_ID) {
      return super.dispatch(agentId, sessionId, input, sinks, options)
    }

    const row = await this.journeys.getActive(this.spec.kind)
    // No journey → assisted onboarding (agent-opened journey via the exact
    // start marker) while it is active, else a plain orchestrator turn.
    if (!row) {
      const facts = await this.activeOnboardingFacts(options?.llmUserId)
      if (facts) return this.dispatchOnboardingTurn(facts, sessionId, input, sinks, options)
      return super.dispatch(agentId, sessionId, input, sinks, await this.withEngine(options))
    }
    // Stale spec: the stored journey predates the current spec shape (v1 /
    // pre-versioning rows). Abandon it — a superseded interview must never
    // drive the conversation — and answer as the plain orchestrator.
    if (isStaleJourney(this.spec, row)) {
      await this.journeys.updateState(row.id, row.state, 'abandoned')
      await emitKernelEvent(this.kernelEventSink, {
        type: 'journey.abandoned',
        principalId: ORCHESTRATOR_AGENT_ID,
        source: KERNEL_EVENT_SOURCE,
        payload: { journeyId: row.id, kind: row.kind, reason: 'spec_version' },
      })
      return super.dispatch(agentId, sessionId, input, sinks, await this.withEngine(options))
    }
    return this.dispatchJourneyTurn(row, agentId, sessionId, input, sinks, options)
  }

  private async dispatchJourneyTurn(
    row: JourneyRow,
    agentId: string,
    sessionId: string,
    input: string,
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
  ): Promise<string> {
    const state = cloneJourneyState(row.state)

    // Verbatim answer accumulation for the current step (multi-turn answers
    // concatenate; content is never interpreted here).
    const current = this.spec.steps[state.stepIndex]
    if (current) {
      state.answers[current.id] = state.answers[current.id]
        ? `${state.answers[current.id]}\n${input}`
        : input
    }

    const reply = await super.dispatch(
      agentId,
      sessionId,
      `${journeyContextFor(this.spec, { ...row, state })}${JOURNEY_CONTEXT_SEPARATOR}${input}`,
      sinks,
      await this.withEngine(options),
    )

    // Step capture: exact protocol markers only. Stripped before the reply
    // reaches the user.
    const capturedNow = journeyStepsCapturedIn(reply, this.spec).filter(
      (step) => !state.captured.includes(step.id),
    )
    for (const step of capturedNow) {
      state.captured.push(step.id)
      state.stepIndex = Math.min(this.spec.steps.indexOf(step) + 1, this.spec.steps.length)
    }
    const cleanReply = stripJourneyMarkers(reply, this.spec)

    const { allExecuted, newlyPending } = await this.runStepArtifacts(state, sinks)

    const allCaptured = this.spec.steps.every((step) => state.captured.includes(step.id))
    if (allCaptured && allExecuted) {
      await this.journeys.updateState(row.id, state, 'completed')
      await emitKernelEvent(this.kernelEventSink, {
        type: 'journey.completed',
        principalId: ORCHESTRATOR_AGENT_ID,
        source: KERNEL_EVENT_SOURCE,
        payload: { journeyId: row.id, kind: row.kind },
      })
    } else {
      await this.journeys.updateState(row.id, state)
    }

    // On surfaces without a structured sink (Telegram), say the gate in text;
    // chatbox surfaces get the approval.required surface event instead.
    if (newlyPending && !sinks?.surfaceEvent) return `${cleanReply}${JOURNEY_APPROVAL_NOTE}`
    return cleanReply
  }

  /**
   * Delegates to the shared artifact executor — one artifact semantics for
   * both entry points (chat driver + onboarding founding endpoint).
   */
  private runStepArtifacts(
    state: JourneyState,
    sinks?: EngineStreamSinks,
  ): Promise<{ allExecuted: boolean; newlyPending: boolean }> {
    return executeStepArtifacts({
      registry: this.kernelRegistry,
      spec: this.spec,
      state,
      ...(sinks?.surfaceEvent ? { surfaceEvent: sinks.surfaceEvent } : {}),
    })
  }
}

/** Mutable artifact-ledger bookkeeping (state is plain JSON data). */
function recordArtifact(
  state: JourneyState,
  stepId: string,
  index: number,
  tool: string,
  status: 'executed' | 'approval_pending',
): void {
  const remaining = state.artifacts.filter((r) => !(r.stepId === stepId && r.index === index))
  remaining.push({ stepId, index, tool, status })
  state.artifacts = remaining
}

/**
 * Executes pending step artifacts in spec order via the kernel registry
 * (ORCHESTRATOR_PRINCIPAL; approvals + audit apply there). Shared by the chat
 * journey driver and the onboarding founding endpoint.
 *
 * 'approval_required' is expected control flow: the state ledger records
 * 'approval_pending' and later turns retry until the owner decides. The
 * batch stops at the first open gate — later artifacts retry next turn. Any
 * other error fails loud (no silent degradation).
 */
export async function executeStepArtifacts(options: {
  registry: KernelRegistry
  spec: JourneySpec
  state: JourneyState
  /** Optional surface sink for approval gates (chat streams); best-effort. */
  surfaceEvent?: (event: EngineSurfaceEvent) => void
}): Promise<{ allExecuted: boolean; newlyPending: boolean }> {
  const { registry, spec, state } = options
  const requestId = randomUUID()
  let newlyPending = false

  for (const step of spec.steps) {
    if (!state.captured.includes(step.id) || !step.artifacts) continue
    for (let index = 0; index < step.artifacts.length; index++) {
      const artifact = step.artifacts[index]!
      const alreadyExecuted = state.artifacts.some(
        (r) => r.stepId === step.id && r.index === index && r.status === 'executed',
      )
      if (alreadyExecuted) continue
      const input = artifact.inputFromState(state)
      if (artifact.alreadyApplied) {
        const applied = await artifact.alreadyApplied({
          input,
          registry,
          principal: ORCHESTRATOR_PRINCIPAL,
          requestId,
        })
        if (applied) {
          recordArtifact(state, step.id, index, artifact.tool, 'executed')
          continue
        }
      }
      try {
        await registry.execute(
          artifact.tool,
          input,
          { principal: ORCHESTRATOR_PRINCIPAL, requestId },
        )
        recordArtifact(state, step.id, index, artifact.tool, 'executed')
      } catch (err) {
        if (err instanceof KernelError && err.code === 'approval_required') {
          recordArtifact(state, step.id, index, artifact.tool, 'approval_pending')
          newlyPending = true
          try {
            options.surfaceEvent?.({ type: 'approval.required', tool: artifact.tool })
          } catch {
            // best-effort channel — the gate state is already in the ledger
          }
          break
        }
        throw err
      }
    }
  }

  const allExecuted = spec.steps.every((step) =>
    (step.artifacts ?? []).every((_artifact, index) =>
      state.artifacts.some(
        (r) => r.stepId === step.id && r.index === index && r.status === 'executed',
      ),
    ),
  )
  return { allExecuted, newlyPending }
}

/**
 * Thin Brain adapter over the harness: gateway sessions dispatch through the
 * AgentRuntime as agent 'orchestrator'. Tool-surface filtering, permissions,
 * approvals, audit, events, budget, and the journey driver live in the
 * runtime — not here.
 */
export class OrchestratorBrain implements Brain {
  private readonly runtime: AgentRuntime

  constructor(options: { runtime: AgentRuntime }) {
    this.runtime = options.runtime
  }

  async respond(session: TelegramSessionRef, text: string): Promise<string> {
    // The allowlisted human principal id IS the auth user id — their BYOK
    // provider config pays for the run, exactly like the web chatbox.
    return this.runtime.dispatch(ORCHESTRATOR_AGENT_ID, session.sessionId, text, undefined, {
      llmUserId: session.principalId,
    })
  }

  /**
   * The fail-closed tool surface the agent is offered right now (activation ∩
   * scope ∩ role filtered by the runtime) — parity with the pre-harness brain.
   */
  async offeredTools(): Promise<Array<{ name: string }>> {
    return this.runtime.listAgentTools(ORCHESTRATOR_AGENT_ID)
  }
}
