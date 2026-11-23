/**
 * Harness agent types — the kernel primitive that makes an agent a config
 * object instead of code (plan/phase-1b-harness.md). EE hosts agents; any
 * loop strategy (including the orchestrator's JSON protocol) is a LoopEngine
 * the harness hands work to; the orchestrator itself is one AgentConfig.
 */

import type { ToolPrincipal } from './types'

/** Identifier of a registered loop engine (e.g. 'durable'). */
export type LoopEngineId = string

/** Which conversations/memory partition the agent operates in (v0: declarative). */
export type MemoryScope = 'personal' | 'project' | 'company'

/** Verification policy id (v0: declarative; 'tests-and-check' is not enforced yet). */
export type VerificationPolicyId = 'none' | 'tests-and-check'

/** What a turn's instructions are assembled from: who runs, in which session, on what input. */
export type AgentTurnContext = {
  agentId: string
  sessionId: string
  /** The principal this turn acts as (the person via the agent, or the agent itself). */
  principal: ToolPrincipal
  /** The turn's input as the engine will receive it. */
  input: string
  /** Who asked for this turn (DispatchAsAgentOptions.requestedBy), when someone did. */
  requestedBy?: string
}

/**
 * Whose system prompt a turn runs on — declared, never inferred:
 * - `'engine-default'`: the loop engine's own prompt (the company brain has exactly one, set
 *   on the engine at boot). Not a fallback: it is that agent's only prompt.
 * - a function: this agent's own prompt, assembled by the runtime for every turn (a co-worker's
 *   role card, org chart, trigger …) and handed to the engine with the run. An empty result
 *   fails the dispatch loud.
 */
export type AgentInstructions = 'engine-default' | ((turn: AgentTurnContext) => string | Promise<string>)

/** What a self-acting agent's principal is resolved from, per dispatch. */
export type AgentPrincipalContext = {
  agentId: string
  sessionId: string
  requestedBy?: string
}

/**
 * An agent that acts as ITSELF (an AI co-worker, plan/phase-ai-coworkers.md §3): every tool
 * call runs as the principal `principalFor` returns (its own id and roles, never `via` the
 * brain), its model calls are billed to that principal's id, and its spend is the cost
 * ledger's sum for that id per UTC day (AgentRuntimeOptions.spentUsdToday) against
 * `dailySpendCapUsd`.
 */
export type AgentActsAsSelf = {
  kind: 'self'
  principalFor(ctx: AgentPrincipalContext): ToolPrincipal | Promise<ToolPrincipal>
  /** USD per UTC day, summed from the cost ledger for the acting principal; reached = refused. */
  dailySpendCapUsd: number
}

/**
 * Who a run acts as — declared, never inferred:
 * - `'person'`: the dispatch's person, via this agent (the company brain, CB3: no person, no
 *   run). Dispatched with AgentRuntime.dispatch.
 * - AgentActsAsSelf: the agent itself. Dispatched with AgentRuntime.dispatchAsAgent.
 */
export type AgentActsAs = 'person' | AgentActsAsSelf

/**
 * The complete configuration of a hosted agent. `id` names the agent (the conversation key
 * prefix, the provenance on a person's delegated calls); who its calls run as is `actsAs`.
 */
export type AgentConfig = {
  id: string
  personaName: string
  description: string
  loopEngine: LoopEngineId
  /** Which modules' tools the agent may see: everything, or a module allowlist. */
  toolScope: { modules: string[] } | 'all'
  memoryScope: MemoryScope
  verificationPolicy: VerificationPolicyId
  /** Whose system prompt a turn runs on (see AgentInstructions). */
  instructions: AgentInstructions
  /**
   * The chat model this agent's turns run on: a chat model of the vetted pool
   * (src/lib/server/llm/model-pool.ts; anything else fails loud at the engine and the
   * gateway). Absent: the company's chat slot (Settings → AI), what the company brain runs on.
   */
  modelId?: string
  /** Who a run acts as (see AgentActsAs). */
  actsAs: AgentActsAs
  /**
   * Cumulative USD spend cap on the runtime's in-memory accumulator; undefined = uncapped.
   * Only for `actsAs: 'person'` — a self-acting agent's cap is `actsAs.dailySpendCapUsd` on
   * the real ledger (registering both fails loud).
   */
  spendCapUsd?: number
  enabled: boolean
}

/**
 * Where a runtime (re)loads a set of agent configs from — e.g. the company's enabled AI
 * co-workers in the database (C3). AgentRuntime.loadAgents keeps exactly this set registered.
 */
export type CoworkerSource = {
  listAgentConfigs(): Promise<AgentConfig[]>
}

/** The serializable view of an agent (agent.list): no functions, no principal factory. */
export type AgentSummary = Omit<AgentConfig, 'instructions' | 'actsAs'> & {
  instructions: 'engine-default' | 'own'
  actsAs: 'person' | 'self'
  dailySpendCapUsd?: number
}

/**
 * Manifest extension (additive, optional): a module can declaratively
 * contribute agent types. v0 is documentation only — nothing enforces these;
 * registration into an AgentRuntime stays an explicit boot step.
 */
export type AgentTypeSpec = {
  loopEngine: LoopEngineId
  defaults: Partial<AgentConfig>
}

/** Declarative verification policy descriptor (v0: not enforced, documented). */
export type VerificationPolicySpec = {
  id: string
  description: string
}

/** Identifies one conversation with one hosted agent. */
export type AgentSessionRef = {
  agentId: string
  sessionId: string
}
