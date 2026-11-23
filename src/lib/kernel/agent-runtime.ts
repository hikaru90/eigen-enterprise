import type { AgentActsAsSelf, AgentConfig, AgentSummary, CoworkerSource, LoopEngineId } from './agent'
import type { EngineContext, EngineStreamSinks, EngineToolListing, LoopEngine, RunInstructions } from './engine'
import type { KernelRegistry } from './registry'
import type { ToolPrincipal } from './types'
import { randomUUID } from 'node:crypto'
import { KERNEL_EVENT_SOURCE } from './cloudevents'
import { KernelError } from './errors'
import { emitKernelEvent, type EventSink, type KernelEvent } from './events'
import { toolInputJsonSchema } from './openapi'
import { BRAIN_VIA, delegatedPrincipal, requirePerson, type PersonRef } from './principals'
import { selectToolSurface } from './tool-surface'

/**
 * The harness: hosts agents as config (plan/phase-1b-harness.md). The runtime
 * provides what an agent must never rebuild — sessions, the fail-closed tool
 * surface (registry ∩ activation ∩ scope ∩ roles), the kernel execution path,
 * the event stream, and spend-cap enforcement — and delegates the loop itself
 * to the configured LoopEngine. All collaborators are constructor-injected.
 */

/**
 * Per-dispatch options beyond sinks. Every dispatch names its PERSON: the
 * company brain always acts as a specific person (plan/phase-company-brain.md
 * §7, CB3) — in chat the person asking, in the background the person the event
 * concerns. Their id and roles become the run's delegated principal (permission,
 * tool surface, row-level security, approvals, audit) and their gateway
 * identity pays for the run's model calls. No person, no run.
 */
export type DispatchOptions = {
  /** The person this turn acts as (src/lib/server/auth/people.ts personFor). Required. */
  person: PersonRef
  /**
   * Engine for THIS dispatch, overriding agent.loopEngine — set by a caller
   * that made an explicit, recorded choice (the orchestrator's per-provider
   * engine). Must be registered; fails loud otherwise.
   */
  loopEngine?: LoopEngineId
  /**
   * The owner's own words of this turn, when the caller composed `input` from
   * injected context (onboarding / journey / observation blocks) plus them.
   * Run feeds show this instead of the composed input. Absent: the whole input
   * is the owner's; '' : the turn carries no owner words (an app-made turn).
   */
  ownerText?: string
  /**
   * The member turn this dispatch belongs to (the chat's user message id).
   * Every dispatch of one turn (follow-ups included) passes the same id, so
   * edit-and-resend can supersede the whole turn (supersedeTurn).
   */
  turnId?: string
}

/**
 * Per-dispatch options for an agent that acts as ITSELF (AgentConfig.actsAs.kind 'self', an AI
 * co-worker): no person — the run's identity is the agent's own principal.
 */
export type DispatchAsAgentOptions = {
  /** Who asked for this turn (a member id, another co-worker's id); metadata for events and the prompt. */
  requestedBy?: string
  /** Engine for THIS dispatch, overriding agent.loopEngine (must be registered; fails loud otherwise). */
  loopEngine?: LoopEngineId
  /** The words of this turn when `input` was composed with injected context (see DispatchOptions.ownerText). */
  ownerText?: string
  /** The turn this dispatch belongs to (see DispatchOptions.turnId). */
  turnId?: string
}

/** What loadAgents changed, by agent id (sorted). */
export type LoadAgentsResult = {
  registered: string[]
  replaced: string[]
  unregistered: string[]
}

/** What a meta tool call runs with: the run's principal, its request id, the agent's tool scope. */
export type AgentMetaToolContext = {
  principal: ToolPrincipal
  requestId: string
  toolScope: AgentConfig['toolScope']
}

/**
 * A harness-level tool an agent is offered next to its registry tools — not
 * a company action itself, but a way to reach them (the brain's `ee` CLI
 * tool, src/cli/brain-tool.ts). It runs with the run's delegated person and
 * must reach company actions only through KernelRegistry.execute (the same
 * gates as a direct call). Its name may not shadow a registry tool.
 */
export type AgentMetaTool = {
  listing: EngineToolListing
  execute(input: unknown, ctx: AgentMetaToolContext): Promise<unknown>
}

