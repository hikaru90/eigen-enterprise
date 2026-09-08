import { describe, expect, it } from 'vitest'
import {
  isLlmHttpError,
  isLlmNotConfiguredError,
  LlmHttpError,
  LlmNotConfiguredError,
} from './errors'

describe('LlmHttpError', () => {
  it('carries the status and keeps the legacy message format', () => {
    const err = new LlmHttpError(402, 'insufficient balance')
    expect(err.status).toBe(402)
    expect(err.name).toBe('LlmHttpError')
    expect(err.message).toBe('LLM HTTP 402: insufficient balance')
    expect(isLlmHttpError(err)).toBe(true)
    expect(isLlmHttpError(new Error('LLM HTTP 402: insufficient balance'))).toBe(false)
  })
})

describe('LlmNotConfiguredError', () => {
  it('is typed and detected without message string matching', () => {
    const err = new LlmNotConfiguredError('Platform EUrouter not configured: set LLM_BASE_URL')
    expect(err.name).toBe('LlmNotConfiguredError')
    expect(isLlmNotConfiguredError(err)).toBe(true)
    expect(isLlmNotConfiguredError(new Error('Platform EUrouter not configured: set LLM_BASE_URL'))).toBe(
      false,
    )
  })

  it('is detected through wrapped cause chains', () => {
    const root = new LlmNotConfiguredError('LLM not configured: set LLM_BASE_URL')
    const wrapped = new Error('agent loop failed', { cause: root })
    const wrappedTwice = new Error('chat turn failed', { cause: wrapped })
    expect(isLlmNotConfiguredError(wrapped)).toBe(true)
    expect(isLlmNotConfiguredError(wrappedTwice)).toBe(true)
  })

  it('is not detected for unrelated errors or causes', () => {
    expect(isLlmNotConfiguredError(null)).toBe(false)
    expect(isLlmNotConfiguredError('LLM not configured')).toBe(false)
    expect(isLlmNotConfiguredError(new Error('nope', { cause: new Error('also nope') }))).toBe(false)
  })
})
