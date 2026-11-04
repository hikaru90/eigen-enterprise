import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import MessageRow from './message-row.svelte'
import type { MessageView } from './view'

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
})