export type AgentRuntimeOptions = {
  registry: KernelRegistry
  /** Module activation gate; wire to ModuleRegistry.isToolActive (fail closed). */
  isToolActive: (toolName: string) => Promise<boolean>
  eventSink: EventSink
  /** Initial engine map; more engines can be added via registerEngine. */
  engines?: Map<LoopEngineId, LoopEngine>
  /**
   * Spend source of truth. Default: a per-runtime in-memory accumulator fed by
   * recordSpend(agentId, usd). Gateway-cost wiring (querying accumulated cost
   * for the agent principal from the LLM gateway) is a documented follow-up —
   * no per-principal cost query exists in src/lib/server/llm today.
   */
  spendFn?: (agentId: string) => number
  /**
   * The real ledger for agents that act as themselves: what the user id's model calls cost
   * since the start of today (UTC), summed from the gateway's cost log (activity_call_log).
   * Production: src/lib/server/agent/ledger-spend.ts. Required before a self-acting agent can
   * be registered (fails loud otherwise); person-acting agents never read it.
   */
  spentUsdToday?: (userId: string) => Promise<number>
  /** Meta tools offered on every agent's surface after its registry tools (production: the ee CLI tool). */
  metaTools?: AgentMetaTool[]
}

/** Who one run acts as, resolved before the engine starts. */
type RunIdentity = {
  principal: ToolPrincipal
  /** Who the run's events are recorded under. */
  eventPrincipalId: string
  /** Who the run's model calls are billed to. */
  llmUserId: string
  spendUsd: () => number
  requestedBy?: string
}

/** Provenance on harness events: the person is principalId, the brain carried the turn. */
const VIA_BRAIN = { via: BRAIN_VIA } as const

/**
 * Harness events: agent.dispatched / agent.replied / agent.stopped /
 * agent.budget_exceeded / agent.turn_superseded (audit only; the activity
 * feed and recap whitelists do not show it). Payloads carry metadata only —
 * NEVER message or reply content.
 */

export class AgentRuntime {
  private readonly registry: KernelRegistry
  private readonly isToolActive: (toolName: string) => Promise<boolean>
  private readonly eventSink: EventSink
  private readonly engines: Map<LoopEngineId, LoopEngine>
  private readonly spendFn: ((agentId: string) => number) | undefined
  private readonly spentUsdToday: ((userId: string) => Promise<number>) | undefined
  private readonly metaTools: AgentMetaTool[]
  private readonly agents = new Map<string, AgentConfig>()
  /** Default spend accumulator (used when no spendFn is injected). */
  private readonly spendUsdByAgent = new Map<string, number>()
  /** The agent ids each source last loaded (loadAgents keeps exactly that set). */
  private readonly sourced = new Map<CoworkerSource, Set<string>>()

  constructor(options: AgentRuntimeOptions) {
    this.registry = options.registry
    this.isToolActive = options.isToolActive
    this.eventSink = options.eventSink
    this.engines = options.engines ?? new Map()
    this.spendFn = options.spendFn
    this.spentUsdToday = options.spentUsdToday
    this.metaTools = [...(options.metaTools ?? [])]
  }

  /** Register an agent config; duplicate ids and malformed configs fail loud. */
  registerAgent(config: AgentConfig): void {
    if (this.agents.has(config.id)) {
      throw new KernelError('duplicate_agent', `agent already registered: ${config.id}`)
    }
    this.assertRegistrable(config)
    this.agents.set(config.id, { ...config })
  }

  /** Replace a registered agent's config (its next dispatch uses it); an unknown id fails loud. */
  replaceAgent(config: AgentConfig): void {
    this.requireAgent(config.id)
    this.assertRegistrable(config)
    this.agents.set(config.id, { ...config })
  }

  /** Remove a registered agent (new dispatches fail with unknown_agent); an unknown id fails loud. */
  unregisterAgent(id: string): void {
    this.requireAgent(id)
    this.agents.delete(id)
    for (const ids of this.sourced.values()) ids.delete(id)
  }

