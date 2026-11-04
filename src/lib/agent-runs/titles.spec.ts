import { describe, expect, it } from 'vitest'
import { failureExplanation, runTitle } from './titles'

describe('runTitle: a readable name for a run', () => {
  it('names a chat after the member who chatted', () => {
    expect(
      runTitle({ conversationKey: 'orchestrator:9b1c', background: false, memberName: 'Ada Park' }),
    ).toBe('Chat with Ada Park')
  })
  it('names a chat after what it is about: its first message, shortened', () => {
    expect(
      runTitle({
        conversationKey: 'orchestrator:9b1c',
        background: false,
        memberName: 'Ada Park',
        topic: '  Build me a landing page\nfor the bakery  ',
      }),
    ).toBe('Build me a landing page for the bakery')
    const long = 'word '.repeat(40)
    const title = runTitle({ conversationKey: 'o:1', background: false, memberName: null, topic: long })
    expect(title.length).toBeLessThanOrEqual(72)
    expect(title.endsWith('…')).toBe(true)
    // A blank first message is no topic.
    expect(
      runTitle({ conversationKey: 'o:1', background: false, memberName: 'Ada', topic: '   ' }),
    ).toBe('Chat with Ada')
  })
  it('falls back to "a team member" when the name is unknown', () => {
    expect(
      runTitle({ conversationKey: 'orchestrator:9b1c', background: false, memberName: null }),
    ).toBe('Chat with a team member')
  })
  it('names a background run after its task key', () => {
    expect(
      runTitle({ conversationKey: 'factory:ticket-7', background: true, memberName: null }),
    ).toBe('Background task: ticket 7')
    expect(runTitle({ conversationKey: 'recap', background: true, memberName: null })).toBe(
      'Background task',
    )
  })
})

describe('failureExplanation: a failed turn in plain words', () => {
  it('explains a missing provider', () => {
    expect(
      failureExplanation('model_error', 'Platform EUrouter not configured: set LLM_BASE_URL'),
    ).toBe("The AI provider isn't set up. Connect one in Settings › AI provider.")
  })
  it('explains a spending limit', () => {
    expect(failureExplanation('budget_exceeded', undefined)).toBe(
      'The agent reached its spending limit.',
    )
  })
  it('explains anything else generically (the detail stays behind the toggle)', () => {
    expect(failureExplanation('model_error', 'HTTP 502 from upstream')).toBe(
      "The AI provider didn't answer. Try again in a moment.",
    )
    expect(failureExplanation('aborted', undefined)).toBe('The turn stopped before it finished.')
  })
})
