/**
 * What dictation is missing before it can work (shared by the server check and every mic).
 * Speech-to-text always runs on OpenRouter, whatever chat provider the company picked:
 * - `openrouter_key`: the company brings its own keys, and the owner has no OpenRouter key.
 * - `platform_key`: the company runs on platform credits, and this server has no
 *   `SERVICE_API_KEY_OPENROUTER` / `OPENROUTER_BASE_URL`.
 */
export type SpeechMissing = 'openrouter_key' | 'platform_key'
export type SpeechReadiness = { ready: true } | { ready: false; missing: SpeechMissing }

/** The sentence a disabled mic and the settings page show. */
export const DICTATION_MISSING_MESSAGE: Record<SpeechMissing, string> = {
  openrouter_key:
    'Dictation needs an OpenRouter key. The company owner adds one in Settings → AI provider.',
  platform_key: 'Dictation isn’t set up on this server yet (no platform OpenRouter key).',
}

/** dictation = speech to text; voice = the assistant speaking. */
export type SpeechFeature = 'dictation' | 'voice'
/** One speech model's live endpoints on OpenRouter, or why that could not be checked. */
export type SpeechModelStatus =
  | { feature: SpeechFeature; model: string; endpoints: number; providers: string[] }
  | { feature: SpeechFeature; model: string; error: string }