  /**
   * (Re)load a source's agents (e.g. the company's enabled AI co-workers): registers new ones,
   * replaces the ones it loaded before, unregisters the ones it no longer lists. It never
   * touches an agent registered another way (an id the source does not own fails loud) and
   * changes nothing when any config is refused.
   */
  async loadAgents(source: CoworkerSource): Promise<LoadAgentsResult> {
    const configs = await source.listAgentConfigs()
    const owned = this.sourced.get(source) ?? new Set<string>()
    const listed = new Set<string>()
    for (const config of configs) {
      if (listed.has(config.id)) {
        throw new KernelError('duplicate_agent', `agent source lists ${config.id} twice`)
      }
      listed.add(config.id)
      if (this.agents.has(config.id) && !owned.has(config.id)) {
        throw new KernelError(
          'duplicate_agent',
          `agent ${config.id} is already registered outside this agent source; a source never takes over another agent`,
        )
      }
      this.assertRegistrable(config)
    }
    const result: LoadAgentsResult = { registered: [], replaced: [], unregistered: [] }
    for (const config of configs) {
      ;(this.agents.has(config.id) ? result.replaced : result.registered).push(config.id)
      this.agents.set(config.id, { ...config })
    }
    for (const id of owned) {
      if (listed.has(id)) continue
      this.agents.delete(id)
      result.unregistered.push(id)
    }
    this.sourced.set(source, listed)
    result.registered.sort()
    result.replaced.sort()
    result.unregistered.sort()
    return result
  }

