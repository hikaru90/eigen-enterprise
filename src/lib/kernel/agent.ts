/**
 * Harness agent types — the kernel primitive that makes an agent a config
 * object instead of code (plan/phase-1b-harness.md). EE hosts agents; any
 * loop strategy (including the orchestrator's JSON protocol) is a LoopEngine
 * the harness hands work to; the orchestrator itself is one AgentConfig.
 */

/** Identifier of a registered loop engine (e.g. 'builtin-json', 'pi'). */
export type LoopEngineId = string

/** Which conversations/memory partition the agent operates in (v0: declarative). */
export type MemoryScope = 'personal' | 'project' | 'company'

/** Verification policy id (v0: declarative; 'tests-and-check' is not enforced yet). */
export type VerificationPolicyId = 'none' | 'tests-and-check'

/**
 * The complete configuration of a hosted agent. `id` doubles as the kernel
 * principal id: every tool call the agent makes is permission-checked,
 * audited, and approved under this identity.
 */
export type AgentConfig = {
  /** === principal id of the agent principal. */
  id: string
  personaName: string
  description: string
  loopEngine: LoopEngineId
  /** Which modules' tools the agent may see: everything, or a module allowlist. */
  toolScope: { modules: string[] } | 'all'
  memoryScope: MemoryScope
  verificationPolicy: VerificationPolicyId
  /** Cumulative USD spend cap for this agent; undefined = uncapped. */
  spendCapUsd?: number
  enabled: boolean
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
