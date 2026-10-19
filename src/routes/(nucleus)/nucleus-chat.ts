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

export type NucleusApprovalTurn = {
  role: 'approval'
  tool: string
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

/** Distinct pending-approval card — the action is queued, not executed. */
export function approvalRequiredTurn(tool: string): NucleusApprovalTurn {
  return { role: 'approval', tool }
}

/**
 * Transcript turns that come straight from stream progress events (tool
 * previews, approval gates). Everything else returns null — the status line
 * and final-response handling own those.
 */
export function nucleusTurnForProgressEvent(event: ChatProgressEvent): NucleusTurn | null {
  if (event.type === 'tool.preview') return toolPreviewTurn(event.tool, event.inputSummary)
  if (event.type === 'approval.required') return approvalRequiredTurn(event.tool)
  return null
}

/**
 * Rebuild the transcript from persisted chat_message rows (page load). Mirrors
 * the live view: user/assistant turns, tool previews and approval cards;
 * thinking and tool-call/result machinery stay hidden, as they do live.
 */
export function nucleusTurnsFromPersisted(messages: PersistedChatMessage[]): NucleusTurn[] {
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
      out.push(approvalRequiredTurn(tool))
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