  listAgents(): AgentConfig[] {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  /** The serializable view of every agent (agent.list): who it acts as and whose prompt, no functions. */
  describeAgents(): AgentSummary[] {
    return this.listAgents().map((agent) => {
      const { instructions, actsAs, ...rest } = agent
      return {
        ...rest,
        instructions: instructions === 'engine-default' ? 'engine-default' : 'own',
        ...(actsAs === 'person' ? { actsAs: 'person' } : { actsAs: 'self', dailySpendCapUsd: actsAs.dailySpendCapUsd }),
      }
    })
  }

  getAgent(id: string): AgentConfig | undefined {
    return this.agents.get(id)
  }

  enable(id: string): void {
    this.requireAgent(id).enabled = true
  }

  disable(id: string): void {
    this.requireAgent(id).enabled = false
  }

  registerEngine(id: LoopEngineId, engine: LoopEngine): void {
    if (this.engines.has(id)) {
      throw new KernelError('duplicate_engine', `loop engine already registered: ${id}`)
    }
    this.engines.set(id, engine)
  }

  /**
   * Run one user turn against an agent, as `options.person`. Fails loud on a
   * missing person, unknown/disabled agent, unregistered engine, or exhausted
   * spend cap — never silently degrades. `sinks` are per-request surface sinks
   * passed through to the engine context; the runtime itself never consumes
   * them.
   */
  async dispatch(
    agentId: string,
    sessionId: string,
    input: string,
    sinks: EngineStreamSinks | undefined,
    options: DispatchOptions,
  ): Promise<string> {
    requirePerson(options?.person)
    const person = options.person
    const agent = this.requireAgent(agentId)
    this.requireActsAsPerson(agent)
    if (!agent.enabled) {
      throw new KernelError('agent_disabled', `agent ${agentId} is disabled`)
    }
    const engine = this.requireEngine(agent, options.loopEngine)

    const spendUsd = this.spendFor(agentId)
    if (agent.spendCapUsd !== undefined && spendUsd >= agent.spendCapUsd) {
      await this.emitAgentEvent(person.id, 'agent.budget_exceeded', {
        agentId,
        sessionId,
        spendUsd,
        spendCapUsd: agent.spendCapUsd,
        ...VIA_BRAIN,
      })
      throw new KernelError(
        'budget_exceeded',
        `agent ${agentId} exceeded its spend cap (${spendUsd} >= ${agent.spendCapUsd} USD)`,
      )
    }

    await this.emitAgentEvent(person.id, 'agent.dispatched', { agentId, sessionId, ...VIA_BRAIN })

    const identity = this.personIdentity(agent, person)
    const instructions = await this.resolveInstructions(agent, sessionId, input, identity)
    const ctx = await this.buildContext(agent, identity, instructions, sinks, options)
    const reply = await engine.run(sessionId, input, ctx)

    await this.emitAgentEvent(person.id, 'agent.replied', {
      agentId,
      sessionId,
      replyLength: reply.length,
      ...VIA_BRAIN,
    })
    return reply
  }

  /**
   * Run one turn of an agent that acts as ITSELF (actsAs.kind 'self', an AI co-worker): its
   * principal comes from `actsAs.principalFor`, its tools run as that principal, its model
   * calls are billed to that principal's id, and the run is refused once the cost ledger's sum
   * for that id today (UTC) reaches `actsAs.dailySpendCapUsd`. Fails loud on an unknown or
   * disabled agent, a person-acting agent, an unregistered engine, a malformed principal,
   * empty instructions or an exhausted cap — before the engine runs.
   */
  async dispatchAsAgent(
    agentId: string,
    sessionId: string,
    input: string,
    sinks: EngineStreamSinks | undefined,
    options: DispatchAsAgentOptions,
  ): Promise<string> {
    const agent = this.requireAgent(agentId)
    const self = this.requireActsAsSelf(agent)
    if (!agent.enabled) {
      throw new KernelError('agent_disabled', `agent ${agentId} is disabled`)
    }
    const engine = this.requireEngine(agent, options.loopEngine)
    const principal = await this.selfPrincipal(agent, self, sessionId, options.requestedBy)
    const provenance = {
      actsAs: 'self',
      ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
    }

    const spendUsd = await this.ledgerSpend(principal.id)
    if (spendUsd >= self.dailySpendCapUsd) {
      await this.emitAgentEvent(principal.id, 'agent.budget_exceeded', {
        agentId,
        sessionId,
        spendUsd,
        dailySpendCapUsd: self.dailySpendCapUsd,
        ...provenance,
      })
      throw new KernelError(
        'budget_exceeded',
        `agent ${agentId} reached its daily spend cap (${spendUsd} >= ${self.dailySpendCapUsd} USD today, UTC)`,
      )
    }

    await this.emitAgentEvent(principal.id, 'agent.dispatched', { agentId, sessionId, ...provenance })

    const identity: RunIdentity = {
      principal,
      eventPrincipalId: principal.id,
      llmUserId: principal.id,
      spendUsd: () => spendUsd,
      ...(options.requestedBy === undefined ? {} : { requestedBy: options.requestedBy }),
    }
    const instructions = await this.resolveInstructions(agent, sessionId, input, identity)
    const ctx = await this.buildContext(agent, identity, instructions, sinks, options)
    const reply = await engine.run(sessionId, input, ctx)

    await this.emitAgentEvent(principal.id, 'agent.replied', {
      agentId,
      sessionId,
      replyLength: reply.length,
      ...provenance,
    })
    return reply
  }

  /**
   * Edit-and-resend (board a950ef11): the person replaces their turn `turnId`
   * with `replacementTurnId` — the engine stops it if it still runs and takes
   * it (and everything after it) out of what the model sees; history keeps
   * it. Dispatch the replacement afterwards with `turnId: replacementTurnId`.
   * An engine without supersedeTurn fails loud ('turn_not_editable').
   */
  async supersedeTurn(
    agentId: string,
    sessionId: string,
    turnId: string,
    replacementTurnId: string,
    options: DispatchOptions,
  ): Promise<void> {
    requirePerson(options?.person)
    const agent = this.requireAgent(agentId)
    this.requireActsAsPerson(agent)
    const engineId = options.loopEngine ?? agent.loopEngine
    const engine = this.requireEngine(agent, options.loopEngine)
    if (!engine.supersedeTurn) {
      throw new KernelError(
        'turn_not_editable',
        `loop engine "${engineId}" of agent ${agentId} cannot supersede turns`,
      )
    }
    const identity = this.personIdentity(agent, options.person)
    const instructions = await this.resolveInstructions(agent, sessionId, '', identity)
    const ctx = await this.buildContext(agent, identity, instructions, undefined, {
      ...options,
      turnId: replacementTurnId,
    })
    await engine.supersedeTurn(sessionId, turnId, replacementTurnId, ctx)
    await this.emitAgentEvent(options.person.id, 'agent.turn_superseded', {
      agentId,
      sessionId,
      ...VIA_BRAIN,
    })
  }

  /**
   * v0 stop: marks the agent disabled and emits 'agent.stopped'. True
   * cancellation of an in-flight run is engine-dependent (LoopEngine has no
   * cancel hook yet) — in-flight turns run to completion; only new dispatches
   * are rejected.
   */
  async stop(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId)
    agent.enabled = false
    await this.emitAgentEvent(agent.id, 'agent.stopped', { agentId })
  }

  /** Accumulate spend for an agent on the default in-memory accumulator. */
  recordSpend(agentId: string, usd: number): void {
    this.spendUsdByAgent.set(agentId, (this.spendUsdByAgent.get(agentId) ?? 0) + usd)
  }

  /** The fail-closed tool surface an agent would offer `person` right now (their roles, never more). */
  async listAgentTools(agentId: string, person: PersonRef): Promise<EngineToolListing[]> {
    requirePerson(person)
    const agent = this.requireAgent(agentId)
    this.requireActsAsPerson(agent)
    const ctx = await this.buildContext(agent, this.personIdentity(agent, person), { kind: 'engine-default' })
    return ctx.listTools()
  }

