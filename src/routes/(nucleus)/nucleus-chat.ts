import { toolLabel } from '$lib/chat/chat-stream-types'
import type { ChatProgressEvent } from '$lib/chat/consume-chat-ndjson'

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
