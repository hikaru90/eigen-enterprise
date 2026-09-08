import type { AgentConfig } from './agent'
import type { KernelEvent } from './events'
import type { ToolContext } from './types'

/**
 * A listing of one tool as offered to a loop engine: name, summary, and the
 * zod-derived JSON Schema of its input (same projection MCP and OpenAPI use).
 */
export type EngineToolListing = {
  name: string
  summary: string
  inputJsonSchema: unknown
}

/**
 * Everything the harness hands a loop engine for one run — the parts an agent
 * must never rebuild: its config, its principal, the kernel execution path,
 * the fail-closed tool surface, the event stream, and live spend.
 */
export type EngineContext = {
  agent: AgentConfig
  /** { id: agent.id, kind: 'agent', roles } — permissions/audit/approvals see this identity. */
  principal: ToolContext['principal']
  /** Execute a kernel tool; throws KernelError on any failure (loud, never swallowed). */
  executeTool(name: string, input: unknown): Promise<unknown>
  /**
   * Activation ∩ toolScope ∩ role filtered tool surface, resolved once per
   * dispatch (fail closed). Sync: the runtime precomputed it.
   */
  listTools(): EngineToolListing[]
  /** Emit a harness event; `id`/`ts`/`principalId`/`source` are defaulted by the runtime. */
  emit(event: Partial<KernelEvent> & { type: string; payload?: unknown }): Promise<void>
  /** Accumulated USD spend for this agent (injected accumulator; gateway-cost wiring is a follow-up). */
  spendUsd(): number
}

/**
 * A loop strategy. The harness never touches model choice, prompts, reasoning
 * strategy, or stop conditions — that is entirely the engine's domain; in
 * exchange the engine never rebuilds sessions, permissions, approvals, tool
 * surfaces, events, or budget enforcement.
 */
export type LoopEngine = {
  /** Run one user turn to completion; returns the agent's reply text. */
  run(sessionId: string, input: string, ctx: EngineContext): Promise<string>
}
