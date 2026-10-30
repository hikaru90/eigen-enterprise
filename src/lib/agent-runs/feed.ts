/**
 * The D8 run view's wire + view model (plan/phase-durable.md D8). The server
 * projects pi-durable's agent events into these metadata-only feed items
 * (src/lib/server/agent-runs/project.ts); the browser folds them into lines.
 * Shared by server and client — no server imports here.
 */

/** One durable conversation, as the run list shows it. Metadata only. */
export type RunSummary = {
  id: number
  conversationKey: string
  agentId: string
  createdAt: string
  updatedAt: string
}

export type ToolOutcome = 'ok' | 'error' | 'unfinished'

export type FeedItem =
  | { kind: 'run_start' }
  | { kind: 'run_end' }
  | { kind: 'user_input'; text: string }
  | { kind: 'text_delta'; delta: string }
  | { kind: 'assistant_text'; text: string }
  | { kind: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { kind: 'tool_end'; toolCallId: string; toolName: string; outcome: ToolOutcome }

/** The `snapshot` SSE frame: the whole feed at attachment (or after an overflow). */
export type RunSnapshot = { running: boolean; items: FeedItem[] }

/** The `batch` SSE frame: everything one commit changed. */
export type RunBatch = { items: FeedItem[] }

export type FeedLine = {
  key: number
  kind: 'user' | 'assistant' | 'tool' | 'run'
  text: string
  status: 'running' | 'done' | 'error' | 'unfinished'
  toolCallId?: string
  args?: unknown
}

export type FeedState = { running: boolean; lines: FeedLine[]; nextKey: number }

export function feedFromSnapshot(snapshot: RunSnapshot): FeedState {
  return applyBatch({ running: snapshot.running, lines: [], nextKey: 0 }, snapshot.items)
}

/** Pure fold of one batch into the feed (never mutates `state`). */
export function applyBatch(state: FeedState, items: readonly FeedItem[]): FeedState {
  const lines = [...state.lines]
  let { running, nextKey } = state
  const push = (line: Omit<FeedLine, 'key'>) => lines.push({ key: nextKey++, ...line })
  const streamingIndex = () => {
    const last = lines.length - 1
    return last >= 0 && lines[last].kind === 'assistant' && lines[last].status === 'running'
      ? last
      : -1
  }

  for (const item of items) {
    switch (item.kind) {
      case 'run_start':
        running = true
        push({ kind: 'run', text: 'Run started', status: 'done' })
        break
      case 'run_end': {
        running = false
        const open = streamingIndex()
        if (open >= 0) lines[open] = { ...lines[open], status: 'done' }
        push({ kind: 'run', text: 'Run finished', status: 'done' })
        break
      }
      case 'user_input':
        push({ kind: 'user', text: item.text, status: 'done' })
        break
      case 'text_delta': {
        const open = streamingIndex()
        if (open >= 0) lines[open] = { ...lines[open], text: lines[open].text + item.delta }
        else push({ kind: 'assistant', text: item.delta, status: 'running' })
        break
      }
      case 'assistant_text': {
        const open = streamingIndex()
        if (open >= 0) lines[open] = { ...lines[open], text: item.text, status: 'done' }
        else push({ kind: 'assistant', text: item.text, status: 'done' })
        break
      }
      case 'tool_start':
        push({
          kind: 'tool',
          text: item.toolName,
          status: 'running',
          toolCallId: item.toolCallId,
          args: item.args,
        })
        break
      case 'tool_end': {
        const status = item.outcome === 'ok' ? 'done' : item.outcome
        const at = lines.findIndex((l) => l.kind === 'tool' && l.toolCallId === item.toolCallId)
        if (at >= 0) lines[at] = { ...lines[at], status }
        else push({ kind: 'tool', text: item.toolName, status, toolCallId: item.toolCallId })
        break
      }
    }
  }
  return { running, lines, nextKey }
}

/** The browser's EventSource state, as the feed header shows it. */
export type RunConnection = 'connecting' | 'live' | 'ended' | 'lost'
