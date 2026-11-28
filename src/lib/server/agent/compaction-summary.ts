import type { AiTaskId } from '$lib/ai-usage/tasks'
import type { ChatMessage } from '$lib/server/llm/llm-client'
import { assertOutputScript, outputLanguageInstruction } from '$lib/server/llm/output-language'
import { extractChatContent } from '$lib/server/ontology/llm-json'
import type { GatewayCompleteFn } from './gateway-model'
import { CompactionTask, defineExtension, hook, type Extension, type PiMessage } from './pi-durable'

/**
 * The summary a long assistant / co-worker conversation is compacted into (wish d0a0c775,
 * 2026-11-28: "no weird Chinese characters in summaries"). pi-durable's built-in compaction
 * names no output language, so a drifting model could slip its own script into the summary the
 * conversation then continues from. Its `beforeCompact` hook lets the host write the summary:
 * this one asks through the gateway (cost tracked, as the conversation's person, under the
 * conversation's task) in that person's language, and checks the script before it is placed.
 * A refused or empty summary throws — the compaction task fails loud (its status says why)
 * and the conversation keeps its uncompacted context; nothing bad is ever placed.
 */

export const COMPACTION_EXTENSION = 'ee.compaction-summary'
/** pi-durable's built-in compaction task (CompactionTask). */
export const COMPACTION_TASK_NAME = 'pi.compaction'
/** Longest tool result text the summarizer reads (pi-durable's own bound). */
const TOOL_RESULT_MAX_CHARS = 2000
const SUMMARY_MAX_TOKENS = 4096

const SYSTEM = [
  'You are a context summarization assistant. You read a conversation between a person and an AI assistant and write a structured summary that the assistant continues the work from.',
  'Do NOT continue the conversation. Do NOT answer any question in it. ONLY write the summary.',
].join('\n')

const FORMAT = `Create a structured context checkpoint summary of the conversation above. If it starts with an earlier summary, keep its information and fold the newer messages into it.

Use this format:

## Goal
[What the person is trying to get done; several items if the conversation covers several tasks.]

## Constraints & Preferences
- [Constraints, preferences or requirements the person stated, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [What is blocking progress, if anything]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next, in order]

## Critical Context
- [Data, examples or references needed to continue, or "(none)"]

Keep each section concise. Keep names, ids, numbers and error messages exactly as written.`

export type CompactionSummaryDeps = {
  complete: GatewayCompleteFn
  /** The conversation's person (billing + language) and task, from the conversation index. */
  conversation: (piConversationId: string) => Promise<{ llmUserId: string; task: AiTaskId | null } | undefined>
  /** The language that person reads in. */
  language: (userId: string) => Promise<string>
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: { type?: string; text?: string }) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** Messages as plain text, so the summarizer reads a transcript instead of continuing it. System messages and thinking are left out. */
export function serializeTranscript(messages: readonly PiMessage[]): string {
  const out: string[] = []
  for (const m of messages) {
    if (m.role === 'user') out.push(`[Person]: ${textOf(m.content)}`)
    else if (m.role === 'assistant') {
      const text = textOf(m.content)
      if (text) out.push(`[Assistant]: ${text}`)
      for (const block of m.content) {
        if (block.type === 'toolCall') out.push(`[Assistant tool call]: ${block.name}(${JSON.stringify(block.arguments)})`)
      }
    } else if (m.role === 'toolResult') {
      const text = textOf(m.content)
      const cut = text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}… (cut)` : text
      out.push(`[Tool result ${m.toolName}]: ${cut}`)
    }
  }
  return out.join('\n\n')
}

/** Writes the summary, or throws (OutputScriptError on a foreign script). */
export async function writeCompactionSummary(
  deps: CompactionSummaryDeps,
  input: { conversationId: string; messages: readonly PiMessage[]; instructions?: string },
): Promise<string> {
  const row = await deps.conversation(input.conversationId)
  if (!row) {
    throw new Error(`durable conversation ${input.conversationId} is not indexed — refusing an anonymous compaction summary call`)
  }
  if (!row.task) {
    throw new Error(`durable conversation ${input.conversationId} has no AI task recorded — refusing an unnamed compaction summary call`)
  }
  const language = await deps.language(row.llmUserId)
  const transcript = serializeTranscript(input.messages)
  const focus = input.instructions ? `\n\nAdditional focus: ${input.instructions}` : ''
  const messages: ChatMessage[] = [
    { role: 'system', content: `${SYSTEM}\n${outputLanguageInstruction(language)}` },
    { role: 'user', content: `<conversation>\n${transcript}\n</conversation>\n\n${FORMAT}${focus}` },
  ]
  const response = await deps.complete({ userId: row.llmUserId, messages, temperature: 0, maxTokens: SUMMARY_MAX_TOKENS, task: row.task })
  const summary = extractChatContent(response).trim()
  if (!summary) throw new Error(`the compaction summary of durable conversation ${input.conversationId} came back empty`)
  return assertOutputScript(summary, { language, what: 'conversation compaction summary', source: transcript })
}

/** The extension installed on the harness registry: every conversation's compaction goes through it. */
export function compactionExtension(deps: CompactionSummaryDeps): Extension {
  return defineExtension({
    name: COMPACTION_EXTENSION,
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async (compaction, api) => ({
          summary: await writeCompactionSummary(deps, {
            conversationId: String(api.conversationId),
            messages: compaction.messages,
            ...(compaction.instructions === undefined ? {} : { instructions: compaction.instructions }),
          }),
        }),
      }),
    ],
  })
}
