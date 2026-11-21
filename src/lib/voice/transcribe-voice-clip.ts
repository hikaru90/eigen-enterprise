import { shownErrorOf, type AgentReport } from '$lib/errors/agent-report'

/** Where a voice message is transcribed (`src/routes/api/voice/transcribe`). */
export const VOICE_TRANSCRIBE_URL = '/api/voice/transcribe'

/**
 * A failed transcribe request, keeping the HTTP status (503 = no company AI provider) and
 * the server's agent report (the one error shape), when it sent one.
 */
export class TranscribeRequestError extends Error {
  readonly status: number
  readonly agent: AgentReport | null
  constructor(status: number, message: string, agent?: AgentReport | null) {
    super(message)
    this.name = 'TranscribeRequestError'
    this.status = status
    this.agent = agent ?? null
  }
}

/**
 * Combines a pre-existing draft with a voice transcript by appending the transcript to the
 * draft — a voice message must not overwrite text the person already typed. Both sides are
 * trimmed and separated by a single space. Returns the draft unchanged when the transcript
 * is empty, and the transcript alone when the draft is empty.
 */
export function appendVoiceTranscript(draft: string, transcript: string): string {
  const text = transcript.trim()
  if (!text) return draft
  const base = draft.trimEnd()
  if (!base) return text
  return `${base} ${text}`
}

/** A refused transcribe answer: its sentence (`error`, or SvelteKit's `message`) and its agent report. */
export async function readTranscribeErrorResponse(
  res: Response,
): Promise<{ message: string; agent: AgentReport | null }> {
  // Response bodies are one-shot — read once, then parse.
  const raw = await res.text()
  let serverMessage = ''
  let agent: AgentReport | null = null
  try {
    const payload = JSON.parse(raw) as { error?: unknown; message?: unknown; agent?: unknown }
    if (typeof payload.error === 'string' && payload.error.trim()) serverMessage = payload.error
    else if (typeof payload.message === 'string' && payload.message.trim())
      serverMessage = payload.message
    if (serverMessage)
      agent = shownErrorOf({ error: serverMessage, agent: payload.agent })?.agent ?? null
  } catch {
    serverMessage = raw.trim()
  }
  return { message: serverMessage || `Transcription failed (${res.status})`, agent }
}

export async function parseTranscribeErrorResponse(res: Response): Promise<string> {
  return (await readTranscribeErrorResponse(res)).message
}

/**
 * Sends one whole voice clip and returns its transcript. An empty string is a valid result
 * (no speech). Any failure throws {@link TranscribeRequestError} (or the network's own error)
 * — never a silent empty text.
 *
 * The clip goes as the raw request body with its audio MIME type as `content-type`, not as
 * multipart: raw audio content types are exempt from SvelteKit's CSRF origin check. No
 * language hint is sent: the model identifies the spoken language.
 */
export async function transcribeVoiceClip(
  clip: Blob,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const res = await fetch(VOICE_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { 'content-type': clip.type || 'application/octet-stream' },
    body: clip,
    credentials: 'same-origin',
    signal: options?.signal,
  })
  if (!res.ok) {
    const refused = await readTranscribeErrorResponse(res)
    throw new TranscribeRequestError(res.status, refused.message, refused.agent)
  }
  const payload = (await res.json()) as { transcript?: unknown }
  if (typeof payload.transcript !== 'string') {
    throw new TranscribeRequestError(res.status, 'Transcription response missing transcript')
  }
  return payload.transcript.trim()
}
