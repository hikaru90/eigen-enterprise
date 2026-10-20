import { approvalActionLabel } from '$lib/chat/approval-copy'
import { toolLabel } from '$lib/chat/chat-stream-types'
import type { ChatProgressEvent } from '$lib/chat/consume-chat-ndjson'
import type { PersistedChatMessage } from '$lib/chat/normalize-messages'

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
}

export type NucleusToolPreviewTurn = {
  role: 'tool_preview'
  tool: string
  /** Short, truncated, metadata-only input summary from the harness (may be null). */
  inputSummary: string | null
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

export type NucleusTurn =
  | NucleusConversationTurn
  | NucleusToolPreviewTurn
  | NucleusApprovalTurn

export type NucleusChatEntry = NucleusTurn & { key: string }

export function userTurn(text: string): NucleusConversationTurn {
  return { role: 'user', content: text }
}

/**
 * Final assistant turn from the sanitized stream response (the page sanitizes
 * inside its fetch try/catch so FinalAnswerFormatError surfaces as a failed
 * turn). Returns null when empty so a blank bubble is never rendered.
 */
export function assistantTurnFromResponse(sanitizedText: string): NucleusConversationTurn | null {
  const content = sanitizedText.trim()
  if (!content) return null
  return { role: 'assistant', content }
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

/** Subtle inline line before a tool runs — tool name plus bounded input summary. */
export function toolPreviewTurn(tool: string, inputSummary: string | null): NucleusToolPreviewTurn {
  return { role: 'tool_preview', tool, inputSummary }
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
  if (event.type === 'tool.preview') return toolPreviewTurn(event.tool, event.inputSummary)
  if (event.type === 'approval.required') {
    return approvalRequiredTurn({ tool: event.tool, approvalId: event.approvalId, status: 'pending' })
  }
  return null
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
): NucleusTurn[] {
  const out: NucleusTurn[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(userTurn(m.content))
      continue
    }
    if (m.role !== 'assistant') continue
    const variant = m.metadata?.variant
    const tool = typeof m.metadata?.tool === 'string' ? m.metadata.tool : null
    if (variant === undefined || variant === null) {
      const turn = assistantTurnFromResponse(m.content)
      if (turn) out.push(turn)
    } else if (variant === 'tool_preview' && tool) {
      out.push(toolPreviewTurn(tool, m.content || null))
    } else if (variant === 'approval_required' && tool) {
      const approvalId = persistedApprovalId(m)
      const status = approvalId ? (approvalStatuses[approvalId] ?? 'unavailable') : 'unavailable'
      out.push(approvalRequiredTurn({ tool, approvalId, status }))
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
    case 'approval.required':
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
