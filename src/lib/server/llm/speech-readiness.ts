import { onCompanyProvider } from './company-provider'
import { isLlmNotConfiguredError } from './errors'
import { loadOpenRouterSttConfig, sttCredentialSource } from './llm-client'
import type { SpeechReadiness } from '$lib/voice/dictation-readiness'

export type { SpeechMissing, SpeechReadiness } from '$lib/voice/dictation-readiness'

export type SpeechReadinessDeps = {
  onCompanyProvider: <T>(fn: () => Promise<T>) => Promise<T>
  sttCredentialSource: (userId: string) => Promise<'byok' | 'platform'>
  loadOpenRouterSttConfig: (userId: string) => Promise<unknown>
}

const liveDeps: SpeechReadinessDeps = {
  onCompanyProvider: (fn) => onCompanyProvider(fn),
  sttCredentialSource,
  loadOpenRouterSttConfig,
}

/**
 * Whether dictation can run for this person, asked the way `/api/voice/transcribe` runs it:
 * on the company's provider (the owner's account), through the same credential lookup.
 * Only "not configured" counts as not ready; any other failure surfaces.
 */
export async function speechToTextReadiness(
  userId: string,
  deps: SpeechReadinessDeps = liveDeps,
): Promise<SpeechReadiness> {
  try {
    return await deps.onCompanyProvider(async (): Promise<SpeechReadiness> => {
      const source = await deps.sttCredentialSource(userId)
      try {
        await deps.loadOpenRouterSttConfig(userId)
        return { ready: true }
      } catch (err) {
        if (!isLlmNotConfiguredError(err)) throw err
        return { ready: false, missing: source === 'byok' ? 'openrouter_key' : 'platform_key' }
      }
    })
  } catch (err) {
    // no owner yet: there is no account whose key dictation could use
    if (isLlmNotConfiguredError(err)) return { ready: false, missing: 'openrouter_key' }
    throw err
  }
}
