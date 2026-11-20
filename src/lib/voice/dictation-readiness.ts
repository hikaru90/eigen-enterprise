/**
 * What dictation is missing before it can work (shared by the server check and every mic).
 * Speech-to-text runs on the company's speech-to-text slot (an OpenRouter-namespace endpoint),
 * whatever chat provider the company picked:
 * - `openrouter_key`: the company uses its own keys, and the owner has no OpenRouter key.
 * - `platform_key`: "Use eigenInference" is on, and this server has no eigenInference
 *   (`PLATFORM_LLM_*`).
 */
export type SpeechMissing = 'openrouter_key' | 'platform_key'
export type SpeechReadiness = { ready: true } | { ready: false; missing: SpeechMissing }

/** The sentence a disabled mic and the settings page show. */
export const DICTATION_MISSING_MESSAGE: Record<SpeechMissing, string> = {
  openrouter_key:
    'Dictation needs an OpenRouter key. The company owner adds one in Settings → AI provider.',
  platform_key:
    'Dictation isn’t set up on this server yet: eigenInference is not connected. An owner or admin can use the company’s own key under Settings → AI provider → Advanced.',
}

/**
 * dictation = speech to text (one model, live previews included); voice = the assistant speaking.
 */
export type SpeechFeature = 'dictation' | 'voice'
/** One speech model's live endpoints on OpenRouter, or why that could not be checked. */
export type SpeechModelStatus =
  | { feature: SpeechFeature; model: string; endpoints: number; providers: string[] }
  | { feature: SpeechFeature; model: string; error: string }
