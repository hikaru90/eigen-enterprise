import { describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from './errors'
import { speechToTextReadiness, type SpeechReadinessDeps } from './speech-readiness'

function deps(over: Partial<SpeechReadinessDeps> = {}): SpeechReadinessDeps {
  return {
    onCompanyProvider: async (fn) => fn(),
    sttCredentialSource: async () => 'byok',
    loadOpenRouterSttConfig: async () => ({}) as never,
    ...over,
  }
}

describe('speechToTextReadiness', () => {
  it('is ready when the OpenRouter credentials dictation uses resolve', async () => {
    await expect(speechToTextReadiness('u1', deps())).resolves.toEqual({ ready: true })
  })

  it('runs on the company provider, like dictation itself', async () => {
    const onCompanyProvider = vi.fn(async <T>(fn: () => Promise<T>) => fn())
    await speechToTextReadiness('u1', deps({ onCompanyProvider }))
    expect(onCompanyProvider).toHaveBeenCalledTimes(1)
  })

  it('names the owner’s missing OpenRouter key when the company brings its own keys', async () => {
    const r = await speechToTextReadiness(
      'u1',
      deps({
        sttCredentialSource: async () => 'byok',
        loadOpenRouterSttConfig: async () => {
          throw new LlmNotConfiguredError('no openrouter row')
        },
      }),
    )
    expect(r).toEqual({ ready: false, missing: 'openrouter_key' })
  })

  it('names the server’s missing platform key when the company runs on platform credits', async () => {
    const r = await speechToTextReadiness(
      'u1',
      deps({
        sttCredentialSource: async () => 'platform',
        loadOpenRouterSttConfig: async () => {
          throw new LlmNotConfiguredError('SERVICE_API_KEY_OPENROUTER')
        },
      }),
    )
    expect(r).toEqual({ ready: false, missing: 'platform_key' })
  })

  it('a company without an owner has no key to use: not ready', async () => {
    const r = await speechToTextReadiness(
      'u1',
      deps({
        onCompanyProvider: async () => {
          throw new LlmNotConfiguredError('no owner')
        },
      }),
    )
    expect(r).toEqual({ ready: false, missing: 'openrouter_key' })
  })

  it('any other failure is not "not configured": it surfaces', async () => {
    await expect(
      speechToTextReadiness(
        'u1',
        deps({
          loadOpenRouterSttConfig: async () => {
            throw new Error('database down')
          },
        }),
      ),
    ).rejects.toThrow('database down')
  })
})
