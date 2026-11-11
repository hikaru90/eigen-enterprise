import { env } from '$lib/server/env/private-env'
import { llmCreateSpeech } from './llm-client'

/** OpenRouter model id for speech synthesis (`/audio/speech`). */
export const TTS_MODEL_OPENROUTER_DEFAULT = 'qwen/qwen3-tts-flash-2026-02-10'

/** OpenAI-compatible voice id passed through to the gateway model. */
export const TTS_VOICE_DEFAULT = 'alloy'

const TTS_MAX_TEXT_CHARS = 4000

/** The model speech synthesis calls (the env override, else the default). */
export function ttsModelId(): string {
  const override = env.LLM_MODEL_TTS?.trim()
  if (!override) return TTS_MODEL_OPENROUTER_DEFAULT
  return override
}

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
}): Promise<Uint8Array> {
  const text = input.text.trim()
  if (!text) throw new Error('TTS refused: empty text')
  if (text.length > TTS_MAX_TEXT_CHARS) {
    throw new Error(`TTS refused: text exceeds ${TTS_MAX_TEXT_CHARS} chars`)
  }
  return llmCreateSpeech({ userId: input.userId, model: ttsModelId(), voice: ttsVoice(), text })
}
