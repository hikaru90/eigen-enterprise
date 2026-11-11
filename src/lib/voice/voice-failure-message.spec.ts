import { describe, expect, it } from 'vitest'
import { VOICE_FAILURE_TEXT, voiceFailureMessage } from './voice-failure-message'

describe('voiceFailureMessage', () => {
  it('maps each local failure to its plain sentence', () => {
    expect(voiceFailureMessage({ reason: 'permission', retryable: false })).toBe(VOICE_FAILURE_TEXT.permission)
    expect(voiceFailureMessage({ reason: 'empty', retryable: true })).toBe(VOICE_FAILURE_TEXT.empty)
  })

  it("shows the server's words only for an actionable 400 or 503", () => {
    expect(voiceFailureMessage({ reason: 'request', status: 400, detail: 'clip too large', retryable: true })).toBe('clip too large')
    expect(voiceFailureMessage({ reason: 'request', status: 503, detail: 'Set up the AI provider', retryable: true })).toBe(
      'Set up the AI provider',
    )
    expect(voiceFailureMessage({ reason: 'request', status: 502, detail: 'LLM STT HTTP 500: …', retryable: true })).toBe(
      VOICE_FAILURE_TEXT.transcribe,
    )
    expect(voiceFailureMessage({ reason: 'request', detail: 'Failed to fetch', retryable: true })).toBe(VOICE_FAILURE_TEXT.transcribe)
  })
})
