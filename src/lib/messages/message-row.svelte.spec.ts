import type { MessageView } from './view'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import MessageRow from './message-row.svelte'

const base: MessageView = {
  id: 'm1',
  conversationId: 'c1',
  authorId: 'bea',
  authorName: 'Bea Member',
  authorImage: null,
  body: 'Hello **team**, ping @Carl',
  createdAt: '2026-11-04T09:00:00.000Z',
  editedAt: null,
  deleted: false,
  parentId: null,
  replyCount: 0,
  lastReplyAt: null,
  replierIds: [],
  reactions: [],
  attachments: [],
  call: null,
  replyTo: null,
}

const props = (over: Partial<Parameters<typeof render<typeof MessageRow>>[1]> = {}) => ({
  message: base,
  me: 'carl',
  reactionEmoji: ['👍', '🎉'],
  onreact: vi.fn(),
  ontogglepicker: vi.fn(),
  ...over,
})

describe('message-row.svelte', () => {
  it('a new run shows avatar (initials without a picture), bold name and time; @mentions of me are highlighted', async () => {
    render(MessageRow, props({ mentions: { names: ['Carl', 'Bea Member'], me: ['Carl'] } }))
    const row = page.getByTestId('messages-item')
    await expect.element(row).toHaveAttribute('data-grouped', 'false')
    await expect.element(page.getByTestId('messages-author')).toHaveTextContent('Bea Member')
    await expect.element(page.getByTestId('messages-avatar')).toHaveAttribute('data-has-image', 'false')
    await expect.element(page.getByTestId('messages-avatar')).toHaveTextContent('BM')
    await expect.element(page.getByTestId('messages-body').getByText('team')).toBeInTheDocument()
    const mention = page.getByTestId('messages-body').getByText('@Carl')
    await expect.element(mention).toHaveAttribute('data-mention', 'me')
  })

  it('a grouped row has no avatar or name, only the time in the gutter', async () => {
    render(MessageRow, props({ grouped: true }))
    await expect.element(page.getByTestId('messages-item')).toHaveAttribute('data-grouped', 'true')
    expect(page.getByTestId('messages-avatar').elements()).toHaveLength(0)
    expect(page.getByTestId('messages-author').elements()).toHaveLength(0)
    await expect.element(page.getByTestId('messages-gutter-time')).toBeInTheDocument()
  })

  it('shows the author’s picture when there is one', async () => {
    render(MessageRow, props({ message: { ...base, authorImage: '/api/people/avatar/' + 'a'.repeat(64) } }))
    await expect.element(page.getByTestId('messages-avatar')).toHaveAttribute('data-has-image', 'true')
  })

  it('the hover toolbar offers react, reply, edit and delete as allowed, and calls back', async () => {
    const onreply = vi.fn()
    const ondelete = vi.fn()
    const ontogglepicker = vi.fn()
    render(MessageRow, props({ canEdit: true, canDelete: true, onreply, ondelete, ontogglepicker, me: 'bea' }))
    const toolbar = page.getByTestId('messages-actions')
    await expect.element(toolbar).toBeInTheDocument()
    await page.getByTestId('messages-item').hover()
    await expect.element(toolbar).toBeVisible()
    await page.getByTestId('messages-reply').click()
    expect(onreply).toHaveBeenCalledOnce()
    await page.getByTestId('messages-react').click()
    expect(ontogglepicker).toHaveBeenCalledOnce()
    await page.getByTestId('messages-delete').click()
    expect(ondelete).toHaveBeenCalledOnce()
    await expect.element(page.getByTestId('messages-edit-start')).toBeInTheDocument()
  })

  it('no edit/delete for someone else’s message; no toolbar on a deleted one', async () => {
    const r = render(MessageRow, props())
    expect(page.getByTestId('messages-edit-start').elements()).toHaveLength(0)
    expect(page.getByTestId('messages-delete').elements()).toHaveLength(0)
    r.unmount()
    render(MessageRow, props({ message: { ...base, deleted: true, body: '' } }))
    await expect.element(page.getByTestId('messages-deleted')).toHaveTextContent('Message deleted')
    expect(page.getByTestId('messages-actions').elements()).toHaveLength(0)
  })

  it('reactions are pills (mine pressed) and the picker reacts', async () => {
    const onreact = vi.fn()
    render(
      MessageRow,
      props({
        onreact,
        pickerOpen: true,
        message: { ...base, reactions: [{ emoji: '👍', userIds: ['carl', 'bea'], names: ['Carl', 'Bea'] }] },
      }),
    )
    const pill = page.getByTestId('messages-reaction')
    await expect.element(pill).toHaveAttribute('aria-pressed', 'true')
    await expect.element(pill).toHaveAttribute('data-count', '2')
    await page.getByRole('menuitem', { name: 'React 🎉' }).click()
    expect(onreact).toHaveBeenCalledWith('🎉')
  })

  it('a thread summary shows the reply count and the repliers’ avatars', async () => {
    render(
      MessageRow,
      props({
        message: { ...base, replyCount: 3, lastReplyAt: new Date(Date.now() - 2 * 3600_000).toISOString(), replierIds: ['carl'] },
        repliers: [{ id: 'carl', name: 'Carl Member', image: null }],
      }),
    )
    const link = page.getByTestId('messages-thread-link')
    await expect.element(link).toHaveTextContent(/3 replies/)
    await expect.element(link).toHaveTextContent(/last reply 2h ago/)
    await expect.element(page.getByTestId('messages-replier')).toHaveTextContent('CM')
  })

  it('a call line renders from its call data — "Call, 4 min" / "Missed call" — with no edit action', async () => {
    const line = { ...base, body: '', call: { callId: 'c1', outcome: 'ended' as const, durationSeconds: 245 } }
    const r = render(MessageRow, props({ message: line, me: 'bea', canEdit: false, canDelete: true }))
    const row = page.getByTestId('messages-call-line')
    await expect.element(row).toHaveTextContent('Call, 4 min')
    await expect.element(row).toHaveAttribute('data-outcome', 'ended')
    expect(page.getByTestId('messages-body').elements()).toHaveLength(0)
    expect(page.getByTestId('messages-edit-start').elements()).toHaveLength(0)
    r.unmount()
    render(MessageRow, props({ message: { ...line, call: { callId: 'c2', outcome: 'missed' as const, durationSeconds: null } } }))
    await expect.element(page.getByTestId('messages-call-line')).toHaveTextContent('Missed call')
    await expect.element(page.getByTestId('messages-call-line')).toHaveAttribute('data-outcome', 'missed')
  })
})