  /**
   * The brain's identity for a run: the person, via this agent. Its tool surface is what the
   * person's roles reach; every call executes as them; they pay for its model calls.
   */
  private personIdentity(agent: AgentConfig, person: PersonRef): RunIdentity {
    return {
      principal: delegatedPrincipal(person, agent.id),
      eventPrincipalId: person.id,
      llmUserId: person.id,
      spendUsd: () => this.spendFor(agent.id),
    }
  }

  /** The self-acting agent's principal for this dispatch, checked: its own id and roles, never via the brain. */
  private async selfPrincipal(
    agent: AgentConfig,
    self: AgentActsAsSelf,
    sessionId: string,
    requestedBy: string | undefined,
  ): Promise<ToolPrincipal> {
    const principal = await self.principalFor({
      agentId: agent.id,
      sessionId,
      ...(requestedBy === undefined ? {} : { requestedBy }),
    })
    if (
      !principal ||
      typeof principal.id !== 'string' ||
      principal.id.trim() === '' ||
      !Array.isArray(principal.roles) ||
      principal.via !== undefined
    ) {
      throw new KernelError(
        'invalid_principal',
        `agent ${agent.id} acts as itself, but its principal factory returned ${principal?.via ? 'a principal carried by the brain' : 'no well-formed principal'} — it must name its own id and roles`,
      )
    }
    return { ...principal, roles: [...principal.roles] }
  }

  /** The run's system prompt: the engine's own, or this agent's, assembled now for this turn. */
  private async resolveInstructions(
    agent: AgentConfig,
    sessionId: string,
    input: string,
    identity: RunIdentity,
  ): Promise<RunInstructions> {
    if (agent.instructions === 'engine-default') return { kind: 'engine-default' }
    if (typeof agent.instructions !== 'function') {
      throw new KernelError(
        'invalid_instructions',
        `agent ${agent.id} declares no instructions: set 'engine-default' or a function that assembles its prompt`,
      )
    }
    const text = await agent.instructions({
      agentId: agent.id,
      sessionId,
      principal: identity.principal,
      input,
      ...(identity.requestedBy === undefined ? {} : { requestedBy: identity.requestedBy }),
    })
    if (typeof text !== 'string' || text.trim() === '') {
      throw new KernelError('invalid_instructions', `agent ${agent.id} assembled empty instructions for this turn`)
    }
    return { kind: 'own', text }
  }

  private async ledgerSpend(userId: string): Promise<number> {
    if (!this.spentUsdToday) {
      throw new KernelError('no_spend_ledger', 'this runtime has no spend ledger (AgentRuntimeOptions.spentUsdToday)')
    }
    const spent = await this.spentUsdToday(userId)
    if (typeof spent !== 'number' || !Number.isFinite(spent) || spent < 0) {
      throw new KernelError('no_spend_ledger', `the spend ledger returned ${JSON.stringify(spent)} for ${userId}; expected a non-negative USD amount`)
    }
    return spent
  }

  private async buildContext(
    agent: AgentConfig,
    identity: RunIdentity,
    instructions: RunInstructions,
    sinks?: EngineStreamSinks,
    options?: { ownerText?: string; turnId?: string },
  ): Promise<EngineContext> {
    // The run's ONLY identity: the person via this agent, or the agent itself.
    const principal = identity.principal
    // One requestId per dispatch: every tool call of this turn shares it.
    const requestId = randomUUID()
    const descriptors = await selectToolSurface(this.registry.list(), {
      isToolActive: this.isToolActive,
      roles: principal.roles,
      toolScope: agent.toolScope,
    })
    const listings: EngineToolListing[] = descriptors.map((tool) => ({
      name: tool.name,
      summary: tool.summary,
      inputJsonSchema: toolInputJsonSchema(tool.inputSchema),
    }))
    const metaByName = new Map<string, AgentMetaTool>()
    for (const meta of this.metaTools) {
      const name = meta.listing.name
      if (this.registry.get(name) !== undefined) {
        throw new KernelError('duplicate_tool', `agent meta tool ${name} shadows the kernel tool ${name}`)
      }
      if (metaByName.has(name)) throw new KernelError('duplicate_tool', `agent meta tool registered twice: ${name}`)
      metaByName.set(name, meta)
      listings.push(meta.listing)
    }
    const metaCtx: AgentMetaToolContext = { principal, requestId, toolScope: agent.toolScope }

    return {
      agent,
      principal,
      instructions,
      executeTool: (name, input) => {
        const meta = metaByName.get(name)
        return meta ? meta.execute(input, metaCtx) : this.registry.execute(name, input, { principal, requestId })
      },
      listTools: () => listings,
      emit: async (event) => {
        await emitKernelEvent(this.eventSink, {
          type: event.type,
          principalId: event.principalId ?? identity.eventPrincipalId,
          source: event.source ?? KERNEL_EVENT_SOURCE,
          payload: event.payload,
        })
      },
      spendUsd: identity.spendUsd,
      // The acting principal's gateway identity pays for (and is attributed) the run's model calls.
      llmUserId: identity.llmUserId,
      ...(options?.ownerText !== undefined ? { ownerText: options.ownerText } : {}),
      ...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
      ...(sinks?.stream ? { stream: sinks.stream } : {}),
      ...(sinks?.surfaceEvent ? { surfaceEvent: sinks.surfaceEvent } : {}),
    }
  }

