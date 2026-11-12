import { randomUUID } from 'node:crypto'
import type { AgentConfig } from '$lib/kernel/agent'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import type { AgentRuntimeOptions, DispatchOptions } from '$lib/kernel/agent-runtime'
import { KERNEL_EVENT_SOURCE } from '$lib/kernel/cloudevents'
import type { EngineStreamSinks, EngineSurfaceEvent } from '$lib/kernel/engine'
import { approvalIdFromError, toolErrorResult, type ToolErrorResult } from '$lib/kernel/engines/tool-error'
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
import { disciplineSections } from './discipline'
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
/**
 * The orchestrator fixes what it can before anything reaches the user: a
 * journey artifact whose module was never switched on (a fresh server) gets that
 * module activated through the audited, permissioned kernel.module_activate
 * tool (keyed on the structured KernelError code + details.module, never the
 * message), then the call is retried ONCE. Any other error — or a second
 * failure — still fails loud.
 */
async function executeRemediatingInactiveModule(
  registry: KernelRegistry,
  tool: string,
  input: unknown,
  ctx: { principal: JourneyArtifactPrincipal; requestId: string },
): Promise<unknown> {
  try {
    return await registry.execute(tool, input, ctx)
  } catch (err) {
    const moduleId = err instanceof KernelError ? err.details?.module : undefined
    // Only a module that was never switched on: one a person switched off stays
    // off (owner, 2026-11-12) — the error reaches the model, which tells them.
    if (
      !(err instanceof KernelError) ||
      err.code !== 'module_inactive' ||
      typeof moduleId !== 'string' ||
      err.details?.switchedOff !== false
    ) {
      throw err
    }
    await registry.execute('kernel.module_activate', { module_id: moduleId }, ctx)
    return registry.execute(tool, input, ctx)
  }
}

