import { describe, expect, it } from 'vitest'
import {
  approvalRequiredTurn,
  assistantTurnFromResponse,
  failedTurn,
  nucleusTurnForProgressEvent,
  nucleusTurnsFromPersisted,
  statusLabelForProgressEvent,
  toolPreviewTurn,
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

  it('stays quiet for harness-path events that render inline or as cards', () => {
    expect(
      statusLabelForProgressEvent({
        type: 'tool.preview',
        tool: 'email.send_mail',
        inputSummary: '{"to":"a@b.c"}',
      }),
    ).toBeNull()
    expect(statusLabelForProgressEvent({ type: 'approval.required', tool: 'email.send_mail' })).toBeNull()
    expect(statusLabelForProgressEvent({ type: 'message_delta', content: 'Hel' })).toBeNull()
  })
})

describe('nucleus-chat harness turns', () => {
  it('builds a tool preview turn with the bounded input summary', () => {
    expect(toolPreviewTurn('email.send_mail', '{"to":"a@b.c"}')).toEqual({
      role: 'tool_preview',
      tool: 'email.send_mail',
      inputSummary: '{"to":"a@b.c"}',
    })
    expect(toolPreviewTurn('memory.echo', null)).toEqual({
      role: 'tool_preview',
      tool: 'memory.echo',
      inputSummary: null,
    })
  })

  it('builds an approval turn', () => {
    expect(approvalRequiredTurn('email.send_mail')).toEqual({
      role: 'approval',
      tool: 'email.send_mail',
    })
  })

  it('folds tool.preview and approval.required progress events into transcript turns', () => {
    expect(
      nucleusTurnForProgressEvent({
        type: 'tool.preview',
        tool: 'email.send_mail',
        inputSummary: '{"to":"a@b.c"}',
      }),
    ).toEqual({ role: 'tool_preview', tool: 'email.send_mail', inputSummary: '{"to":"a@b.c"}' })
    expect(nucleusTurnForProgressEvent({ type: 'approval.required', tool: 'brand.set_activate' }))
      .toEqual({ role: 'approval', tool: 'brand.set_activate' })
  })

  it('leaves every other progress event to the status line / final response', () => {
    expect(nucleusTurnForProgressEvent({ type: 'thinking', content: 'internal' })).toBeNull()
    expect(nucleusTurnForProgressEvent({ type: 'message_delta', content: 'Hel' })).toBeNull()
    expect(
      nucleusTurnForProgressEvent({ type: 'agent_progress', label: 'Working…' }),
    ).toBeNull()
    expect(
      nucleusTurnForProgressEvent({ type: 'tool_result', tool: 'x', preview: 'y' }),
    ).toBeNull()
  })
})

describe('nucleusTurnsFromPersisted', () => {
  it('restores the saved conversation: user + assistant turns, tool previews, approvals', () => {
    expect(
      nucleusTurnsFromPersisted([
        { role: 'assistant', content: 'Welcome back.', metadata: null },
        { role: 'user', content: 'build my site', metadata: null },
        {
          role: 'assistant',
          content: 'pages',
          metadata: { variant: 'tool_preview', tool: 'site.create' },
        },
        {
          role: 'assistant',
          content: '{"x":1}',
          metadata: { variant: 'tool_call', tool: 'site.create' },
        },
        { role: 'assistant', content: 'internal', metadata: { variant: 'thinking' } },
        {
          role: 'assistant',
          content: '',
          metadata: { variant: 'approval_required', tool: 'site.publish' },
        },
        { role: 'system', content: 'sys', metadata: null },
        { role: 'assistant', content: 'Queued for your approval.', metadata: null },
      ]),
    ).toEqual([
      { role: 'assistant', content: 'Welcome back.' },
      { role: 'user', content: 'build my site' },
      { role: 'tool_preview', tool: 'site.create', inputSummary: 'pages' },
      { role: 'approval', tool: 'site.publish' },
      { role: 'assistant', content: 'Queued for your approval.' },
    ])
  })
})