describe('message-row.svelte — quoted replies (Contribute 2a58bcc8)', () => {
  const quote = {
    id: 'o1',
    parentId: null,
    deleted: false,
    authorId: 'carl',
    authorName: 'Carl Member',
    snippet: 'Lunch at noon?',
    attachment: null,
    call: false,
  }

  it('"Reply" in the hover toolbar quotes the message', async () => {
    const onquote = vi.fn()
    render(MessageRow, props({ onquote }))
    await page.getByTestId('messages-item').hover()
    await page.getByTestId('messages-quote').click()
    expect(onquote).toHaveBeenCalledOnce()
  })

  it('right-click opens the message menu; Reply from it quotes, Esc closes it', async () => {
    const onquote = vi.fn()
    render(MessageRow, props({ onquote, onreply: vi.fn() }))
    await page.getByTestId('messages-body').click({ button: 'right' })
    const menu = page.getByTestId('messages-context-menu')
    await expect.element(menu).toBeVisible()
    await expect.element(page.getByTestId('messages-menu-quote')).toHaveFocus()
    await expect.element(page.getByTestId('messages-menu-thread')).toBeInTheDocument()
    await page.getByTestId('messages-menu-quote').click()
    expect(onquote).toHaveBeenCalledOnce()
    expect(menu.elements()).toHaveLength(0)

    await page.getByTestId('messages-body').click({ button: 'right' })
    await expect.element(menu).toBeVisible()
    await userEvent.keyboard('{Escape}')
    expect(menu.elements()).toHaveLength(0)
    await expect.element(page.getByTestId('messages-item')).toHaveFocus()
  })

  it('keyboard: a focused row replies with R', async () => {
    const onquote = vi.fn()
    render(MessageRow, props({ onquote }))
    ;(page.getByTestId('messages-item').element() as HTMLElement).focus()
    await userEvent.keyboard('r')
    expect(onquote).toHaveBeenCalledOnce()
  })

  it('a reply shows its quote (author and first line) and clicking it opens the original', async () => {
    const onopenquote = vi.fn()
    render(MessageRow, props({ message: { ...base, replyTo: quote }, onopenquote }))
    const q = page.getByTestId('reply-quote')
    await expect.element(q).toHaveAttribute('data-reply-to', 'o1')
    await expect.element(page.getByTestId('reply-quote-author')).toHaveTextContent('Carl Member')
    await expect.element(page.getByTestId('reply-quote-snippet')).toHaveTextContent('Lunch at noon?')
    await q.click()
    expect(onopenquote).toHaveBeenCalledOnce()
  })

  it('a quote of a voice message shows the voice marker; a deleted original says so', async () => {
    const r = render(
      MessageRow,
      props({ message: { ...base, replyTo: { ...quote, snippet: '', attachment: { kind: 'voice' as const, label: 'Voice message', count: 1 } } } }),
    )
    await expect.element(page.getByTestId('reply-quote-file')).toHaveAttribute('data-kind', 'voice')
    await expect.element(page.getByTestId('reply-quote-file')).toHaveTextContent('Voice message')
    r.unmount()
    render(MessageRow, props({ message: { ...base, replyTo: { ...quote, deleted: true, authorId: null, authorName: null, snippet: '' } } }))
    await expect.element(page.getByTestId('reply-quote-deleted')).toHaveTextContent('Original message deleted')
    await expect.element(page.getByTestId('reply-quote')).toBeDisabled()
  })

  it('the original a quote jumped to is highlighted', async () => {
    render(MessageRow, props({ highlighted: true }))
    await expect.element(page.getByTestId('messages-item')).toHaveAttribute('data-highlighted', 'true')
  })
})
