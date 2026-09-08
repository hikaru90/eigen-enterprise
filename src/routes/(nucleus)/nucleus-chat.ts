import { toolLabel } from '$lib/chat/chat-stream-types'
import type { ChatProgressEvent } from '$lib/chat/consume-chat-ndjson'

/**
 * The nucleus transcript model: user and assistant turns only. Tool calls,
 * thinking, and other agent machinery stay behind the chatbox — the surface
 * renders the conversation, not the harness (progress is a single status line).
 */
export type NucleusChatEntry = {
  key: string
  role: 'user' | 'assistant'
  content: string
  failed?: boolean
  /** On a failed turn: render the provider-setup action link (view owns the URL). */
  providerSetup?: true
}

export type NucleusTurn = Omit<NucleusChatEntry, 'key'>

export function userTurn(text: string): NucleusTurn {
  return { role: 'user', content: text }
}

/**
 * Final assistant turn from the sanitized stream response (the page sanitizes
 * inside its fetch try/catch so FinalAnswerFormatError surfaces as a failed
 * turn). Returns null when empty so a blank bubble is never rendered.
 */
export function assistantTurnFromResponse(sanitizedText: string): NucleusTurn | null {
  const content = sanitizedText.trim()
  if (!content) return null
  return { role: 'assistant', content }
}

export function failedTurn(message: string, opts?: { providerSetup?: true }): NucleusTurn {
  return {
    role: 'assistant',
    content: message,
    failed: true,
    ...(opts?.providerSetup ? { providerSetup: true } : {}),
  }
}

/**
 * Quiet status line for stream progress. Agent machinery collapses to one
 * label; thinking events surface nothing.
 */
export function statusLabelForProgressEvent(event: ChatProgressEvent): string | null {
  switch (event.type) {
    case 'thinking':
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
