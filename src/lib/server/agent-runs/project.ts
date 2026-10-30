import type { FeedItem, RunSnapshot, ToolOutcome } from '$lib/agent-runs/feed'
import type { AgentEvent, PiMessage, SnapshotEvent } from '$lib/server/agent/pi-durable'
import { redactForLog } from '$lib/server/observability/redact-for-log'

/**
 * Projects pi-durable agent events (watchEvents) into the D8 feed: run
 * start/end, user input, assistant text (deltas + final), tool start/end.
 * Metadata only on the wire — tool OUTPUT, thinking blocks, usage and every
 * other pi-durable document stay on the server; tool args are key-redacted
 * (AGENTS.md: *key, *token, *secret, password).
 */

type EntryLike = { model?: readonly PiMessage[] }

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

function redactArgs(args: unknown): unknown {
  return redactForLog(args ?? {})
}

/** Items of one committed entry. `withToolCalls`: in a snapshot the transcript is the only tool record. */
function entryItems(entry: EntryLike, withToolCalls: boolean): FeedItem[] {
  const message = entry.model?.[0]
  if (!message) return []
  switch (message.role) {
    case 'user': {
      const text = textOf(message.content)
      return text ? [{ kind: 'user_input', text }] : []
    }
    case 'assistant': {
      const items: FeedItem[] = []
      const text = textOf(message.content)
      if (text) items.push({ kind: 'assistant_text', text })
      if (withToolCalls) {
        for (const block of message.content) {
          if (block.type === 'toolCall') {
            items.push({
              kind: 'tool_start',
              toolCallId: block.id,
              toolName: block.name,
              args: redactArgs(block.arguments),
            })
          }
        }
      }
      return items
    }
    case 'toolResult':
      return withToolCalls
        ? [
            {
              kind: 'tool_end',
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              outcome: message.isError ? 'error' : 'ok',
            },
          ]
        : []
    default:
      return []
  }
}

export function projectSnapshot(snapshot: SnapshotEvent): RunSnapshot {
  const items: FeedItem[] = snapshot.entries.flatMap((entry) => entryItems(entry, true))
  const seen = new Set(
    items.flatMap((i) => (i.kind === 'tool_start' ? [i.toolCallId] : [])),
  )
  for (const slot of snapshot.tools) {
    if (slot.status === 'running' && !seen.has(slot.callId)) {
      items.push({ kind: 'tool_start', toolCallId: slot.callId, toolName: slot.name, args: {} })
    }
  }
  const partial = snapshot.generation?.message
  if (partial) {
    const text = textOf(partial.content)
    if (text) items.push({ kind: 'text_delta', delta: text })
  }
  return { running: snapshot.run !== undefined, items }
}

function outcomeOf(entry: EntryLike | undefined): ToolOutcome {
  const message = entry?.model?.[0]
  if (!message || message.role !== 'toolResult') return 'unfinished'
  return message.isError ? 'error' : 'ok'
}

/** One commit's events → feed items. A `snapshot` event (overflow) is handled by the caller. */
export function projectEvents(events: readonly AgentEvent[]): FeedItem[] {
  const items: FeedItem[] = []
  for (const event of events) {
    switch (event.type) {
      case 'run_start':
        items.push({ kind: 'run_start' })
        break
      case 'run_end':
        items.push({ kind: 'run_end' })
        break
      case 'message_update':
        for (const change of event.changes) {
          if (change.type === 'text_delta') items.push({ kind: 'text_delta', delta: change.delta })
        }
        break
      case 'message_end':
        // Tool calls/results arrive as tool_execution_* events in live mode.
        items.push(...entryItems(event.entry, false))
        break
      case 'tool_execution_start':
        items.push({
          kind: 'tool_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: redactArgs(event.args),
        })
        break
      case 'tool_execution_end':
        items.push({
          kind: 'tool_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          outcome: event.result ? (event.result.isError ? 'error' : 'ok') : outcomeOf(event.entry),
        })
        break
      default:
        break
    }
  }
  return items
}
