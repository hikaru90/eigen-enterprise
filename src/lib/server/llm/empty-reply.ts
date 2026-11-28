import type { ErrorReport } from '$lib/errors/agent-report'
import { errorReport } from '$lib/server/errors/report'

/**
 * Why a model turn ended without text (wish c37fcfe6, 2026-11-28: "The assistant did not produce
 * a response." told nobody why or what to change). Read from the model's own structured stop
 * reason (pi-ai `stopReason`, the gateway's `finish_reason`), never from message text; every
 * cause has a sentence for the person (what happened, what to do) and next steps for the agent.
 */
export const EMPTY_REPLY_CAUSES = [
  /** The reply hit the output-token limit before any text (finish_reason length). */
  'output_limit',
  /** The provider's content filter withheld the reply (finish_reason content_filter). */
  'content_filter',
  /** The model call failed (stopReason error) — the provider's error is the detail. */
  'provider_error',
  /** The turn ended on a tool call: the agent loop ran out of steps before writing an answer. */
  'tool_loop_limit',
  /** The turn was stopped (aborted) before it answered. */
  'aborted',
  /** The model finished normally (stop) and wrote nothing. */
  'no_text',
] as const
export type EmptyReplyCause = (typeof EMPTY_REPLY_CAUSES)[number]

/** The structured fields of the final assistant message (pi-ai AssistantMessage). */
export type FinalMessageStop = { stopReason?: string; rawStopReason?: string; errorMessage?: string }

/** The cause, from the final message's stop fields (a closed mapping; an unknown stop reason fails loud). */
export function emptyReplyCause(stop: FinalMessageStop): EmptyReplyCause {
  if (stop.rawStopReason === 'content_filter') return 'content_filter'
  switch (stop.stopReason) {
    case 'length':
      return 'output_limit'
    case 'error':
      return 'provider_error'
    case 'toolUse':
      return 'tool_loop_limit'
    case 'aborted':
      return 'aborted'
    case 'stop':
    case undefined:
      return 'no_text'
    default:
      throw new Error(`a model turn ended with an unknown stop reason "${stop.stopReason}"`)
  }
}

const SENTENCE: Record<EmptyReplyCause, string> = {
  output_limit:
    'I ran out of room before I could write an answer (the reply hit its length limit). Ask for less at once — one question, or a shorter result — and I will answer.',
  content_filter:
    "The AI provider's content filter held back my answer. Rephrase the request without the part that could read as unsafe, and send it again.",
  provider_error: 'The AI model call failed, so I have no answer. Try again in a moment; if it keeps failing, the error below is what to give the team.',
  tool_loop_limit:
    'I used all my steps on looking things up and ran out before writing the answer. Ask for one thing at a time, or name where to look, and I will answer.',
  aborted: 'This turn was stopped before I answered. Send the message again if you still need the answer.',
  no_text: 'The AI model ended its turn without writing anything. Send the message again; if it happens again, rephrase it or split it into smaller questions.',
}

const AGENT_STEPS: Record<EmptyReplyCause, string[]> = {
  output_limit: [
    "The final model call stopped on finish_reason length before any text: the completion budget (maxTokens, DEFAULT_CHAT_MAX_TOKENS in src/lib/server/llm/llm-client.ts) was used up, often by a huge tool result or by reasoning tokens. Check the turn's AI usage row (completion tokens) and shorten the context it was given; do not just raise the limit.",
  ],
  content_filter: [
    "The provider returned finish_reason content_filter. Nothing to fix in code unless the system prompt or a tool result triggered it: check the turn's trace for the input that did.",
  ],
  provider_error: [
    'The final assistant message has stopReason error; `cause` carries the provider error. Check the gateway (src/lib/server/llm/llm-client.ts) log line for the same trace and the provider status.',
  ],
  tool_loop_limit: [
    'The durable turn ended on a tool call without a final text answer (the loop hit its step limit). Look at the trace: a tool that keeps failing or returning too little makes the agent loop; fix that tool or its description.',
  ],
  aborted: ['The run was aborted (edit-and-resend, shutdown). Nothing to fix unless it happens without a person stopping it.'],
  no_text: [
    'The model returned finish_reason stop with empty content. Check the turn trace (the last request\'s messages); repeated empty answers from one model are a pool question (src/lib/server/llm/model-pool.ts), not a prompt patch.',
  ],
}

export class EmptyReplyError extends Error {
  constructor(
    readonly emptyCause: EmptyReplyCause,
    /** The provider's own error text (provider_error), kept for the agent report. */
    readonly detail?: string,
  ) {
    super(`the model turn ended without an answer: ${emptyCause}${detail ? ` (${detail})` : ''}`)
    this.name = 'EmptyReplyError'
  }
}

/** The EmptyReplyError in an error's cause chain (a durable run wraps it), or null. */
export function findEmptyReplyError(err: unknown): EmptyReplyError | null {
  let cur: unknown = err
  for (let i = 0; i < 8 && cur instanceof Error; i++) {
    if (cur instanceof EmptyReplyError) return cur
    cur = cur.cause
  }
  return null
}

/** What the person reads: the cause and what to change. */
export function emptyReplySentence(cause: EmptyReplyCause): string {
  return SENTENCE[cause]
}

/** The agent report (src/lib/server/errors/report.ts) for an empty reply. */
export function emptyReplyReport(err: EmptyReplyError, attempted: string): ErrorReport {
  return errorReport(err, { attempted, plain: () => emptyReplySentence(err.emptyCause), nextSteps: AGENT_STEPS[err.emptyCause] })
}