async function listPagesViaRegistry(
  registry: KernelRegistry,
  ctx: { principal: JourneyArtifactPrincipal; requestId: string },
): Promise<Array<{ slug: string; visibility: string }>> {
  const rows = await executeRemediatingInactiveModule(registry, 'website.list_pages', {}, ctx)
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

/**
 * Tool-error self-repair: a failed tool call comes back as a structured
 * {status:'error'} result (src/lib/kernel/engines/tool-error.ts). The agent
 * fixes what it can; the user hears only what it cannot fix.
 */
export const ORCHESTRATOR_TOOL_ERROR_PROMPT = [
  'TOOL ERRORS: when a tool returns {"status":"error"}, try to fix it yourself first — if it carries a remediation, call that tool (e.g. kernel.module_activate for a module that was never switched on), correct your arguments if they were invalid, then retry. Use kernel.module_list to see which modules exist and which are active (tools of inactive modules are not offered until activated).',
  'SWITCHED-OFF PLUGINS: never switch back on a plugin a person switched off — a module_inactive error with "switchedOff":true (or a module_list entry a person switched off). Tell the person plainly that it is switched off and that the owner or an admin can switch it on in Settings → Plugins; do not call kernel.module_activate for it.',
  'Only tell the user when you cannot fix it, in plain language — never internal error codes, tool names, or raw messages.',
].join('\n')

/** Persona preamble handed to the durable engine as the orchestrator's system prompt. */
export const ORCHESTRATOR_PERSONA_PROMPT = [
  'You are the orchestrator: the general assistant of this company.',
  'You can act through kernel tools. Every tool call is permission-checked, audited, and (for external actions) gated behind owner approval.',
  'ORCHESTRATOR POSTURE — you route, you do not interview:',
  '- The chat is mission control, not a questionnaire. Never walk the human through a multi-step intake (founding questions, branding extraction, provider setup) in conversation; those live in their own surfaces (welcome wizard, /brand, /settings).',
  '- Know what the company CAN do — name the modules (website, email, brand, memory, chat-gateway, recap), say in one line what each does, and offer the relevant one. Your own repo and roadmap tools are not modules to offer.',
  '- When a request belongs to a module, say so and hand off: point at its surface or offer to run its kernel tools — do not silently start doing a module’s job in general chat.',
  '- Answer anything directly that needs no module (questions, status, small talk, quick kernel lookups).',
  '- WHERE IS IT: when the owner asks where the website, a page or another result is, call the tool that locates it (website.site_info for the website) and give the link. Never tell them to set up a domain unless they ask about going public on their own domain.',
  ORCHESTRATOR_TOOL_ERROR_PROMPT,
  ORCHESTRATOR_JOURNEY_PROMPT,
  ORCHESTRATOR_ONBOARDING_PROMPT,
  ...disciplineSections(),
].join('\n')

/** The orchestrator as harness config: zero code privilege, full harness inherited. */
export function orchestratorAgentConfig(options: { spendCapUsd?: number } = {}): AgentConfig {
  return {
    id: ORCHESTRATOR_AGENT_ID,
    personaName: 'Orchestrator',
    description:
      'The company general assistant: executes kernel tools on behalf of gateway users.',
    loopEngine: 'durable',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    ...(options.spendCapUsd === undefined ? {} : { spendCapUsd: options.spendCapUsd }),
    enabled: true,
  }
}

const JOURNEY_CONTEXT_SEPARATOR = '\n\n---\n\n'

/**
 * THE BOUNDARY (code <-> harness <-> user): application failures anywhere in
 * an orchestrator turn — journey step tools, journey/onboarding reads and
 * writes, the hand-off precondition — are handed to the agent as this
 * observation block (structured ToolErrorResult entries), never thrown to the
 * route. Only a failure of the harness/LLM itself ends the turn without the
 * agent (the chat entry then shows one fixed human message).
 */
export const HARNESS_OBSERVATION_HEADER =
  '[harness observation — application steps of this turn failed; this is not user speech]'

export function harnessObservationBlock(failures: ToolErrorResult[]): string {
  return [
    HARNESS_OBSERVATION_HEADER,
    'Fix it yourself if you can (call the remediation tool, e.g. kernel.module_activate; use kernel.module_list to inspect modules), otherwise explain to the user in plain language what did not work and what happens next. Journey steps retry automatically on the next turn. Never show error codes, tool names, or raw messages to the user.',
    ...failures.map((failure) => JSON.stringify(failure)),
  ].join('\n')
}
const JOURNEY_APPROVAL_NOTE =
  '\n\n(Website publishing needs owner approval — the request is queued; it completes once the owner approves.)'

export type JourneyAwareRuntimeOptions = AgentRuntimeOptions & {
  journeys: JourneyStore
  spec: JourneySpec
  /** Assisted-onboarding facts for the conversing human (boot wires the DB). Absent = never active. */
  onboardingFacts?: OnboardingFactsResolver
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
 *   other artifact error is handed back to the agent (harnessObservationBlock)
 *   for one more model step — it fixes, retries, or explains. Nothing of the
 *   application reaches the route as an exception; only the engine (harness /
 *   LLM) itself can still reject.
 * - COMPLETION: all steps captured + all artifacts executed → status
 *   'completed' + a `journey.completed` kernel event (metadata only).
 */
export class JourneyAwareAgentRuntime extends AgentRuntime {
  private readonly journeys: JourneyStore
  private readonly spec: JourneySpec
  private readonly kernelRegistry: KernelRegistry
  private readonly kernelEventSink: EventSink
  private readonly onboardingFacts: OnboardingFactsResolver | undefined

  constructor(options: JourneyAwareRuntimeOptions) {
    super(options)
    this.journeys = options.journeys
    this.spec = options.spec
    this.kernelRegistry = options.registry
    this.kernelEventSink = options.eventSink
    this.onboardingFacts = options.onboardingFacts
  }

  /**
   * The assisted-onboarding hand-off: the orchestrator's FIRST turn after the
   * scripted setup, generated by the agent from the onboarding context block
   * plus the hand-off instruction (no user speech). The hand-off request IS
   * the signal that the scripted setup ended (the welcome wizard persists its
   * stamp concurrently), so only the website state gates it. When there is
   * nothing to hand off (e.g. the website is already under way) that
   * precondition is handed to the AGENT as an observation — it greets the
   * owner from where they are; nothing reaches the user as an error.
   */
  async dispatchOnboardingHandoff(
    sessionId: string,
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
  ): Promise<string> {
    const failures: ToolErrorResult[] = []
    const resolved = this.onboardingFacts
      ? await this.attempt(failures, 'onboarding.facts', () => this.onboardingFacts!(options?.llmUserId))
      : { ok: true as const, value: null }
    const facts = resolved.ok && resolved.value ? { ...resolved.value, welcomeCompleted: true } : null
    if (facts && assistedOnboardingActive(facts)) {
      return this.dispatchOnboardingTurn(facts, sessionId, ONBOARDING_HANDOFF_INSTRUCTION, '', sinks, options)
    }
    if (resolved.ok) {
      failures.push({
        status: 'error',
        tool: 'onboarding.handoff',
        code: 'onboarding_inactive',
        message:
          'the app asked for the onboarding hand-off greeting, but assisted onboarding is not active for this owner',
        details: { website: facts?.website ?? null },
      })
    }
    return this.dispatchObserved(
      ORCHESTRATOR_AGENT_ID,
      sessionId,
      failures,
      'The owner just opened the chat (no user speech). Greet them briefly and continue from where they are.',
      sinks,
      options,
      '',
    )
  }

  /**
   * Runs one application step of the turn. A failure is recorded as a
   * structured observation for the agent (never rethrown to the route).
   */
  private async attempt<T>(
    failures: ToolErrorResult[],
    label: string,
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      return { ok: true, value: await fn() }
    } catch (err) {
      failures.push(toolErrorResult(label, err))
      return { ok: false }
    }
  }

  /** A turn whose input carries the application failures as a harness observation. */
  private async dispatchObserved(
    agentId: string,
    sessionId: string,
    failures: ToolErrorResult[],
    input: string,
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
    ownerText: string = input,
  ): Promise<string> {
    const reply = await super.dispatch(
      agentId,
      sessionId,
      `${harnessObservationBlock(failures)}${JOURNEY_CONTEXT_SEPARATOR}${input}`,
      sinks,
      { ...options, ownerText },
    )
    return this.userFacing(reply)
  }

  /**
   * One more model step after the agent replied, when application code of the
   * turn failed: the agent sees the failures and fixes, retries, or explains.
   * Its reply replaces the first one (which may claim a success that did not
   * happen).
   */
  private async followUp(
    agentId: string,
    sessionId: string,
    failures: ToolErrorResult[],
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
  ): Promise<string> {
    const reply = await super.dispatch(
      agentId,
      sessionId,
      harnessObservationBlock(failures),
      sinks,
      // App-made step: no owner words in this input.
      { ...options, ownerText: '' },
    )
    return this.userFacing(reply)
  }

  private userFacing(reply: string): string {
    return stripJourneyMarkers(stripOnboardingMarkers(reply), this.spec)
  }

  private async dispatchOnboardingTurn(
    facts: OnboardingFacts,
    sessionId: string,
    input: string,
    /** The owner's own words in `input` ('' for the app-made hand-off turn). */
    ownerText: string,
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
      { ...options, ownerText },
    )
    // The agent decided the owner agreed (exact protocol token only): the
    // website journey opens EMPTY — the agreement is not an answer.
    if (replyStartsWebsite(reply)) {
      const failures: ToolErrorResult[] = []
      await this.attempt(failures, 'journey.open', async () => {
        if (!(await this.journeys.getActive(this.spec.kind))) {
          await this.journeys.create(this.spec.kind, initialJourneyState(sessionId, this.spec.specVersion))
        }
      })
      if (failures.length > 0) {
        return this.followUp(ORCHESTRATOR_AGENT_ID, sessionId, failures, sinks, options)
      }
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

    const failures: ToolErrorResult[] = []
    const active = await this.attempt(failures, 'journey.load', () => this.journeys.getActive(this.spec.kind))
    if (!active.ok) return this.dispatchObserved(agentId, sessionId, failures, input, sinks, options)
    const row = active.value
    // No journey → assisted onboarding (agent-opened journey via the exact
    // start marker) while it is active, else a plain orchestrator turn.
    if (!row) {
      const facts = await this.attempt(failures, 'onboarding.facts', () =>
        this.activeOnboardingFacts(options?.llmUserId),
      )
      if (!facts.ok) return this.dispatchObserved(agentId, sessionId, failures, input, sinks, options)
      if (facts.value) return this.dispatchOnboardingTurn(facts.value, sessionId, input, input, sinks, options)
      return super.dispatch(agentId, sessionId, input, sinks, options)
    }
    // Stale spec: the stored journey predates the current spec shape (v1 /
    // pre-versioning rows). Abandon it — a superseded interview must never
    // drive the conversation — and answer as the plain orchestrator.
    if (isStaleJourney(this.spec, row)) {
      await this.attempt(failures, 'journey.abandon', async () => {
        await this.journeys.updateState(row.id, row.state, 'abandoned')
        await emitKernelEvent(this.kernelEventSink, {
          type: 'journey.abandoned',
          principalId: ORCHESTRATOR_AGENT_ID,
          source: KERNEL_EVENT_SOURCE,
          payload: { journeyId: row.id, kind: row.kind, reason: 'spec_version' },
        })
      })
      if (failures.length > 0) return this.dispatchObserved(agentId, sessionId, failures, input, sinks, options)
      return super.dispatch(agentId, sessionId, input, sinks, options)
    }
    return this.dispatchJourneyTurn(row, agentId, sessionId, input, sinks, options)
  }

  private async activeOnboardingFacts(llmUserId: string | undefined): Promise<OnboardingFacts | null> {
    if (!this.onboardingFacts) return null
    const facts = await this.onboardingFacts(llmUserId)
    return facts && assistedOnboardingActive(facts) ? facts : null
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
      { ...options, ownerText: input },
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

    const { allExecuted, newlyPending, failures } = await this.runStepArtifacts(state, sinks)

    const allCaptured = this.spec.steps.every((step) => state.captured.includes(step.id))
    await this.attempt(failures, 'journey.save', async () => {
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
    })

    // Application failures of the step go back to the agent for one more
    // model step: it fixes, retries, or explains — the route never sees them.
    const finalReply =
      failures.length > 0 ? await this.followUp(agentId, sessionId, failures, sinks, options) : cleanReply

    // On surfaces without a structured sink (Telegram), say the gate in text;
    // chatbox surfaces get the approval.required surface event instead.
    if (newlyPending && !sinks?.surfaceEvent) return `${finalReply}${JOURNEY_APPROVAL_NOTE}`
    return finalReply
  }

  /**
   * Delegates to the shared artifact executor — one artifact semantics for
   * both entry points (chat driver + onboarding founding endpoint).
   */
  private runStepArtifacts(
    state: JourneyState,
    sinks?: EngineStreamSinks,
  ): Promise<StepArtifactsResult> {
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
 * other error (including one from the already-applied probe) stops the whole
 * batch and is RETURNED as a structured failure (ToolErrorResult shape) —
 * never thrown. The chat driver hands it back into the agent's turn; the
 * onboarding endpoint fails loud on it (code <-> harness <-> user).
 */
export type StepArtifactsResult = {
  allExecuted: boolean
  newlyPending: boolean
  failures: ToolErrorResult[]
}

export async function executeStepArtifacts(options: {
  registry: KernelRegistry
  spec: JourneySpec
  state: JourneyState
  /** Optional surface sink for approval gates (chat streams); best-effort. */
  surfaceEvent?: (event: EngineSurfaceEvent) => void
}): Promise<StepArtifactsResult> {
  const { registry, spec, state } = options
  const requestId = randomUUID()
  let newlyPending = false
  const failures: ToolErrorResult[] = []

  steps: for (const step of spec.steps) {
    if (!state.captured.includes(step.id) || !step.artifacts) continue
    for (let index = 0; index < step.artifacts.length; index++) {
      const artifact = step.artifacts[index]!
      const alreadyExecuted = state.artifacts.some(
        (r) => r.stepId === step.id && r.index === index && r.status === 'executed',
      )
      if (alreadyExecuted) continue
      const input = artifact.inputFromState(state)
      try {
        if (
          artifact.alreadyApplied &&
          (await artifact.alreadyApplied({
            input,
            registry,
            principal: ORCHESTRATOR_PRINCIPAL,
            requestId,
          }))
        ) {
          recordArtifact(state, step.id, index, artifact.tool, 'executed')
          continue
        }
        await executeRemediatingInactiveModule(
          registry,
          artifact.tool,
          input,
          { principal: ORCHESTRATOR_PRINCIPAL, requestId },
        )
        recordArtifact(state, step.id, index, artifact.tool, 'executed')
      } catch (err) {
        if (err instanceof KernelError && err.code === 'approval_required') {
          recordArtifact(state, step.id, index, artifact.tool, 'approval_pending')
          newlyPending = true
          const approvalId = approvalIdFromError(err)
          try {
            options.surfaceEvent?.({ type: 'approval.required', tool: artifact.tool, approvalId })
          } catch {
            // best-effort channel — the gate state is already in the ledger
          }
          break
        }
        failures.push(toolErrorResult(artifact.tool, err))
        break steps
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
  return { allExecuted, newlyPending, failures }
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
