import { describe, expect, it } from 'vitest'
import {
  assistantTurnFromResponse,
  failedTurn,
  statusLabelForProgressEvent,
  userTurn,
} from './nucleus-chat'

describe('nucleus-chat entries', () => {
  it('builds user turns', () => {
    expect(userTurn('i need a website')).toEqual({
      role: 'user',
      content: 'i need a website',
    })
  })

  it('builds assistant turns from the sanitized stream response', () => {
    expect(assistantTurnFromResponse('Okay — what does your brand sound like?')).toEqual({
      role: 'assistant',
      content: 'Okay — what does your brand sound like?',
    })
  })

  it('returns null for an empty assistant response instead of a blank bubble', () => {
    expect(assistantTurnFromResponse('   ')).toBeNull()
  })

  it('marks failed turns so the surface can render them loud', () => {
    expect(failedTurn('Request cancelled.')).toEqual({
      role: 'assistant',
      content: 'Request cancelled.',
      failed: true,
    })
  })

  it('attaches a provider-setup action when the failure is missing configuration', () => {
    expect(
      failedTurn('Error: Platform EUrouter not configured: set LLM_BASE_URL', {
        providerSetup: true,
      }),
    ).toEqual({
      role: 'assistant',
      content: 'Error: Platform EUrouter not configured: set LLM_BASE_URL',
      failed: true,
      providerSetup: true,
    })
  })
})

describe('nucleus-chat status line', () => {
  it('hides thinking from the surface', () => {
    expect(statusLabelForProgressEvent({ type: 'thinking', content: 'internal' })).toBeNull()
  })

  it('maps progress labels and tool activity to one quiet status', () => {
    expect(
      statusLabelForProgressEvent({ type: 'agent_progress', label: 'Planning next step' }),
    ).toBe('Planning next step')
    expect(
      statusLabelForProgressEvent({
        type: 'tool_call',
        tool: 'create_text_file',
        arguments: {},
      }),
    ).toBe('Creating text note')
    expect(statusLabelForProgressEvent({ type: 'tool_executing', tool: 'answer_question' })).toBe(
      'Answering your question',
    )
    expect(
      statusLabelForProgressEvent({
        type: 'tool_progress',
        tool: 'answer_question',
        phase: 'run',
        label: 'Answering your question',
      }),
    ).toBe('Answering your question')
    expect(
      statusLabelForProgressEvent({
        type: 'tool_result',
        tool: 'answer_question',
        preview: 'x',
      }),
    ).toBe('Preparing your reply…')
  })
})
