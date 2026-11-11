import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { DICTATION_MISSING_MESSAGE } from '$lib/voice/dictation-readiness'
import SpeechStatus from './speech-status.svelte'

const liveModels = [
  { feature: 'dictation' as const, model: 'qwen/qwen3-asr-0.6b', endpoints: 2, providers: ['PrimeIntellect', 'DeepInfra'] },
  { feature: 'voice' as const, model: 'qwen/qwen3-tts-x', endpoints: 1, providers: ['DeepInfra'] },
]

describe('speech-status.svelte', () => {
  it('says plainly that speech runs on OpenRouter, whatever the chat provider', async () => {
    render(SpeechStatus, { dictation: { ready: true }, models: liveModels })
    await expect.element(page.getByTestId('speech-status')).toHaveTextContent('always run on OpenRouter')
    await expect.element(page.getByTestId('speech-dictation')).toHaveTextContent('Ready')
  })

  it('names what dictation is missing', async () => {
    render(SpeechStatus, { dictation: { ready: false, missing: 'openrouter_key' }, models: liveModels })
    await expect
      .element(page.getByTestId('speech-dictation'))
      .toHaveTextContent(DICTATION_MISSING_MESSAGE.openrouter_key)
  })

  it('shows each model’s live endpoints, and loudly when a model has none', async () => {
    render(SpeechStatus, {
      dictation: { ready: true },
      models: [liveModels[0]!, { feature: 'voice' as const, model: 'qwen/qwen3-tts-flash-2026-02-10', endpoints: 0, providers: [] }],
    })
    await expect.element(page.getByTestId('speech-model-dictation')).toHaveTextContent('2 providers (PrimeIntellect, DeepInfra)')
    const voice = page.getByTestId('speech-model-voice')
    await expect.element(voice).toHaveTextContent('No providers on OpenRouter')
    await expect.element(voice).toHaveAttribute('role', 'alert')
  })

  it('a failed check says it could not check, never "fine"', async () => {
    render(SpeechStatus, {
      dictation: { ready: true },
      models: [{ feature: 'dictation' as const, model: 'qwen/qwen3-asr-0.6b', error: 'OpenRouter answered 503' }],
    })
    await expect
      .element(page.getByTestId('speech-model-dictation'))
      .toHaveTextContent('Couldn’t check: OpenRouter answered 503')
  })
})
