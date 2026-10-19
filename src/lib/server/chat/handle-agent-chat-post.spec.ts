import { describe, expect, it } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import {
  BRIEFING_BOOTSTRAP_MESSAGES,
  CHAT_LLM_NOT_CONFIGURED_MESSAGE,
  CHAT_TURN_FAILED_MESSAGE,
  chatErrorTerminalPayload,
} from './handle-agent-chat-post'

describe('chatErrorTerminalPayload', () => {
  it('returns the one fixed human message — never the raw error text', () => {
    const payload = chatErrorTerminalPayload(new Error('boom: ECONNREFUSED 10.0.0.1'))
    expect(payload).toEqual({ type: 'error', error: CHAT_TURN_FAILED_MESSAGE })
    expect(JSON.stringify(payload)).not.toContain('boom')
  })

  it('tags llm_not_configured so the surface can offer provider setup (fixed message)', () => {
    const err = new LlmNotConfiguredError('Platform EUrouter not configured: set LLM_BASE_URL')
    const payload = chatErrorTerminalPayload(err)
    expect(payload.code).toBe('llm_not_configured')
    expect(payload.error).toBe(CHAT_LLM_NOT_CONFIGURED_MESSAGE)
    expect(JSON.stringify(payload)).not.toContain('LLM_BASE_URL')
  })

  it('tags llm_not_configured through wrapped causes', () => {
    const wrapped = new Error('agent loop failed', {
      cause: new LlmNotConfiguredError('LLM not configured: set LLM_BASE_URL'),
    })
    const payload = chatErrorTerminalPayload(wrapped)
    expect(payload.code).toBe('llm_not_configured')
  })
})

describe('BRIEFING_BOOTSTRAP_MESSAGES', () => {
  it('covers morning, evening, and weekly periods', () => {
    expect(Object.keys(BRIEFING_BOOTSTRAP_MESSAGES).sort()).toEqual([
      'evening',
      'morning',
      'weekly',
    ])
  })

  it('never references removed list_temporal_events', () => {
    for (const [period, message] of Object.entries(BRIEFING_BOOTSTRAP_MESSAGES)) {
      expect(message, period).not.toMatch(/list_temporal_events/)
      expect(message, period).not.toMatch(/manage_temporal_event/)
    }
  })

  it('points the agent at available project and Q&A tools', () => {
    for (const [period, message] of Object.entries(BRIEFING_BOOTSTRAP_MESSAGES)) {
      expect(message, period).toMatch(/list_projects/)
      expect(message, period).toMatch(/get_project_timeline|answer_question|retrieve_thoughts/)
    }
  })
})
