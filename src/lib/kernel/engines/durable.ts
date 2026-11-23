import type { EngineContext, EngineToolListing, LoopEngine } from '../engine'
import type { KernelRegistry } from '../registry'
import { randomUUID } from 'node:crypto'
import { summarizeToolInput, summarizeToolResult, toolStepTarget } from '../../tool-steps/summary'
import { KernelError } from '../errors'
import { delegatedPrincipal, type PersonDirectory } from '../principals'
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
 * Per D6 pi-durable storage is the history source for agents on this engine.
 */

/** One tool of a conversation's surface as the model sees it (no executor). */
export type DurableToolSurfaceEntry = {
  name: string
  description: string
  parametersJsonSchema: Record<string, unknown>
}

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
  /**
   * Submit one user input and wait for the durable run to settle. `ownerText`
   * (when the input was composed with injected context) is recorded with the
   * input entry for run feeds; the model still sees `content`. `turnId` tags
   * the input with the member turn it belongs to (edit-and-resend).
   */
  submitAndSettle(content: string, input?: { ownerText?: string; turnId?: string }): Promise<SettledDurableTurn>
  /**
   * Stop whatever still runs, then omit the turn's inputs (from its first
   * input tagged `turnId`) and every later entry from the model context with
   * one recorded marker entry. Storage keeps them. Not found: KernelError
   * 'turn_not_editable'.
   */
  supersedeTurn(turnId: string, replacementTurnId: string): Promise<void>
}

/**
 * The harness port the engine consumes (implemented over pi-durable in
 * $lib/server/agent/durable-harness). `conversation` resolves the conversation
 * for the key — creating it with the given instructions + tool bridge and
 * recording the index row on first use, opening and reconfiguring it after.
 */
/**
 * A background run (plan/phase-software-factory.md §3.1): an ownerless durable
 * conversation with no request attached. Nobody awaits it; the harness drives
 * it to settle (and resumes it after a restart). Like every brain run it acts
 * as a PERSON (CB3: no background run without a person) — the person the
 * event concerns, recorded in the conversation index; its tools execute
 * through the kernel registry as that person via the brain.
 */
export type BackgroundRunInput = {
  /** Unique conversation key (e.g. `factory:<itemId>`); a key already indexed fails loud. */
  conversationKey: string
  agentId: string
  /** The member id of the person every tool call of this run acts as (recorded, survives restarts); they pay for its model calls. */
  personId: string
  /** The run's system prompt (persona + discipline). */
  instructions: string
  /** The initial user input that starts the run. */
  prompt: string
  /** The tool surface the run may use (recorded; re-registered on reopen). */
  tools: DurableToolSurfaceEntry[]
}

export type BackgroundRunHandle = {
  /** pi-durable conversation id (branded bigint, as text). */
  conversationId: string
  conversationKey: string
  /** pi-durable submission id of the initial prompt (as text). */
  submissionId: string
}

/** One tool call of a background run, routed to the recorded person. */
export type BackgroundToolCall = {
  personId: string
  agentId: string
  tool: string
  args: Record<string, unknown>
}

/**
 * Executes a background run's tool call as its recorded person (via the
 * brain). Resolves to the model-visible result (structured tool errors
 * included), never throws for a tool-side failure.
 */
export type BackgroundToolExecutor = (call: BackgroundToolCall) => Promise<unknown>

/** `<agentId>:<sessionId>` — one durable conversation per (agent, session). */
export function durableConversationKey(agentId: string, sessionId: string): string {
  return `${agentId}:${sessionId}`
}

/** Inverse of durableConversationKey for a known agent; any other key fails loud. */
export function sessionIdOfConversationKey(agentId: string, conversationKey: string): string {
  const prefix = `${agentId}:`
  if (!conversationKey.startsWith(prefix) || conversationKey.length === prefix.length) {
    throw new Error(`${conversationKey} is not a conversation key of agent ${agentId}`)
  }
  return conversationKey.slice(prefix.length)
}

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
  /** Start a background run (see BackgroundRunInput); resolves once it is durably admitted. */
  startBackgroundRun(input: BackgroundRunInput): Promise<BackgroundRunHandle>
}

