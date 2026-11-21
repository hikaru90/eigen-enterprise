import type { AgentConfig, LoopEngineId } from './agent'
import type { EngineContext, EngineStreamSinks, EngineToolListing, LoopEngine } from './engine'
import type { KernelRegistry } from './registry'
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
  private readonly agents = new Map<string, AgentConfig>()
  /** Default spend accumulator (used when no spendFn is injected). */
  private readonly spendUsdByAgent = new Map<string, number>()

  constructor(options: AgentRuntimeOptions) {
    this.registry = options.registry
    this.isToolActive = options.isToolActive
    this.eventSink = options.eventSink
    this.engines = options.engines ?? new Map()
    this.spendFn = options.spendFn
  }

  /** Register an agent config; duplicate ids fail loud. */
  registerAgent(config: AgentConfig): void {
    if (this.agents.has(config.id)) {
      throw new KernelError('duplicate_agent', `agent already registered: ${config.id}`)
    }
    this.agents.set(config.id, { ...config })
  }

  listAgents(): AgentConfig[] {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id))
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
    if (!agent.enabled) {
      throw new KernelError('agent_disabled', `agent ${agentId} is disabled`)
    }
    const engineId = options.loopEngine ?? agent.loopEngine
    const engine = this.engines.get(engineId)
    if (!engine) {
      throw new KernelError(
        'unknown_engine',
        `agent ${agentId} references unregistered loop engine "${engineId}"`,
      )
    }

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

    const ctx = await this.buildContext(agent, person, sinks, options)
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
    const engineId = options.loopEngine ?? agent.loopEngine
    const engine = this.engines.get(engineId)
    if (!engine) {
      throw new KernelError(
        'unknown_engine',
        `agent ${agentId} references unregistered loop engine "${engineId}"`,
      )
    }
    if (!engine.supersedeTurn) {
      throw new KernelError(
        'turn_not_editable',
        `loop engine "${engineId}" of agent ${agentId} cannot supersede turns`,
      )
    }
    const ctx = await this.buildContext(agent, options.person, undefined, {
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
    const ctx = await this.buildContext(agent, person)
    return ctx.listTools()
  }

  private async buildContext(
    agent: AgentConfig,
    person: PersonRef,
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
  ): Promise<EngineContext> {
    // The run's ONLY identity: the person, via this agent. Its tool surface is
    // what the person's roles reach; every call executes as them.
    const principal = delegatedPrincipal(person, agent.id)
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

    return {
      agent,
      principal,
      executeTool: (name, input) => this.registry.execute(name, input, { principal, requestId }),
      listTools: () => listings,
      emit: async (event) => {
        await emitKernelEvent(this.eventSink, {
          type: event.type,
          principalId: event.principalId ?? person.id,
          source: event.source ?? KERNEL_EVENT_SOURCE,
          payload: event.payload,
        })
      },
      spendUsd: () => this.spendFor(agent.id),
      // The person's gateway identity pays for (and is attributed) the run's model calls.
      llmUserId: person.id,
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
