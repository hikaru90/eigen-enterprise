import type { LlmContentOrigin } from './types'
import { llmCreateTranscription } from './llm-client'

/**
 * OpenRouter model ids for speech-to-text (`/audio/transcriptions`) — fixed in code, there is
 * no environment override (as in eigen). Each must have live endpoints that accept browser
 * `webm`/opus and Safari `m4a` uploads (checked at boot and on Settings → AI provider).
 *
 * The transcript a person keeps: `openai/gpt-4o-transcribe` (2026-11-17, Contribute be1ad246 —
 * "some words aren't recognised" on German dictation). It is the most accurate model OpenRouter
 * serves for German and for names, answers a 1-minute clip in a few seconds, and takes a
 * vocabulary prompt (`stt-vocabulary.ts`). It replaced `qwen/qwen3-asr-0.6b` (eigen's pick for
 * cost: the smallest model, weakest on German and on names, and prone to inventing text on
 * quiet audio — still stopped before the upload by `$lib/voice/clip-speech.ts` and judged after
 * by `stt-judge.ts`).
 */
export const STT_MODEL = 'openai/gpt-4o-transcribe'

/**
 * Live previews while a Memory voice note records (`/api/capture/transcribe-chunk`): the
 * whole clip so far is re-sent every few seconds and each preview is replaced by the final
 * transcript, so the cheapest live model does it — the final text always comes from
 * {@link STT_MODEL}.
 */
export const STT_PREVIEW_MODEL = 'qwen/qwen3-asr-0.6b'

export type SttAudioInput = {
  bytes: Uint8Array
  format: string
  /** ISO-639-1: forces the language. Only sent when a person chose it — never a default. */
  language?: string
  /** Spelling/vocabulary context (`stt-vocabulary.ts`); never forces a language. */
  prompt?: string
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
  /** `'preview'`: a live preview that the final transcript replaces ({@link STT_PREVIEW_MODEL}). */
  pass?: 'final' | 'preview'
}): Promise<string> {
  const body = await llmCreateTranscription({
    userId: input.userId,
    model: input.pass === 'preview' ? STT_PREVIEW_MODEL : STT_MODEL,
    audio: input.audio,
    contentOrigin: input.contentOrigin,
  })
  return parseSttTranscript(body)
}
