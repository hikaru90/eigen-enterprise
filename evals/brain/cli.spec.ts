import { describe, expect, it } from 'vitest'
import { orderForChat, parseBrainEvalArgs, providerEnvFor } from './cli'
import { ALL_ITEMS } from './suites'

describe('npm run eval:brain arguments', () => {
  it('defaults to the deterministic static mode', () => {
    expect(parseBrainEvalArgs([])).toEqual({ mode: 'static', provider: null, only: null })
  })

  it('chat mode needs a provider: platform (real model) or mock (the e2e mock gateway)', () => {
    expect(parseBrainEvalArgs(['--mode', 'chat', '--provider', 'platform'])).toEqual({ mode: 'chat', provider: 'platform', only: null })
    expect(() => parseBrainEvalArgs(['--mode', 'chat'])).toThrow(/--provider platform\|mock/)
    expect(() => parseBrainEvalArgs(['--provider', 'mock'])).toThrow(/only with --mode chat/)
    expect(() => parseBrainEvalArgs(['--mode', 'fast'])).toThrow(/--mode static\|chat/)
  })

  it('--only narrows to named items and refuses unknown ones', () => {
    expect(parseBrainEvalArgs(['--mode', 'chat', '--provider', 'mock', '--only', 'K01,L03']).only).toEqual(['K01', 'L03'])
    expect(() => parseBrainEvalArgs(['--only', 'K99'])).toThrow(/unknown item K99/)
  })
})

describe('chat order', () => {
  it('asks Knows and Keeps before Does, so a task’s changes never answer a question', () => {
    const order = orderForChat(ALL_ITEMS).map((i) => i.suite)
    expect(order.indexOf('does')).toBeGreaterThan(order.lastIndexOf('knows'))
    expect(order.indexOf('does')).toBeGreaterThan(order.lastIndexOf('keeps'))
    expect(order).toHaveLength(ALL_ITEMS.length)
  })
})

describe('the provider', () => {
  it('platform: the four PLATFORM_LLM_* of the hosted-box contract, all or nothing', () => {
    const env = { PLATFORM_LLM_BASE_URL: 'https://x/v1', PLATFORM_LLM_API_KEY: 'k', PLATFORM_LLM_MODEL_CHAT: 'c', PLATFORM_LLM_MODEL_EMBEDDING: 'e' }
    expect(providerEnvFor('platform', env, null)).toEqual(env)
    expect(() => providerEnvFor('platform', {}, null)).toThrow(/PLATFORM_LLM_BASE_URL, PLATFORM_LLM_API_KEY, PLATFORM_LLM_MODEL_CHAT, PLATFORM_LLM_MODEL_EMBEDDING/)
  })

  it('mock: the mock gateway’s address and models', () => {
    expect(providerEnvFor('mock', {}, 'http://127.0.0.1:5299')).toEqual({
      PLATFORM_LLM_BASE_URL: 'http://127.0.0.1:5299/v1',
      PLATFORM_LLM_API_KEY: 'mock',
      PLATFORM_LLM_MODEL_CHAT: 'mock-chat-model',
      PLATFORM_LLM_MODEL_EMBEDDING: 'mock-embed-model',
    })
  })
})
