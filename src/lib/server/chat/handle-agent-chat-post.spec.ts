import { describe, expect, it } from 'vitest'
import { LlmDailyCapError, LlmNotConfiguredError } from '$lib/server/llm/errors'
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

  it('a member over the daily AI cap reads the plain allowance message (tagged llm_daily_cap), through wrapped causes', () => {
    const wrapped = new Error('agent loop failed', { cause: new LlmDailyCapError({ capUsd: 1, spentUsd: 1.2 }) })
    expect(chatErrorTerminalPayload(wrapped)).toEqual({
      type: 'error',
      error: "You've used today's AI allowance for this company. It resets at midnight UTC.",
      code: 'llm_daily_cap',
    })
  })

  it('preserves a custom LlmDailyCapError message (e.g. demo visitor per-IP limit)', () => {
    const wrapped = new Error('agent loop failed', {
      cause: new LlmDailyCapError({
        capUsd: 0,
        spentUsd: 0,
        message: "You've used your 2 demo AI calls for today. Sign up or self-host eigenEnterprise to keep going.",
      }),
    })
    expect(chatErrorTerminalPayload(wrapped)).toEqual({
      type: 'error',
      error: "You've used your 2 demo AI calls for today. Sign up or self-host eigenEnterprise to keep going.",
      code: 'llm_daily_cap',
    })
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
