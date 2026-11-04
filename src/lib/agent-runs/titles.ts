/**
 * Owner-facing words for the assistant's conversation list (C3b, polish P-1). Shared by server and
 * client — no server imports here. Runs are told apart structurally: a
 * background run carries a run principal, a chat run does not (its
 * `llm_user_id` is the member who chatted).
 */

export type RunTitleInput = {
  conversationKey: string
  /** A background run (it has a run principal); otherwise a chat. */
  background: boolean
  /** The chatting member's display name, when known. */
  memberName: string | null
  /** A chat's first message (what the conversation is about), when known. */
  topic?: string | null
}

/** Longest title the conversation lists show before cutting with an ellipsis. */
const TOPIC_MAX = 72

export function runTitle(input: RunTitleInput): string {
  if (!input.background) {
    const topic = input.topic?.replace(/\s+/g, ' ').trim()
    if (topic) return topic.length > TOPIC_MAX ? `${topic.slice(0, TOPIC_MAX - 1).trimEnd()}…` : topic
    return `Chat with ${input.memberName?.trim() || 'a team member'}`
  }
  const colon = input.conversationKey.indexOf(':')
  const task =
    colon >= 0
      ? input.conversationKey
          .slice(colon + 1)
          .replace(/[_.:-]+/g, ' ')
          .trim()
      : ''
  return task ? `Background task: ${task}` : 'Background task'
}

/**
 * A failed turn's plain explanation. The pi-durable reason and detail stay
 * available behind the feed's "details" toggle; this sentence is what the
 * owner reads first. Matching is on the reason code plus the provider
 * configuration error's fixed prefix — never on free-form meaning.
 */
export function failureExplanation(reason: string, detail: string | undefined): string {
  if (reason === 'budget_exceeded') return 'The agent reached its spending limit.'
  if (detail && /not configured/i.test(detail))
    return "The AI provider isn't set up. Connect one in Settings › AI provider."
  if (reason === 'model_error') return "The AI provider didn't answer. Try again in a moment."
  return 'The turn stopped before it finished.'
}
