import { replyCostSchema, type ReplyCost } from '$lib/ai-usage/usage'
import { approvalActionLabel } from '$lib/chat/approval-copy'
import { toolLabel } from '$lib/chat/chat-stream-types'
import type { ChatProgressEvent } from '$lib/chat/consume-chat-ndjson'
import type { PersistedChatMessage } from '$lib/chat/normalize-messages'
import type { ToolStepStatus } from '$lib/tool-steps/summary'
import { storedAttachmentMetas, type AssistantAttachmentMeta } from './attachments'

/**
 * The nucleus transcript model. User and assistant turns are the conversation;
 * harness machinery surfaces only as metadata: subtle tool preview lines and
 * the approval-required card. The harness is visible, but quiet.
 */
export type NucleusConversationTurn = {
  role: 'user' | 'assistant'
  content: string
  failed?: boolean
  /** On a failed turn: render the provider-setup action link (view owns the URL). */
  providerSetup?: true
  /** A member turn's attached files (chips: name, kind, size — the text went to the model). */
  attachments?: AssistantAttachmentMeta[]
  /** A member turn's stored message id (chat_message) — what Edit names; absent until the server accepted it. */
  messageId?: string
  /** An assistant reply's cost (its model calls), shown as a quiet line under it. */
  usage?: ReplyCost
}

/** One tool the assistant ran (a step in the transcript). */
export type NucleusToolPreviewTurn = {
  role: 'tool_preview'
  /** The tool that ran (an `ee tool run <name>` names <name>). */
  tool: string
  /** Short, truncated, secret-free input summary from the harness (may be null). */
  inputSummary: string | null
  /** Pairs the step with its end event (null: a step stored before steps carried one). */
  stepId: string | null
  /** running → done | failed; stopped: the reply ended before the tool did; null: not recorded. */
  status: ToolStepStatus | null
  /** Short, secret-free summary of what came back (null: none, or not finished). */
  resultSummary: string | null
}

/**
 * Card status: the kernel request's own status, or 'unavailable' when the
 * page cannot decide it (no id saved with the card, or the request is gone).
 */
export type ApprovalCardStatus = 'pending' | 'approved' | 'denied' | 'unavailable'

export type NucleusApprovalTurn = {
  role: 'approval'
  tool: string
  /** The kernel approval request this card decides (null: cannot be decided here). */
  approvalId: string | null
  status: ApprovalCardStatus
  /** The gated action in plain words. */
  action: string
}

export type NucleusTurn = NucleusConversationTurn | NucleusToolPreviewTurn | NucleusApprovalTurn

export type NucleusChatEntry = NucleusTurn & { key: string }

export function userTurn(
  text: string,
  attachments: AssistantAttachmentMeta[] = [],
  messageId?: string,
): NucleusConversationTurn {
  return {
    role: 'user',
    content: text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(messageId ? { messageId } : {}),
  }
}

/**
 * Final assistant turn from the sanitized stream response (the page sanitizes
 * inside its fetch try/catch so FinalAnswerFormatError surfaces as a failed
 * turn). Returns null when empty so a blank bubble is never rendered.
 */
export function assistantTurnFromResponse(
  sanitizedText: string,
  usage?: ReplyCost,
): NucleusConversationTurn | null {
  const content = sanitizedText.trim()
  if (!content) return null
  return { role: 'assistant', content, ...(usage ? { usage } : {}) }
}

export function failedTurn(
  message: string,
  opts?: { providerSetup?: true },
): NucleusConversationTurn {
  return {
    role: 'assistant',
    content: message,
    failed: true,
    ...(opts?.providerSetup ? { providerSetup: true } : {}),
  }
}

/** A tool step: the tool, its bounded input summary, and how it went once it ended. */
export function toolPreviewTurn(
  tool: string,
  inputSummary: string | null,
  step: { stepId?: string | null; status?: ToolStepStatus | null; resultSummary?: string | null } = {},
): NucleusToolPreviewTurn {
  return {
    role: 'tool_preview',
    tool,
    inputSummary,
    stepId: step.stepId ?? null,
    status: step.status ?? null,
    resultSummary: step.resultSummary ?? null,
  }
}

/** The entries with the step `stepId` ended (failed or done, with its result summary). */
export function withToolStepFinished<T extends NucleusChatEntry>(
  entries: T[],
  finished: { stepId: string; failed: boolean; resultSummary: string | null },
): T[] {
  return entries.map((e) =>
    e.role === 'tool_preview' && e.stepId === finished.stepId
      ? { ...e, status: finished.failed ? 'failed' : 'done', resultSummary: finished.resultSummary }
      : e,
  )
}

/** Steps still running when the reply ended (stopped, failed) ended with it. */
export function withRunningStepsStopped<T extends NucleusChatEntry>(entries: T[]): T[] {
  return entries.map((e) => (e.role === 'tool_preview' && e.status === 'running' ? { ...e, status: 'stopped' } : e))
}

export { approvalActionLabel }

/** Approval card — the action is queued, not executed, until the owner decides. */
export function approvalRequiredTurn(input: {
  tool: string
  approvalId: string | null
  status: ApprovalCardStatus
}): NucleusApprovalTurn {
  return {
    role: 'approval',
    tool: input.tool,
    approvalId: input.approvalId,
    status: input.status,
    action: approvalActionLabel(input.tool),
  }
}

