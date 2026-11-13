import type { LlmContentOrigin } from './types'
import { llmCreateTranscription } from './llm-client'

/**
 * OpenRouter model id for speech-to-text (`/audio/transcriptions`) — fixed in code, there is
 * no environment override (as in eigen). It must have live endpoints that accept browser
 * `webm`/opus and Safari `m4a` uploads. Qwen3 ASR 0.6B is eigen's choice (2026-10-28; 1.7b hung
 * or was slow). `qwen/qwen3-asr-flash-2026-02-10`, used here before, has no OpenRouter
 * endpoints, so every clip failed with "Couldn't transcribe the recording" (2026-11-11).
 * Known trade-off: 0.6B can invent text on quiet audio — stopped before the upload by the
 * browser's check (`$lib/voice/clip-speech.ts`) and judged by an LLM after (`stt-judge.ts`).
 */
export const STT_MODEL = 'qwen/qwen3-asr-0.6b'

export type SttAudioInput = {
  bytes: Uint8Array
  format: string
  language?: string
}

/**
 * Parses transcript text from a dedicated STT body (`{ text }` only; `""` = no speech).
 * Chat-completion shaped bodies are rejected — they often contain assistant replies, not verbatim speech.
 */
export function parseSttTranscript(body: unknown): string {
  if (!body || typeof body !== 'object') {
    throw new Error('STT response missing body')
  }
  const dedicated = (body as { text?: unknown }).text
  // an empty string is a real answer: the clip held no speech
  if (typeof dedicated === 'string') {
    return dedicated.trim()
  }
  if ('choices' in body) {
    throw new Error(
      'STT response used chat completion shape; configure a dedicated /audio/transcriptions model',
    )
  }
  throw new Error('STT response missing transcript text')
}

/**
 * Transcribes audio via OpenRouter (`POST /audio/transcriptions`).
 */
export async function transcribeAudio(input: {
  userId: string
  audio: SttAudioInput
  /** `'memory'` for a voice note to Memory: the transcript is never logged. */
  contentOrigin?: LlmContentOrigin
}): Promise<string> {
  const body = await llmCreateTranscription({
    userId: input.userId,
    model: STT_MODEL,
    audio: input.audio,
    contentOrigin: input.contentOrigin,
  })
  return parseSttTranscript(body)
}