export type DurableLoopEngineOptions = {
  harness: DurableEngineHarness
  /** Persona preamble handed to the durable run as the agent's instructions. */
  instructions: string
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
async function kernelToolOutcome(
  toolName: string,
  run: () => Promise<unknown>,
  onApproval?: (approvalId: string, tool: string) => void,
): Promise<unknown> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof KernelError && err.code === 'approval_required') {
      const approvalId = approvalIdFromError(err)
      // The gated tool, which a meta tool (the brain's `ee`) names in the error's details.
      const gated = typeof err.details?.tool === 'string' ? err.details.tool : toolName
      onApproval?.(approvalId, gated)
      return approvalPendingResult(gated)
    }
    return toolErrorResult(toolName, err)
  }
}

/**
 * One tool's bridge execute, shown on the surface as a step (proposal 6b91931f): a
 * `tool.preview` before it runs and a `tool.finished` after, both with secret-free
 * summaries only ($lib/tool-steps/summary) — never the full input or result.
 */
function bridgeExecute(
  toolName: string,
  ctx: EngineContext,
): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args) => {
    const stepId = randomUUID()
    const target = toolStepTarget(toolName, args)
    emitSurfaceEvent(ctx, {
      type: 'tool.preview',
      stepId,
      tool: target.tool,
      inputSummary: summarizeToolInput(target.input),
    })
    const outcome = await kernelToolOutcome(
      toolName,
      () => ctx.executeTool(toolName, args),
      (approvalId, tool) => emitSurfaceEvent(ctx, { type: 'approval.required', tool, approvalId }),
    )
    const result = summarizeToolResult(outcome)
    emitSurfaceEvent(ctx, {
      type: 'tool.finished',
      stepId,
      tool: target.tool,
      failed: result.failed,
      resultSummary: result.summary,
    })
    return outcome
  }
}

/**
 * The production BackgroundToolExecutor: resolve the recorded person from the
 * member directory NOW (their current roles — a person demoted since the run
 * started has only what they have today) and execute through
 * KernelRegistry.execute as that person via the brain — the same permission /
 * approval / audit / vcs path a live dispatch takes. A person who is no
 * longer a member is a structured `unknown_principal` tool error naming them:
 * the call never runs as anyone else.
 */
export function createPersonToolExecutor(deps: {
  registry: KernelRegistry
  people: PersonDirectory
}): BackgroundToolExecutor {
  return async (call) => {
    const person = await deps.people.personById(call.personId)
    if (!person) {
      return toolErrorResult(
        call.tool,
        new KernelError(
          'unknown_principal',
          `background run person ${call.personId} (agent ${call.agentId}) is no longer a member — tool ${call.tool} was not run`,
          { principalId: call.personId },
        ),
      )
    }
    const requestId = randomUUID()
    return kernelToolOutcome(call.tool, () =>
      deps.registry.execute(call.tool, call.args, {
        principal: delegatedPrincipal(person, call.agentId),
        requestId,
      }),
    )
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
  }

  /** The person's conversation for (agent, session), configured with this dispatch's tool bridge. */
  private openConversation(sessionId: string, ctx: EngineContext): Promise<DurableEngineConversation> {
    const tools: DurableBridgeToolSpec[] = ctx.listTools().map((listing: EngineToolListing) => ({
      name: listing.name,
      description: listing.summary,
      parametersJsonSchema: listing.inputJsonSchema as Record<string, unknown>,
      execute: bridgeExecute(listing.name, ctx),
    }))
    return this.harness.conversation({
      conversationKey: durableConversationKey(ctx.agent.id, sessionId),
      agentId: ctx.agent.id,
      // The person the run acts as pays for it — no agent-identity fallback (CB3).
      llmUserId: ctx.llmUserId,
      instructions: this.instructions,
      tools,
    })
  }

  async run(sessionId: string, input: string, ctx: EngineContext): Promise<string> {
    const conversation = await this.openConversation(sessionId, ctx)

    const settled = await conversation.submitAndSettle(input, {
      ...(ctx.ownerText !== undefined ? { ownerText: ctx.ownerText } : {}),
      ...(ctx.turnId !== undefined ? { turnId: ctx.turnId } : {}),
    })
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

  async supersedeTurn(
    sessionId: string,
    turnId: string,
    replacementTurnId: string,
    ctx: EngineContext,
  ): Promise<void> {
    if (!turnId || !replacementTurnId || turnId === replacementTurnId) {
      throw new KernelError(
        'invalid_input',
        `supersedeTurn needs two different turn ids (got ${JSON.stringify(turnId)} → ${JSON.stringify(replacementTurnId)})`,
      )
    }
    // The conversation as the person's own dispatch opens it (CB3: another
    // person's key is refused there).
    const conversation = await this.openConversation(sessionId, ctx)
    await conversation.supersedeTurn(turnId, replacementTurnId)
  }
}