  private spendFor(agentId: string): number {
    if (this.spendFn) return this.spendFn(agentId)
    return this.spendUsdByAgent.get(agentId) ?? 0
  }

  private requireAgent(id: string): AgentConfig {
    const agent = this.agents.get(id)
    if (!agent) throw new KernelError('unknown_agent', `unknown agent: ${id}`)
    return agent
  }

  private requireEngine(agent: AgentConfig, override: LoopEngineId | undefined): LoopEngine {
    const engineId = override ?? agent.loopEngine
    const engine = this.engines.get(engineId)
    if (!engine) {
      throw new KernelError(
        'unknown_engine',
        `agent ${agent.id} references unregistered loop engine "${engineId}"`,
      )
    }
    return engine
  }

  private requireActsAsPerson(agent: AgentConfig): void {
    if (agent.actsAs !== 'person') {
      throw new KernelError(
        'agent_acts_as_itself',
        `agent ${agent.id} acts as itself, not as a person: dispatch it with dispatchAsAgent`,
      )
    }
  }

  private requireActsAsSelf(agent: AgentConfig): AgentActsAsSelf {
    if (agent.actsAs === 'person') {
      throw new KernelError(
        'agent_acts_as_person',
        `agent ${agent.id} acts as the person it works for: dispatch it with dispatch and that person`,
      )
    }
    return agent.actsAs
  }

  /** A config the runtime can run: declared instructions and identity, one cap, a ledger for self-acting agents. */
  private assertRegistrable(config: AgentConfig): void {
    if (typeof config.id !== 'string' || config.id.trim() === '' || config.id.includes(':')) {
      throw new KernelError(
        'invalid_agent',
        `agent id ${JSON.stringify(config.id)} must be non-empty and hold no ":" (conversation keys are <agentId>:<sessionId>)`,
      )
    }
    if (config.instructions !== 'engine-default' && typeof config.instructions !== 'function') {
      throw new KernelError(
        'invalid_agent',
        `agent ${config.id} declares no instructions: set 'engine-default' or a function that assembles its prompt`,
      )
    }
    if (config.modelId !== undefined && (typeof config.modelId !== 'string' || config.modelId.trim() === '')) {
      throw new KernelError('invalid_agent', `agent ${config.id} names a blank model; leave modelId out to run on the company's chat slot`)
    }
    if (config.actsAs === 'person') return
    if (!config.actsAs || config.actsAs.kind !== 'self' || typeof config.actsAs.principalFor !== 'function') {
      throw new KernelError('invalid_agent', `agent ${config.id} declares no identity: actsAs is 'person' or { kind: 'self', principalFor, dailySpendCapUsd }`)
    }
    const cap = config.actsAs.dailySpendCapUsd
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
      throw new KernelError('invalid_agent', `agent ${config.id} needs a positive daily spend cap in USD (got ${String(cap)})`)
    }
    if (config.spendCapUsd !== undefined) {
      throw new KernelError(
        'invalid_agent',
        `agent ${config.id} acts as itself: its cap is actsAs.dailySpendCapUsd on the cost ledger, not the in-memory spendCapUsd`,
      )
    }
    if (!this.spentUsdToday) {
      throw new KernelError(
        'no_spend_ledger',
        `agent ${config.id} acts as itself, but this runtime has no spend ledger (AgentRuntimeOptions.spentUsdToday) to cap it with`,
      )
    }
  }

  private emitAgentEvent(
    principalId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<KernelEvent> {
    return emitKernelEvent(this.eventSink, {
      type,
      principalId,
      source: KERNEL_EVENT_SOURCE,
      payload,
    })
  }
}
