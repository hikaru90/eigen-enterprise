import type { ChatStreamEvent } from './chat-stream-types'

export type ChatNdjsonDone = Extract<ChatStreamEvent, { type: 'done' }>

export type ChatProgressEvent = Exclude<ChatStreamEvent, { type: 'done' } | { type: 'error' }>

export class ChatStreamError extends Error {
  readonly details?: string[]
  /** Structured failure kind from the server (e.g. 'llm_not_configured'). */
  readonly code?: string

  constructor(event: Extract<ChatStreamEvent, { type: 'error' }>) {
    super(event.error || 'Chat failed')
    this.name = 'ChatStreamError'
    this.details = event.details
    this.code = event.code
  }
}

/** Shown for any client-side failure (network, HTTP status, broken stream). */
export const CHAT_CLIENT_FAILURE_MESSAGE =
  'I could not reach the assistant just now. Please try again in a moment.'

/**
 * What the user reads when a chat turn fails. Only the server's terminal
 * error frame (a fixed, human message set by the chat entry) is shown
 * verbatim; every other error is replaced by a fixed message — raw error
 * text never reaches the transcript (code <-> harness <-> user).
 */
export function chatFailureMessage(err: unknown): string {
  if (err instanceof ChatStreamError && err.message.trim().length > 0) return err.message
  return CHAT_CLIENT_FAILURE_MESSAGE
}

function parseNdjsonLine(line: string): ChatStreamEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as ChatStreamEvent
  } catch {
    throw new Error(`Chat stream contained invalid data (${trimmed.slice(0, 80)}).`)
  }
}

export async function consumeChatNdjsonStream(
  res: Response,
  onEvent: (event: ChatProgressEvent) => void,
  signal?: AbortSignal,
): Promise<ChatNdjsonDone> {
  const reader = res.body?.getReader()
  if (!reader) {
    throw new Error('Chat response had no body to read.')
  }

  signal?.addEventListener('abort', () => {
    void reader.cancel()
  })

  const decoder = new TextDecoder()
  let buffer = ''

  const dispatchLine = (rawLine: string): ChatNdjsonDone | 'continue' => {
    const event = parseNdjsonLine(rawLine)
    if (!event) return 'continue'

    if (event.type === 'error') {
      throw new ChatStreamError(event)
    }
    if (event.type === 'done') {
      return event
    }

    onEvent(event)
    return 'continue'
  }

  const flushBuffer = (): ChatNdjsonDone | 'continue' => {
    const remaining = buffer.trim()
    buffer = ''
    if (!remaining) return 'continue'
    return dispatchLine(remaining)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const result = dispatchLine(rawLine)
        if (result !== 'continue') return result
      }
      if (done) break
    }

    const trailing = flushBuffer()
    if (trailing !== 'continue') return trailing
  } catch (e) {
    if (e instanceof Error && (e.name === 'AbortError' || signal?.aborted)) {
      throw new DOMException('Chat cancelled', 'AbortError')
    }
    throw e
  }

  if (signal?.aborted) {
    throw new DOMException('Chat cancelled', 'AbortError')
  }
  throw new Error('Chat stream ended before completion.')
}
