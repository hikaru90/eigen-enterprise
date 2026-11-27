import type { AiTaskId } from '$lib/ai-usage/tasks'
import { env } from '$lib/server/env/private-env'
import { llmCreateSpeech } from './llm-client'

/**
 * Speech synthesis (`/audio/speech`) runs on the company's text-to-speech slot (CB1,
 * `model-pool.ts`); the pool's pick is Qwen TTS (`qwen/qwen-audio-3.0-tts-flash`, the successor
 * of qwen/qwen3-tts-flash-2026-02-10, which had no OpenRouter endpoints). The model is never
 * set by environment: `LLM_MODEL_TTS` is gone (a slot only holds a pool model).
 */

/**
 * Voice id passed through to the gateway model; must be one of the model's
 * `supported_voices` on OpenRouter (here: loongjohn, male; longanhuan_v3.6, female — the default). "alloy",
 * the old default, is listed by no OpenRouter speech model.
 */
export const TTS_VOICE_DEFAULT = 'longanhuan_v3.6'

const TTS_MAX_TEXT_CHARS = 4000

function ttsVoice(): string {
  const override = env.LLM_TTS_VOICE?.trim()
  if (!override) return TTS_VOICE_DEFAULT
  return override
}

/**
 * Synthesizes speech via the LLM gateway (`POST /audio/speech`, OpenAI-compatible).
 * The assistant's voice is the gateway's neural TTS — never the browser's
 * speechSynthesis robot voice. Empty text is refused at the door.
 */
export async function synthesizeSpeech(input: {
  userId: string
  text: string
  task: AiTaskId
}): Promise<Uint8Array> {
  const text = input.text.trim()
  if (!text) throw new Error('TTS refused: empty text')
  if (text.length > TTS_MAX_TEXT_CHARS) {
    throw new Error(`TTS refused: text exceeds ${TTS_MAX_TEXT_CHARS} chars`)
  }
  return llmCreateSpeech({ userId: input.userId, voice: ttsVoice(), text, task: input.task })
}