/** The entries with one approval card moved to its decided status. */
export function withApprovalStatus<T extends NucleusChatEntry>(
  entries: T[],
  approvalId: string,
  status: ApprovalCardStatus,
): T[] {
  return entries.map((e) =>
    e.role === 'approval' && e.approvalId === approvalId ? { ...e, status } : e,
  )
}

function persistedApprovalId(m: PersistedChatMessage): string | null {
  const id = m.metadata?.approvalId
  return typeof id === 'string' && id.length > 0 ? id : null
}

/** Approval request ids saved with the transcript's approval cards (page load looks up their status). */
export function persistedApprovalIds(messages: PersistedChatMessage[]): string[] {
  const ids: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || m.metadata?.variant !== 'approval_required') continue
    const id = persistedApprovalId(m)
    if (id) ids.push(id)
  }
  return ids
}

/**
 * Transcript turns that come straight from stream progress events (tool
 * previews, approval gates). Everything else returns null — the status line
 * and final-response handling own those.
 */
export function nucleusTurnForProgressEvent(event: ChatProgressEvent): NucleusTurn | null {
  if (event.type === 'tool.preview') {
    return toolPreviewTurn(event.tool, event.inputSummary, {
      stepId: event.stepId ?? null,
      status: event.stepId ? 'running' : null,
    })
  }
  if (event.type === 'approval.required') {
    return approvalRequiredTurn({
      tool: event.tool,
      approvalId: event.approvalId,
      status: 'pending',
    })
  }
  return null
}

/** A stored reply's cost (metadata.usage); a malformed one is a broken row and fails loud. */
function storedReplyCost(m: PersistedChatMessage): ReplyCost | undefined {
  const raw = m.metadata?.usage
  if (raw === undefined || raw === null) return undefined
  const parsed = replyCostSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`chat message ${m.id} holds a malformed reply cost`)
  return parsed.data
}

/** A stored step's end: done/failed as recorded; a step stored as running never ended (stopped). */
function storedToolStep(m: PersistedChatMessage): Parameters<typeof toolPreviewTurn>[2] {
  const meta = m.metadata ?? {}
  const stepId = typeof meta.stepId === 'string' ? meta.stepId : null
  const recorded = meta.status
  const status: ToolStepStatus | null =
    recorded === 'done' || recorded === 'failed' ? recorded : recorded === 'running' ? 'stopped' : null
  const resultSummary = typeof meta.resultSummary === 'string' ? meta.resultSummary : null
  return { stepId, status, resultSummary }
}

/**
 * Rebuild the transcript from persisted chat_message rows (page load). Mirrors
 * the live view: user/assistant turns, tool previews and approval cards;
 * thinking and tool-call/result machinery stay hidden, as they do live.
 */
export function nucleusTurnsFromPersisted(
  messages: PersistedChatMessage[],
  /** Current kernel status per approval id (from persistedApprovalIds). */
  approvalStatuses: Record<string, 'pending' | 'approved' | 'denied'>,
  /** Pending kernel approval id per tool — links cards saved before cards carried an id. */
  pendingByTool: Record<string, string> = {},
): NucleusTurn[] {
  const out: NucleusTurn[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(userTurn(m.content, storedAttachmentMetas(m.metadata), m.id))
      continue
    }
    if (m.role !== 'assistant') continue
    const variant = m.metadata?.variant
    const tool = typeof m.metadata?.tool === 'string' ? m.metadata.tool : null
    if (variant === undefined || variant === null) {
      const turn = assistantTurnFromResponse(m.content, storedReplyCost(m))
      if (turn) out.push(turn)
    } else if (variant === 'tool_preview' && tool) {
      out.push(toolPreviewTurn(tool, m.content || null, storedToolStep(m)))
    } else if (variant === 'approval_required' && tool) {
      const savedId = persistedApprovalId(m)
      if (savedId) {
        out.push(
          approvalRequiredTurn({
            tool,
            approvalId: savedId,
            status: approvalStatuses[savedId] ?? 'unavailable',
          }),
        )
      } else if (pendingByTool[tool]) {
        out.push(approvalRequiredTurn({ tool, approvalId: pendingByTool[tool], status: 'pending' }))
      } else {
        out.push(approvalRequiredTurn({ tool, approvalId: null, status: 'unavailable' }))
      }
    }
  }
  return out
}

/**
 * Quiet status line for stream progress. Agent machinery collapses to one
 * label; thinking, text deltas, tool previews (rendered inline), and approval
 * cards (rendered as cards) surface nothing here.
 */
export function statusLabelForProgressEvent(event: ChatProgressEvent): string | null {
  switch (event.type) {
    case 'thinking':
      return null
    case 'message_delta':
      return null
    case 'tool.preview':
      return null
    case 'tool.finished':
      return null
    case 'approval.required':
      return null
    case 'turn.accepted':
      return null
    case 'agent_progress':
      return event.label
    case 'tool_call':
    case 'tool_executing':
      return toolLabel(event.tool)
    case 'tool_progress':
      return event.label || toolLabel(event.tool)
    case 'tool_result':
      return 'Preparing your reply…'
  }
}
