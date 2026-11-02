import type { AgentConfig, LoopEngineId } from './agent'
import type { EngineContext, EngineStreamSinks, EngineToolListing, LoopEngine } from './engine'
import type { KernelRegistry } from './registry'
import type { ToolContext } from './types'
import { randomUUID } from 'node:crypto'
import { KERNEL_EVENT_SOURCE } from './cloudevents'
import { KernelError } from './errors'
import { emitKernelEvent, type EventSink, type KernelEvent } from './events'
import { toolInputJsonSchema } from './openapi'
import { selectToolSurface } from './tool-surface'

/**
 * The harness: hosts agents as config (plan/phase-1b-harness.md). The runtime
 * provides what an agent must never rebuild — sessions, the fail-closed tool
 * surface (registry ∩ activation ∩ scope ∩ roles), the kernel execution path,
 * the event stream, and spend-cap enforcement — and delegates the loop itself
 * to the configured LoopEngine. All collaborators are constructor-injected.
 */

/** Per-dispatch options beyond sinks — attribution of the run's LLM calls. */
export type DispatchOptions = {
  /** The conversing human's id: their BYOK provider config pays, their spend accrues. */
  llmUserId?: string
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
   * Principal roles for an agent principal (AgentConfig carries no roles).
   * Defaults to ['agent']; wire ORCHESTRATOR_PRINCIPAL.roles where an agent
   * must hold them.
   */
  rolesFor?: (agent: AgentConfig) => string[]
}

/**
 * Harness events: agent.dispatched / agent.replied / agent.stopped /
 * agent.budget_exceeded. Payloads carry metadata only — NEVER message or
 * reply content.
 */

export class AgentRuntime {
  private readonly registry: KernelRegistry
  private readonly isToolActive: (toolName: string) => Promise<boolean>
  private readonly eventSink: EventSink
  private readonly engines: Map<LoopEngineId, LoopEngine>
  private readonly spendFn: ((agentId: string) => number) | undefined
  private readonly rolesFor: (agent: AgentConfig) => string[]
  private readonly agents = new Map<string, AgentConfig>()
  /** Default spend accumulator (used when no spendFn is injected). */
  private readonly spendUsdByAgent = new Map<string, number>()

  constructor(options: AgentRuntimeOptions) {
    this.registry = options.registry
    this.isToolActive = options.isToolActive
    this.eventSink = options.eventSink
    this.engines = options.engines ?? new Map()
    this.spendFn = options.spendFn
    this.rolesFor = options.rolesFor ?? (() => ['agent'])
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
   * Run one user turn against an agent. Fails loud on unknown/disabled agent,
   * unregistered engine, or exhausted spend cap — never silently degrades.
   * `sinks` (optional) are per-request surface sinks passed through to the
   * engine context; the runtime itself never consumes them. `options.llmUserId`
   * (optional) attributes the run's LLM calls to the conversing human — their
   * BYOK provider config and spend — instead of the agent principal.
   */
  async dispatch(
    agentId: string,
    sessionId: string,
    input: string,
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
  ): Promise<string> {
    const agent = this.requireAgent(agentId)
    if (!agent.enabled) {
      throw new KernelError('agent_disabled', `agent ${agentId} is disabled`)
    }
    const engineId = options?.loopEngine ?? agent.loopEngine
    const engine = this.engines.get(engineId)
    if (!engine) {
      throw new KernelError(
        'unknown_engine',
        `agent ${agentId} references unregistered loop engine "${engineId}"`,
      )
    }

    const spendUsd = this.spendFor(agentId)
    if (agent.spendCapUsd !== undefined && spendUsd >= agent.spendCapUsd) {
      await this.emitAgentEvent(agent.id, 'agent.budget_exceeded', {
        agentId,
        sessionId,
        spendUsd,
        spendCapUsd: agent.spendCapUsd,
      })
      throw new KernelError(
        'budget_exceeded',
        `agent ${agentId} exceeded its spend cap (${spendUsd} >= ${agent.spendCapUsd} USD)`,
      )
    }

    await this.emitAgentEvent(agent.id, 'agent.dispatched', { agentId, sessionId })

    const ctx = await this.buildContext(agent, sinks, options)
    const reply = await engine.run(sessionId, input, ctx)

    await this.emitAgentEvent(agent.id, 'agent.replied', {
      agentId,
      sessionId,
      replyLength: reply.length,
    })
    return reply
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

  /** The fail-closed tool surface an agent would be offered right now. */
  async listAgentTools(agentId: string): Promise<EngineToolListing[]> {
    const agent = this.requireAgent(agentId)
    const ctx = await this.buildContext(agent)
    return ctx.listTools()
  }

  private async buildContext(
    agent: AgentConfig,
    sinks?: EngineStreamSinks,
    options?: DispatchOptions,
  ): Promise<EngineContext> {
    const principal: ToolContext['principal'] = {
      id: agent.id,
      kind: 'agent',
      roles: this.rolesFor(agent),
    }
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
          principalId: event.principalId ?? agent.id,
          source: event.source ?? KERNEL_EVENT_SOURCE,
          payload: event.payload,
        })
      },
      spendUsd: () => this.spendFor(agent.id),
      ...(options?.llmUserId ? { llmUserId: options.llmUserId } : {}),
      ...(options?.ownerText !== undefined ? { ownerText: options.ownerText } : {}),
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
    agentId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<KernelEvent> {
    return emitKernelEvent(this.eventSink, {
      type,
      principalId: agentId,
      source: KERNEL_EVENT_SOURCE,
      payload,
    })
  }
}
