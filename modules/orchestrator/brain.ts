import { randomUUID } from 'node:crypto'
import type { AgentConfig } from '$lib/kernel/agent'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import type { AgentRuntimeOptions } from '$lib/kernel/agent-runtime'
import { KERNEL_EVENT_SOURCE } from '$lib/kernel/cloudevents'
import type { EngineStreamSinks } from '$lib/kernel/engine'
import { BuiltinJsonLoop, type LlmCompleteFn } from '$lib/kernel/engines/builtin-json'
import { KernelError } from '$lib/kernel/errors'
import { emitKernelEvent, type EventSink } from '$lib/kernel/events'
import type { Brain, TelegramSessionRef } from '$lib/kernel/gateway'
import {
  cloneJourneyState,
  initialJourneyState,
  journeyContextFor,
  journeyStepsCapturedIn,
  stripJourneyMarkers,
  type JourneyRow,
  type JourneySpec,
  type JourneyState,
  type JourneyStore,
} from '$lib/kernel/playbook'
import type { KernelRegistry } from '$lib/kernel/registry'
import type { AgentSessionLog } from '$lib/kernel/session-log'

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
 * The website-founding journey: "i need a website" → tone-of-voice Q&A →
 * brand artifact → site skeleton → publish (owner-approval gated).
 * Declarative, versioned data on the kernel playbook primitive; artifact
 * tools execute through the kernel registry under ORCHESTRATOR_PRINCIPAL.
 *
 * Deterministic protocol (no string heuristics for meaning — these are exact
 * protocol tokens the agent is instructed to emit, never user-text
 * classification):
 * - START: the persona quotes the openingQuestion verbatim; the journey row is
 *   created when a reply contains it.
 * - STEP CAPTURE: the agent appends `[[journey:<id>:captured]]` from the
 *   context block's protocol line; the driver strips the markers and advances.
 */
