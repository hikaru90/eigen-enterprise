import { moduleSource } from '$lib/kernel/cloudevents'
import { emitKernelEvent, type EventSink, type KernelEvent } from '$lib/kernel/events'
import { listTelegramOwnerChats } from './query'
import { recapTypeCounts, type RecapSummary } from './summarize'
import { RECAP_COMPLETED_EVENT, RECAP_MODULE_ID, type RecapDeps } from './types'

/**
 * Delivery: format the summary as plain text (no markdown — sendMessage is
 * sent parse-mode-less), split to telegram-safe chunks, send to every
 * allowlisted owner chat, and emit `recap.completed` (metadata only: counts,
 * window, delivered chats — never summary lines or event payloads).
 */

/** Match the chat-gateway's outbound limit (UTF-16 code points). */
export const RECAP_MESSAGE_MAX_LEN = 4000

export function formatRecapWindow(window: { start: Date; end: Date }): string {
  return `${window.start.toISOString()} → ${window.end.toISOString()}`
}

/** Plain-text telegram message: headline + window + lines, no markdown. */
export function formatRecapText(
  summary: RecapSummary,
  window: { start: Date; end: Date },
): string {
  return `${summary.headline}\nWindow: ${formatRecapWindow(window)}\n\n${summary.lines.join('\n')}`
}

/** Split on UTF-16 code points so surrogate pairs never break mid-character. */
function hardWrap(text: string, maxLen: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const char of text) {
    if (current !== '' && current.length + char.length > maxLen) {
      chunks.push(current)
      current = char
    } else {
      current += char
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

/**
 * Chunk a recap to telegram-safe pieces: paragraph boundaries (\n\n) first,
 * then hard-wrap. Every chunk is non-empty and at most `maxLen` UTF-16 units.
 */
export function chunkRecapText(text: string, maxLen = RECAP_MESSAGE_MAX_LEN): string[] {
  if (maxLen < 1) throw new RangeError(`chunkRecapText maxLen must be >= 1, got ${maxLen}`)
  if (text.trim().length === 0) return []
  const chunks: string[] = []
  let current = ''
  for (const paragraph of text.split(/\n{2,}/)) {
    const pieces = paragraph.length > maxLen ? hardWrap(paragraph, maxLen) : [paragraph]
    for (const piece of pieces) {
      if (current === '') {
        current = piece
      } else if (current.length + 2 + piece.length <= maxLen) {
        current += `\n\n${piece}`
      } else {
        chunks.push(current)
        current = piece
      }
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

export type DeliverRecapInput = {
  summary: RecapSummary
  window: { start: Date; end: Date }
  /** Events the summary was built from — only counts/events are derived, never content. */
  events: readonly KernelEvent[]
}

export type DeliverRecapResult = {
  deliveredChats: string[]
  chunkCount: number
  eventCount: number
}

/**
 * Deliver one recap: resolve allowlisted owner chats, send chunked plain text,
 * emit `recap.completed`. With zero owner sessions the run still completes
 * (event emitted, deliveredChats: []) — the owner simply has no chat yet.
 * Throws loud on any send failure (no silent degradation).
 */
export async function deliverRecap(
  deps: RecapDeps,
  input: DeliverRecapInput,
): Promise<DeliverRecapResult> {
  const chats = await listTelegramOwnerChats(deps.db, deps.allowlist)
  const chunks = chunkRecapText(formatRecapText(input.summary, input.window))

  let chunkCount = 0
  for (const chatId of chats) {
    for (const chunk of chunks) {
      await deps.telegram.sendMessage(chatId, chunk)
      chunkCount += 1
    }
  }

  await emitKernelEvent(deps.eventSink, {
    type: RECAP_COMPLETED_EVENT,
    source: moduleSource(RECAP_MODULE_ID),
    // Metadata only — counts + window + delivery targets.
    payload: {
      windowStart: input.window.start.toISOString(),
      windowEnd: input.window.end.toISOString(),
      eventCount: input.events.length,
      typeCounts: recapTypeCounts(input.events),
      deliveredChats: chats,
      chunkCount,
    },
  })

  return { deliveredChats: chats, chunkCount, eventCount: input.events.length }
}

/**
 * Standalone emitter for callers that computed counts elsewhere (same payload
 * contract as deliverRecap's event).
 */
export async function emitRecapCompleted(
  eventSink: EventSink,
  payload: {
    windowStart: string
    windowEnd: string
    eventCount: number
    typeCounts: Record<string, number>
    deliveredChats: string[]
    chunkCount: number
  },
): Promise<void> {
  await emitKernelEvent(eventSink, {
    type: RECAP_COMPLETED_EVENT,
    source: moduleSource(RECAP_MODULE_ID),
    payload,
  })
}
