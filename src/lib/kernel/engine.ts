import type { AgentConfig } from './agent'
import type { CoreEventType } from './event-catalog'
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
 * Structured, metadata-only surface events an engine can emit onto a
 * caller-provided sink (chat NDJSON). `inputSummary` is a short, truncated
 * projection of the tool input — never full arguments, never secrets.
 */
export type EngineSurfaceEvent =
  /**
   * A tool starts. `stepId` pairs it with its `tool.finished`; `tool` is the tool that
   * really runs (an `ee tool run <name>` names <name>).
   */
  | { type: 'tool.preview'; stepId: string; tool: string; inputSummary: string | null }
  /**
   * That tool ended: failed (a structured tool error) or not, and a short result summary.
   * `artifact`: the Drive artifact it wrote (the chat's side panel opens it; tool-steps/artifact.ts).
   */
  | { type: 'tool.finished'; stepId: string; tool: string; failed: boolean; resultSummary: string | null; artifact?: { fileId: string } }
  | { type: 'approval.required'; tool: string; approvalId: string }

/**
 * Per-request surface sinks. dispatch() passes them through to the engine
 * context when the caller (e.g. the chat endpoint) provides one; both are
 * optional and best-effort — engines must never fail a run because a sink
 * threw.
 */
export type EngineStreamSinks = {
  /** Reply-text delta sink for surfaces that render incrementally. */
  stream?: (delta: string) => void
  /** Structured surface events (tool previews, approval gates). */
  surfaceEvent?: (event: EngineSurfaceEvent) => void
}

/** A run's system prompt: the engine's own, or the text the runtime assembled for this turn. */
export type RunInstructions = { kind: 'engine-default' } | { kind: 'own'; text: string }

/**
 * Everything the harness hands a loop engine for one run — the parts an agent
 * must never rebuild: its config, its principal, the kernel execution path,
 * the fail-closed tool surface, the event stream, and live spend.
 */
export type EngineContext = EngineStreamSinks & {
  agent: AgentConfig
  /**
   * Who this run acts as: the person via the agent (principals.ts delegatedPrincipal) for an
   * agent with `actsAs: 'person'`, or the agent's own principal (AgentActsAsSelf.principalFor).
   * Permissions, approvals and audit see exactly this principal.
   */
  principal: ToolContext['principal']
  /**
   * This run's system prompt, resolved by the runtime from AgentConfig.instructions:
   * 'engine-default' = the engine's own prompt; 'own' = the text assembled for this turn.
   */
  instructions: RunInstructions
  /** Execute a kernel tool; throws KernelError on any failure (loud, never swallowed). */
  executeTool(name: string, input: unknown): Promise<unknown>
  /**
   * Activation ∩ toolScope ∩ role filtered tool surface, resolved once per
   * dispatch (fail closed). Sync: the runtime precomputed it.
   */
  listTools(): EngineToolListing[]
  /** Emit a harness event; `id`/`ts`/`principalId`/`source` are defaulted by the runtime. */
  emit(event: Omit<Partial<KernelEvent>, 'type'> & { type: CoreEventType; payload?: unknown }): Promise<void>
  /**
   * USD spend for this agent: the in-memory accumulator for a person-acting agent; for a
   * self-acting agent, the cost ledger's sum for its principal today (UTC), read at dispatch.
   */
  spendUsd(): number
  /**
   * The identity this run's LLM calls are billed and attributed to — always the principal
   * the run acts as (principal.id): the person, or the self-acting agent.
   */
  llmUserId: string
  /**
   * The owner's own words of this turn when `input` was composed with
   * injected context (DispatchOptions.ownerText). Engines that record the
   * input for display record this instead of the composed text.
   */
  ownerText?: string
  /**
   * The member turn this run belongs to (DispatchOptions.turnId): every input
   * of one turn carries it, so the turn can later be superseded as a whole.
   */
  turnId?: string
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
  /**
   * Edit-and-resend (board a950ef11): take the member turn `turnId` and
   * everything after it out of what the model sees — stopping it first if it
   * is still running — so the edited request `replacementTurnId` runs on the
   * conversation as it was before. History keeps the superseded turn. A turn
   * the conversation does not carry fails with KernelError 'turn_not_editable'.
   * Optional: an engine without it cannot edit turns (the runtime fails loud).
   */
  supersedeTurn?(sessionId: string, turnId: string, replacementTurnId: string, ctx: EngineContext): Promise<void>
}
