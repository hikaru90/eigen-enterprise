import type { LlmContentOrigin } from './types'
import type { AiTaskId } from '$lib/ai-usage/tasks'
import { llmCreateTranscription } from './llm-client'

/**
 * Speech to text (`/audio/transcriptions`) runs on the company's speech-to-text slot (CB1,
 * `model-pool.ts`): one model for every transcript in the app — dictation, Memory voice notes
 * and their live previews, and call transcripts. Today the pool's pick is
 * `qwen/qwen3-asr-1.7b` (owner, 2026-11-19, on price: about $0.03 per hour of audio against
 * $0.36 for `openai/gpt-4o-transcribe`, which it replaced). Every pool model must have live
 * endpoints that accept browser `webm`/opus and Safari `m4a` uploads (checked at boot and on
 * Settings → AI). Known trade-off: it is weaker on names than gpt-4o-transcribe, and its
 * OpenRouter endpoints list no supported parameters, so the vocabulary prompt
 * (`stt-vocabulary.ts`) is sent but may have no effect. Quiet audio is still stopped before the
 * upload by `$lib/voice/clip-speech.ts` and judged after by `stt-judge.ts`.
 *
 * When eigenInference runs on Opper the slot's pick there is Mistral Voxtral
 * (`mistral/voxtral-mini-transcribe-3-0`, EU) on Opper's own transcription endpoint; Opper's
 * body has no vocabulary prompt, so none is sent.
 */

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
 * Transcribes audio on the company's speech-to-text slot (OpenRouter or Opper, llm-client.ts).
 */
export async function transcribeAudio(input: {
  userId: string
  audio: SttAudioInput
  task: AiTaskId
  /** `'memory'` for a voice note to Memory: the transcript is never logged. */
  contentOrigin?: LlmContentOrigin
}): Promise<string> {
  const body = await llmCreateTranscription({
    userId: input.userId,
    audio: input.audio,
    task: input.task,
    contentOrigin: input.contentOrigin,
  })
  return parseSttTranscript(body)
}
