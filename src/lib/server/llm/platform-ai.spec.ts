import { describe, expect, it } from 'vitest'
import { PLATFORM_AI_PROVIDERS as FLEET_PLATFORM_AI_PROVIDERS } from '../../../../ee/src/fleet/protocol'
import { PLATFORM_AI_ENV, PLATFORM_AI_PROVIDER, PLATFORM_AI_PROVIDERS, PLATFORM_AI_PROVIDER_ENV, readPlatformAiConfig } from './platform-ai'

const full = {
  PLATFORM_LLM_BASE_URL: 'https://llm.example.test/api/v1/',
  PLATFORM_LLM_API_KEY: 'sk-platform',
  PLATFORM_LLM_MODEL_CHAT: 'vendor/chat-1',
  PLATFORM_LLM_MODEL_EMBEDDING: 'vendor/embed-1',
}

describe('readPlatformAiConfig', () => {
  it('names the four os secrets ee writes from the fleet platformAi', () => {
    expect(Object.values(PLATFORM_AI_ENV)).toEqual([
      'PLATFORM_LLM_BASE_URL',
      'PLATFORM_LLM_API_KEY',
      'PLATFORM_LLM_MODEL_CHAT',
      'PLATFORM_LLM_MODEL_EMBEDDING',
    ])
  })

  it('none set → null (a self-hosted box: no platform AI)', () => {
    expect(readPlatformAiConfig({})).toBeNull()
    expect(readPlatformAiConfig({ PLATFORM_LLM_API_KEY: '  ' })).toBeNull()
  })

  it('the self-hosted BYOK env (LLM_BASE_URL + LLM_API_KEY) is not the platform AI', () => {
    expect(
      readPlatformAiConfig({ LLM_BASE_URL: 'https://gw.example.test/v1', LLM_API_KEY: 'byok' }),
    ).toBeNull()
  })

  it('all four set → the config, base URL without a trailing slash', () => {
    expect(readPlatformAiConfig(full)).toEqual({
      baseUrl: 'https://llm.example.test/api/v1',
      apiKey: 'sk-platform',
      modelChat: 'vendor/chat-1',
      modelEmbedding: 'vendor/embed-1',
      provider: 'openrouter',
    })
  })

  it('who serves it: PLATFORM_LLM_PROVIDER, the providers the fleet protocol names', () => {
    expect(PLATFORM_AI_PROVIDER_ENV).toBe('PLATFORM_LLM_PROVIDER')
    expect(PLATFORM_AI_PROVIDERS).toEqual([...FLEET_PLATFORM_AI_PROVIDERS])
    expect(readPlatformAiConfig({ ...full, PLATFORM_LLM_PROVIDER: 'opper' })?.provider).toBe('opper')
    expect(readPlatformAiConfig({ ...full, PLATFORM_LLM_PROVIDER: ' openrouter ' })?.provider).toBe('openrouter')
  })

  it('no PLATFORM_LLM_PROVIDER = OpenRouter (protocol v1: a box upgrades before its agent writes the provider)', () => {
    expect(readPlatformAiConfig(full)?.provider).toBe('openrouter')
    expect(readPlatformAiConfig({ ...full, PLATFORM_LLM_PROVIDER: '' })?.provider).toBe('openrouter')
  })

  it('an unknown provider fails loud at read, naming it', () => {
    expect(() => readPlatformAiConfig({ ...full, PLATFORM_LLM_PROVIDER: 'eurouter' })).toThrow(
      /PLATFORM_LLM_PROVIDER "eurouter" is not a provider eigenInference knows \(openrouter, opper\)/,
    )
  })

  it('a provider alone is not a platform AI: it is ignored when none of the four are set', () => {
    expect(readPlatformAiConfig({ PLATFORM_LLM_PROVIDER: 'opper' })).toBeNull()
  })

  it('partial → throws naming the missing ones', () => {
    expect(() =>
      readPlatformAiConfig({ ...full, PLATFORM_LLM_API_KEY: undefined, PLATFORM_LLM_MODEL_EMBEDDING: '' }),
    ).toThrow(/PLATFORM_LLM_API_KEY, PLATFORM_LLM_MODEL_EMBEDDING are not set/)
    expect(() => readPlatformAiConfig({ ...full, PLATFORM_LLM_MODEL_CHAT: '' })).toThrow(
      /PLATFORM_LLM_MODEL_CHAT is not set/,
    )
  })

  it('is a declared provider kind of its own, not one of the BYOK provider ids', () => {
    expect(PLATFORM_AI_PROVIDER).toBe('platform')
  })
})
