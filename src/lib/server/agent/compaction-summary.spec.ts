import { describe, expect, it, vi } from 'vitest'
import { OutputScriptError } from '$lib/server/llm/output-language'
import {
  COMPACTION_TASK_NAME,
  compactionExtension,
  serializeTranscript,
  writeCompactionSummary,
  type CompactionSummaryDeps,
} from './compaction-summary'
import type { PiMessage } from './pi-durable'

const answer = (content: string) => ({ choices: [{ message: { content } }] })

const MESSAGES = [
  { role: 'user', content: 'Draft the Acme offer, please.', timestamp: 1 },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'secret reasoning' },
      { type: 'text', text: 'Looking up Acme.' },
      { type: 'toolCall', id: 'c1', name: 'contacts.get', arguments: { name: 'Acme' } },
    ],
    timestamp: 2,
  },
  { role: 'toolResult', toolCallId: 'c1', toolName: 'contacts.get', content: [{ type: 'text', text: '{"name":"Acme GmbH"}' }], timestamp: 3 },
] as unknown as PiMessage[]

function deps(over: Partial<CompactionSummaryDeps> = {}): CompactionSummaryDeps & { complete: ReturnType<typeof vi.fn> } {
  const complete = vi.fn(async (_: unknown) => answer('## Goal\nDraft the Acme offer.'))
  return {
    complete,
    conversation: async () => ({ llmUserId: 'u-1', task: 'assistant.chat' as never }),
    language: async () => 'en',
    ...over,
  } as CompactionSummaryDeps & { complete: ReturnType<typeof vi.fn> }
}

describe('the chat compaction summary (wish d0a0c775: the person’s language, no foreign script)', () => {
  it('serializes the transcript as text: messages and tool calls, never thinking', () => {
    const text = serializeTranscript(MESSAGES)
    expect(text).toContain('Draft the Acme offer, please.')
    expect(text).toContain('Looking up Acme.')
    expect(text).toContain('contacts.get')
    expect(text).toContain('Acme GmbH')
    expect(text).not.toContain('secret reasoning')
  })

  it("asks through the gateway as the conversation's person, in their language, billed to the conversation's task", async () => {
    const d = deps({ language: async () => 'de' })
    expect(await writeCompactionSummary(d, { conversationId: '7', messages: MESSAGES })).toBe('## Goal\nDraft the Acme offer.')
    expect(d.complete).toHaveBeenCalledTimes(1)
    const call = d.complete.mock.calls[0]![0] as { userId: string; task: string; messages: { role: string; content: string }[] }
    expect(call).toMatchObject({ userId: 'u-1', task: 'assistant.chat' })
    expect(call.messages[0]!.content).toContain('Write the whole text in German only.')
    expect(call.messages[1]!.content).toContain('Draft the Acme offer, please.')
  })

  it('a summary in a foreign script fails the compaction loud (OutputScriptError), never placed', async () => {
    const d = deps({ complete: vi.fn(async () => answer('## Goal\n起草 the Acme offer.')) })
    await expect(writeCompactionSummary(d, { conversationId: '7', messages: MESSAGES })).rejects.toBeInstanceOf(OutputScriptError)
  })

  it('an empty summary fails loud', async () => {
    const d = deps({ complete: vi.fn(async () => answer('   ')) })
    await expect(writeCompactionSummary(d, { conversationId: '7', messages: MESSAGES })).rejects.toThrow(/empty/)
  })

  it('a conversation missing from the index (no one to bill or read for) fails loud', async () => {
    const d = deps({ conversation: async () => undefined })
    await expect(writeCompactionSummary(d, { conversationId: '7', messages: MESSAGES })).rejects.toThrow(/not indexed/)
    const noTask = deps({ conversation: async () => ({ llmUserId: 'u-1', task: null }) })
    await expect(writeCompactionSummary(noTask, { conversationId: '7', messages: MESSAGES })).rejects.toThrow(/no AI task/)
  })

  it('the extension hooks pi-durable’s compaction and returns the summary as its decision', async () => {
    const d = deps()
    const ext = compactionExtension(d)
    expect(ext.hooks).toHaveLength(1)
    const reg = ext.hooks![0]!
    expect(reg.task).toBe(COMPACTION_TASK_NAME)
    const handlers = reg.handlers as { beforeCompact: (c: unknown, api: unknown) => Promise<unknown> }
    const decision = await handlers.beforeCompact({ reason: 'threshold', entries: [], messages: MESSAGES, firstKept: 4 }, { conversationId: 7 })
    expect(decision).toEqual({ summary: '## Goal\nDraft the Acme offer.' })
  })
})
