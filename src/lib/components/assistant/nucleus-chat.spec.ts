import { describe, expect, it } from 'vitest'
import {
  approvalRequiredTurn,
  assistantTurnFromResponse,
  failedTurn,
  nucleusTurnForProgressEvent,
  nucleusTurnsFromPersisted,
  approvalActionLabel,
  persistedApprovalIds,
  withApprovalStatus,
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
    expect(
      statusLabelForProgressEvent({
        type: 'approval.required',
        tool: 'email.send_mail',
        approvalId: 'a',
      }),
    ).toBeNull()
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

  it('builds an approval card turn: the action in plain words, the request id, its status', () => {
    expect(
      approvalRequiredTurn({
        tool: 'website.publish_page',
        approvalId: 'apr-1',
        status: 'pending',
      }),
    ).toEqual({
      role: 'approval',
      tool: 'website.publish_page',
      approvalId: 'apr-1',
      status: 'pending',
      action: 'Publish a page of your website',
    })
  })

  it('words every gated tool in plain language; an unknown tool still names itself', () => {
    expect(approvalActionLabel('email.send_mail')).toBe('Send an email')
    expect(approvalActionLabel('repo.merge')).toBe('Merge agent work into the company repository')
    expect(approvalActionLabel('kernel.module_deactivate')).toBe('Switch off a module')
    expect(approvalActionLabel('custom.thing')).toBe('Run custom.thing')
  })

  it('marks one approval card decided, leaving every other entry untouched', () => {
    const entries = [
      {
        key: 'a',
        ...approvalRequiredTurn({ tool: 'repo.merge', approvalId: 'apr-1', status: 'pending' }),
      },
      {
        key: 'b',
        ...approvalRequiredTurn({ tool: 'repo.merge', approvalId: 'apr-2', status: 'pending' }),
      },
      { key: 'c', role: 'user' as const, content: 'hi' },
    ]
    const next = withApprovalStatus(entries, 'apr-2', 'approved')
    expect(next[0]).toEqual(entries[0])
    expect(next[1]).toMatchObject({ approvalId: 'apr-2', status: 'approved' })
    expect(next[2]).toEqual(entries[2])
  })

  it('folds tool.preview and approval.required progress events into transcript turns', () => {
    expect(
      nucleusTurnForProgressEvent({
        type: 'tool.preview',
        tool: 'email.send_mail',
        inputSummary: '{"to":"a@b.c"}',
      }),
    ).toEqual({ role: 'tool_preview', tool: 'email.send_mail', inputSummary: '{"to":"a@b.c"}' })
    expect(
      nucleusTurnForProgressEvent({
        type: 'approval.required',
        tool: 'brand.set_activate',
        approvalId: 'apr-7',
      }),
    ).toEqual({
      role: 'approval',
      tool: 'brand.set_activate',
      approvalId: 'apr-7',
      status: 'pending',
      action: 'Make a brand guideline set the active one',
    })
  })

  it('leaves every other progress event to the status line / final response', () => {
    expect(nucleusTurnForProgressEvent({ type: 'thinking', content: 'internal' })).toBeNull()
    expect(nucleusTurnForProgressEvent({ type: 'message_delta', content: 'Hel' })).toBeNull()
    expect(nucleusTurnForProgressEvent({ type: 'agent_progress', label: 'Working…' })).toBeNull()
    expect(nucleusTurnForProgressEvent({ type: 'tool_result', tool: 'x', preview: 'y' })).toBeNull()
  })
})

describe('nucleusTurnsFromPersisted', () => {
  it('a card saved without an id is linked to the pending request for its tool', () => {
    const turns = nucleusTurnsFromPersisted(
      [
        {
          role: 'assistant',
          content: '',
          metadata: { variant: 'approval_required', tool: 'website.publish_page' },
        },
      ],
      {},
      { 'website.publish_page': 'appr-1' },
    )
    expect(turns).toEqual([
      approvalRequiredTurn({
        tool: 'website.publish_page',
        approvalId: 'appr-1',
        status: 'pending',
      }),
    ])
  })

  it('restores the saved conversation: user + assistant turns, tool previews, approvals', () => {
    expect(
      nucleusTurnsFromPersisted(
        [
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
            metadata: { variant: 'approval_required', tool: 'site.publish', approvalId: 'apr-1' },
          },
          { role: 'system', content: 'sys', metadata: null },
          { role: 'assistant', content: 'Queued for your approval.', metadata: null },
        ],
        { 'apr-1': 'pending' },
      ),
    ).toEqual([
      { role: 'assistant', content: 'Welcome back.' },
      { role: 'user', content: 'build my site' },
      { role: 'tool_preview', tool: 'site.create', inputSummary: 'pages' },
      {
        role: 'approval',
        tool: 'site.publish',
        approvalId: 'apr-1',
        status: 'pending',
        action: 'Run site.publish',
      },
      { role: 'assistant', content: 'Queued for your approval.' },
    ])
  })

  it('restores each approval card with its current kernel status (decided cards lose their buttons)', () => {
    const rows = [
      {
        role: 'assistant',
        content: '',
        metadata: { variant: 'approval_required', tool: 'repo.merge', approvalId: 'apr-1' },
      },
      {
        role: 'assistant',
        content: '',
        metadata: { variant: 'approval_required', tool: 'repo.merge', approvalId: 'apr-2' },
      },
      {
        role: 'assistant',
        content: '',
        metadata: { variant: 'approval_required', tool: 'repo.merge', approvalId: 'apr-3' },
      },
    ]
    expect(persistedApprovalIds(rows)).toEqual(['apr-1', 'apr-2', 'apr-3'])
    expect(
      nucleusTurnsFromPersisted(rows, { 'apr-1': 'pending', 'apr-2': 'approved' }).map((t) =>
        t.role === 'approval' ? t.status : null,
      ),
    ).toEqual(['pending', 'approved', 'unavailable'])
  })

  it('a card saved before approvals carried an id cannot be decided from the page', () => {
    const rows = [
      {
        role: 'assistant',
        content: '',
        metadata: { variant: 'approval_required', tool: 'repo.merge' },
      },
    ]
    expect(persistedApprovalIds(rows)).toEqual([])
    expect(nucleusTurnsFromPersisted(rows, {})).toEqual([
      {
        role: 'approval',
        tool: 'repo.merge',
        approvalId: null,
        status: 'unavailable',
        action: 'Merge agent work into the company repository',
      },
    ])
  })
})
