import type { AiTaskId } from '$lib/ai-usage/tasks'
import { assertOutputScript } from '$lib/server/llm/output-language'
import { brainAnswerMessages, brainRecapMessages, type CallBrain } from './brain'

/**
 * The live Company Brain (./brain.ts): the assistant's server-side answer
 * path, reused — not a second agent. An answer is
 *
 *   1. the asker's own knowledge: composeAnswer (the assistant's Memory
 *      question path, `answer_question`) for the question, which says "not in
 *      memory" rather than guess;
 *   2. one gateway completion with the Brain's standing instructions, the
 *      transcript it heard, that memory answer and the question.
 *
 * Both run inside the asker's row-level-security session (withDbUser: only
 * what THEY may read) on the company's AI provider (onCompanyProvider: a
 * member needs no provider of their own); usage and cost are attributed to
 * the asker (the gateway's userId). The text is declared Memory
 * (contentOrigin 'memory'): never written to the server log or the AI usage
 * log. No tools: the Brain cannot post, write, ring or act — it only answers.
 *
 * A recap is step 2 alone, from the transcript, as whoever asked for it.
 */

type ChatMessage = { role: 'system' | 'user'; content: string }

export type LiveBrainDeps = {
  onCompanyProvider: <T>(fn: () => Promise<T>) => Promise<T>
  withDbUser: <T>(userId: string, fn: () => Promise<T>) => Promise<T>
  /** The asker's Memory answer to the question (composeAnswer), as text. */
  memoryAnswer: (userId: string, question: string) => Promise<string>
  /** The language a person reads generated text in (user_preference.preferred_language). */
  language: (userId: string) => Promise<string>
  /** The gateway's chat completion (llmChatCompletion). */
  complete: (input: { userId: string; messages: ChatMessage[]; temperature: number; task: AiTaskId; contentOrigin: 'memory' }) => Promise<unknown>
}

function replyText(response: unknown, what: string): string {
  const choices = (response as { choices?: unknown } | null)?.choices
  const content = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content : undefined
  if (typeof content !== 'string' || content.trim() === '') throw new Error(`calls: the Company Brain's model gave no ${what}`)
  return content.trim()
}

export function createLiveBrain(d: LiveBrainDeps): CallBrain {
  const asUser = <T>(userId: string, fn: () => Promise<T>) => d.onCompanyProvider(() => d.withDbUser(userId, fn))
  return {
    answer: (input) =>
      asUser(input.askerId, async () => {
        const memory = await d.memoryAnswer(input.askerId, input.question)
        const response = await d.complete({
          userId: input.askerId,
          messages: brainAnswerMessages({ ...input, memory }),
          temperature: 0,
          task: 'calls.brain_answer',
          contentOrigin: 'memory',
        })
        return replyText(response, 'answer')
      }),
    recap: (input) =>
      asUser(input.userId, async () => {
        const language = await d.language(input.userId)
        const response = await d.complete({
          userId: input.userId,
          messages: brainRecapMessages(input, language),
          temperature: 0,
          task: 'calls.brain_recap',
          contentOrigin: 'memory',
        })
        // A letter in a script the language is not written in (and the call did not contain) is refused, never stored.
        return assertOutputScript(replyText(response, 'recap'), {
          language,
          what: 'call recap',
          source: [input.callTitle, ...input.people, input.heard].join('\n'),
        })
      }),
  }
}

/** Production wiring: lazy imports keep the calls module free of DB/LLM imports at load. */
export const liveBrain: CallBrain = createLiveBrain({
  onCompanyProvider: async (fn) => {
    const { onCompanyProvider } = await import('$lib/server/llm/company-provider')
    return onCompanyProvider(fn)
  },
  withDbUser: async (userId, fn) => {
    const { withDbUser } = await import('$lib/server/db')
    return withDbUser(userId, () => fn())
  },
  memoryAnswer: async (userId, question) => {
    const { composeAnswer, formatComposedAnswerForUser } = await import('$lib/server/qa/compose-answer')
    return formatComposedAnswerForUser((await composeAnswer({ userId, question })).answer)
  },
  language: async (userId) => (await import('$lib/server/llm/user-language')).userOutputLanguage(userId),
  complete: async (input) => {
    const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
    return llmChatCompletion(input)
  },
})