export const WEBSITE_FOUNDING_JOURNEY: JourneySpec = {
  kind: 'website_founding',
  openingQuestion:
    'Before I build anything: which three words should describe your company’s tone of voice?',
  steps: [
    {
      id: 'tone',
      promptFragment:
        'Collect the company’s tone of voice — three words the user gives (or confirms) count as captured.',
    },
    {
      id: 'company_name',
      promptFragment: 'Ask for the company name (one short answer).',
      artifacts: [
        {
          tool: 'website.create_page',
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
    {
      id: 'positioning',
      promptFragment: 'Ask for a one-sentence description of what the company does.',
      artifacts: [
        {
          tool: 'website.create_page',
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
          inputFromState: () => ({ slug: 'home', visibility: 'public' }),
        },
        {
          tool: 'website.publish_page',
          inputFromState: () => ({ slug: 'about', visibility: 'public' }),
        },
        {
          tool: 'website.publish_page',
          inputFromState: () => ({ slug: 'contact', visibility: 'public' }),
        },
      ],
    },
  ],
}

/**
 * Onboarding journey seed (nucleus): founding-shaped requests open the brand
 * journey. The opening question is quoted VERBATIM — the journey driver
 * creates the journey row when a reply contains it (deterministic marker).
 */
export const ORCHESTRATOR_JOURNEY_PROMPT = [
  'JOURNEY — founding requests: when the company has no brand or website content yet and the user asks for a website or anything founding-shaped (brand, naming, site, launch), open the brand journey.',
  'Acknowledge what they asked for in one short line, then ask for the brand’s tone of voice FIRST — ask exactly this question, word for word:',
  `"${WEBSITE_FOUNDING_JOURNEY.openingQuestion}"`,
  'One question at a time, conversational, no lists unless asked. Do not front-load later steps — the journey deepens as it goes.',
  'When a journey context block gives you a step-capture marker protocol and the step’s answer is captured, append exactly that marker as the final line of your reply. Never show or mention markers to the user.',
].join('\n')

/** Persona preamble handed to the builtin-json engine as its system prompt. */
export const ORCHESTRATOR_PERSONA_PROMPT = [
  'You are the orchestrator: the general assistant of this company.',
  'You can act through kernel tools. Every tool call is permission-checked, audited, and (for external actions) gated behind owner approval.',
  ORCHESTRATOR_JOURNEY_PROMPT,
].join('\n')

/** The orchestrator as harness config: zero code privilege, full harness inherited. */
export function orchestratorAgentConfig(options: { spendCapUsd?: number } = {}): AgentConfig {
  return {
    id: ORCHESTRATOR_AGENT_ID,
    personaName: 'Orchestrator',
    description:
      'The company general assistant: executes kernel tools on behalf of gateway users.',
    loopEngine: 'builtin-json',
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
}

/**
 * Journey driver around the harness dispatch. Subclass by design: the chatbox
 * (src/routes/api/chat) and the Telegram brain both dispatch through
 * runtime.dispatch for the orchestrator agent — this is the one seam where
 * per-dispatch journey context enters WITHOUT touching kernel engine files.
 * For every OTHER agent it is pure passthrough.
 *
 * Deterministic seam (documented):
 * - START: no active journey + reply contains spec.openingQuestion → create
 *   the journey row (lazy; the persona asks the question verbatim).
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

  constructor(options: JourneyAwareRuntimeOptions) {
    super(options)
    this.journeys = options.journeys
    this.spec = options.spec
    this.kernelRegistry = options.registry
    this.kernelEventSink = options.eventSink
  }

  override async dispatch(
    agentId: string,
    sessionId: string,
    input: string,
    sinks?: EngineStreamSinks,
  ): Promise<string> {
    if (agentId !== ORCHESTRATOR_AGENT_ID) {
      return super.dispatch(agentId, sessionId, input, sinks)
    }

    const row = await this.journeys.getActive(this.spec.kind)
    if (!row) {
      const reply = await super.dispatch(agentId, sessionId, input, sinks)
      return this.maybeOpenJourney(sessionId, reply)
    }
    return this.dispatchJourneyTurn(row, agentId, sessionId, input, sinks)
  }

  /** Lazy, deterministic journey start: the opening question IS the marker. */
  private async maybeOpenJourney(sessionId: string, reply: string): Promise<string> {
    if (!reply.includes(this.spec.openingQuestion)) return reply
    await this.journeys.create(this.spec.kind, initialJourneyState(sessionId))
    return reply
  }

  private async dispatchJourneyTurn(
    row: JourneyRow,
    agentId: string,
    sessionId: string,
    input: string,
    sinks?: EngineStreamSinks,
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
   * Executes pending step artifacts in spec order via the kernel registry
   * (ORCHESTRATOR_PRINCIPAL; approvals + audit apply there). 'approval_pending'
   * ledger entries retry on every later turn until the owner decides. The
   * batch stops at the first open gate — later artifacts retry next turn.
   */
  private async runStepArtifacts(
    state: JourneyState,
    sinks?: EngineStreamSinks,
  ): Promise<{ allExecuted: boolean; newlyPending: boolean }> {
    const requestId = randomUUID()
    let newlyPending = false

    for (const step of this.spec.steps) {
      if (!state.captured.includes(step.id) || !step.artifacts) continue
      for (let index = 0; index < step.artifacts.length; index++) {
        const artifact = step.artifacts[index]!
        const alreadyExecuted = state.artifacts.some(
          (r) => r.stepId === step.id && r.index === index && r.status === 'executed',
        )
        if (alreadyExecuted) continue
        try {
          await this.kernelRegistry.execute(
            artifact.tool,
            artifact.inputFromState(state),
            { principal: ORCHESTRATOR_PRINCIPAL, requestId },
          )
          this.recordArtifact(state, step.id, index, artifact.tool, 'executed')
        } catch (err) {
          if (err instanceof KernelError && err.code === 'approval_required') {
            this.recordArtifact(state, step.id, index, artifact.tool, 'approval_pending')
            newlyPending = true
            this.emitSurfaceEvent(sinks, artifact.tool)
            break
          }
          throw err
        }
      }
    }

    const allExecuted = this.spec.steps.every((step) =>
      (step.artifacts ?? []).every((_artifact, index) =>
        state.artifacts.some(
          (r) => r.stepId === step.id && r.index === index && r.status === 'executed',
        ),
      ),
    )
    return { allExecuted, newlyPending }
  }

  private recordArtifact(
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

  private emitSurfaceEvent(sinks: EngineStreamSinks | undefined, tool: string): void {
    if (!sinks?.surfaceEvent) return
    try {
      sinks.surfaceEvent({ type: 'approval.required', tool })
    } catch {
      // best-effort channel — the gate state is already in the ledger
    }
  }
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
    return this.runtime.dispatch(ORCHESTRATOR_AGENT_ID, session.sessionId, text)
  }

  /**
   * The fail-closed tool surface the agent is offered right now (activation ∩
   * scope ∩ role filtered by the runtime) — parity with the pre-harness brain.
   */
  async offeredTools(): Promise<Array<{ name: string }>> {
    return this.runtime.listAgentTools(ORCHESTRATOR_AGENT_ID)
  }
}
