import type { EngineContext, EngineToolListing, LoopEngine } from '../engine'
import { KernelError } from '../errors'
import { approvalIdFromError, approvalPendingResult, toolErrorResult } from './tool-error'

/**
 * The 'durable' loop engine (plan/phase-durable.md D6): the turn loop is
 * pi-durable's — every input, model turn, tool call and answer is committed to
 * durable storage BEFORE anything is shown, and a crashed process resumes the
 * pending turn from its checkpoint. This module is the engine's kernel face:
 * it imports NO pi-durable — the harness port below is implemented (over
 * pi-durable) in $lib/server/agent, keeping the pinned packages behind the one
 * containment module (D1). What the harness inherits from the kernel is every
 * tool execution: the bridge's execute calls EngineContext.executeTool, so
 * permissions, approval gate, audit and vcs commits apply unchanged (D5).
 * Per D6 this engine does NOT write kernel_agent_session_events — pi-durable
 * storage is the history source for agents on this engine.
 */

/**
 * One kernel tool as a durable-bridge tool spec: name/summary/schema from the
 * dispatch's fail-closed tool surface, execute through the kernel registry.
 */
export type DurableBridgeToolSpec = {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
  /** Execute through the kernel registry for this dispatch. Tool failures resolve as a structured {status:'error'} result (tool-error.ts), never a throw. */
  execute(args: Record<string, unknown>): Promise<unknown>
}

/** One settled durable turn, in kernel terms. */
export type SettledDurableTurn =
  | { status: 'done'; reply: string }
  | { status: 'unanswered'; reason: string; detail?: unknown }

export type DurableEngineConversation = {
  /** pi-durable conversation id (branded bigint, as text) — index + SSE surfaces. */
  readonly id: string
  /** Submit one user input and wait for the durable run to settle. */
  submitAndSettle(content: string): Promise<SettledDurableTurn>
}

/**
 * The harness port the engine consumes (implemented over pi-durable in
 * $lib/server/agent/durable-harness). `conversation` resolves the conversation
 * for the key — creating it with the given instructions + tool bridge and
 * recording the index row on first use, opening and reconfiguring it after.
 */
export type DurableEngineHarness = {
  conversation(input: {
    /** `<agentId>:<sessionId>` — one durable conversation per pair. */
    conversationKey: string
    agentId: string
    /** Gateway billing identity this conversation's model calls resolve to. */
    llmUserId: string
    /** The agent's system prompt (persona + discipline). */
    instructions: string
    /** The dispatch's fresh tool bridge — configured onto the conversation. */
    tools: DurableBridgeToolSpec[]
  }): Promise<DurableEngineConversation>
}

export type DurableLoopEngineOptions = {
  harness: DurableEngineHarness
  /** Persona preamble handed to the durable run as the agent's instructions. */
  instructions: string
  /**
   * Gateway billing/config identity for LLM calls. Used when the dispatch
   * carries no llmUserId; the agent principal id is the last resort (same
   * chain as before).
   */
  llmUserId?: string
}

/** The durable run ended without an answer (pi-durable unanswered reason). */
export class DurableRunError extends Error {
  readonly reason: string
  readonly detail: unknown

  constructor(reason: string, detail?: unknown) {
    super(`durable agent run ended without an answer: ${reason}`)
    this.name = 'DurableRunError'
    this.reason = reason
    this.detail = detail
  }
}

/** Best-effort surface event; a throwing sink must never break the run. */
function emitSurfaceEvent(
  ctx: EngineContext,
  event: Parameters<NonNullable<EngineContext['surfaceEvent']>>[0],
): void {
  if (!ctx.surfaceEvent) return
  try {
    ctx.surfaceEvent(event)
  } catch {
    // best-effort channel — the run still settles durably
  }
}

/**
 * One tool's bridge execute: through the kernel registry via
 * EngineContext.executeTool — never around it. Approval-required errors become
 * the structured approval_pending result (tool-error.ts), so the
 * orchestrator's approval wording is engine-independent. Every other
 * rejection of executeTool becomes a structured {status:'error'} tool result
 * (with remediation where the kernel knows it) so the agent can fix it and
 * retry — see tool-error.ts for the tool-vs-infrastructure boundary.
 * Infrastructure failures (harness, storage, gateway) never pass through here
 * and still fail the run loud.
 */
function bridgeExecute(
  toolName: string,
  ctx: EngineContext,
): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => {
    try {
      return await ctx.executeTool(toolName, args)
    } catch (err) {
      if (err instanceof KernelError && err.code === 'approval_required') {
        emitSurfaceEvent(ctx, {
          type: 'approval.required',
          tool: toolName,
          approvalId: approvalIdFromError(err),
        })
        return approvalPendingResult(toolName)
      }
      return toolErrorResult(toolName, err)
    }
  }
}

/**
 * Stateless per run: the tool bridge is rebuilt from the dispatch's surface
 * and the conversation reconfigured with it. Conversation memory lives in
 * pi-durable storage — one durable conversation per (agentId, sessionId).
 */
export class DurableLoopEngine implements LoopEngine {
  private readonly harness: DurableEngineHarness
  private readonly instructions: string
  private readonly llmUserId: string | undefined

  constructor(options: DurableLoopEngineOptions) {
    if (!options.harness) {
      throw new KernelError(
        'invalid_input',
        'DurableLoopEngine requires a harness (the pi-durable port) — none was injected.',
      )
    }
    if (!options.instructions || options.instructions.trim() === '') {
      throw new KernelError(
        'invalid_input',
        'DurableLoopEngine requires instructions (the agent persona prompt) — none was injected.',
      )
    }
    this.harness = options.harness
    this.instructions = options.instructions
    this.llmUserId = options.llmUserId
  }

  async run(sessionId: string, input: string, ctx: EngineContext): Promise<string> {
    const tools: DurableBridgeToolSpec[] = ctx.listTools().map((listing: EngineToolListing) => ({
      name: listing.name,
      description: listing.summary,
      parametersJsonSchema: listing.inputJsonSchema as Record<string, unknown>,
      execute: bridgeExecute(listing.name, ctx),
    }))

    const conversation = await this.harness.conversation({
      conversationKey: `${ctx.agent.id}:${sessionId}`,
      agentId: ctx.agent.id,
      llmUserId: ctx.llmUserId ?? this.llmUserId ?? ctx.agent.id,
      instructions: this.instructions,
      tools,
    })

    const settled = await conversation.submitAndSettle(input)
    if (settled.status === 'unanswered') {
      throw new DurableRunError(settled.reason, settled.detail)
    }

    // Surface completeness: no gateway streaming yet (follow-up) — the final
    // reply is emitted as ONE delta, one answer per turn.
    if (ctx.stream && settled.reply) {
      try {
        ctx.stream(settled.reply)
      } catch {
        // best-effort channel — the reply still returns through the harness
      }
    }
    return settled.reply
  }
}
