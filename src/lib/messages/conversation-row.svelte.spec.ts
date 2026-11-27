import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { CompanyPresence } from '$lib/presence/company-presence.svelte'
import { companyWith, onItem } from '$lib/test/company-presence-double'
import ConversationRow from './conversation-row.svelte'
import type { ConversationView } from './view'

const general: ConversationView = {
  id: 'c1',
  kind: 'channel',
  title: 'general',
  topic: '',
  private: false,
  unread: 3,
  memberIds: ['me', 'anna', 'ben'],
}

const directory = [
  { id: 'me', name: 'Alex Owner' },
  { id: 'anna', name: 'Anna Müller' },
  { id: 'ben', name: 'Ben Ode' },
  { id: 'cara', name: 'Cara Lin' },
  { id: 'dan', name: 'Dan Roe' },
]

function mount(company: CompanyPresence | null, over: Partial<{ conversation: ConversationView; current: boolean }> = {}) {
  const onopen = vi.fn()
  render(ConversationRow, {
    conversation: over.conversation ?? general,
    current: over.current ?? false,
    dmWith: [],
    presenceOf: (userId: string) => ({ userId, status: 'online' as const, doNotDisturb: false, lastSeenAt: null }),
    now: new Date('2026-11-27T10:00:00Z'),
    company,
    onopen,
  })
  return { onopen, row: page.getByTestId('messages-conversation') }
}

describe('conversation-row.svelte (a channel or DM in the Messages list)', () => {
  it('without the presence feed the row is as it always was: title, unread, no avatars', async () => {
    const { row, onopen } = mount(null)
    await expect.element(row).toHaveAttribute('data-title', 'general')
    await expect.element(row.getByTestId('messages-unread')).toHaveTextContent('3')
    await expect.element(page.getByTestId('messages-conversation-presence')).not.toBeInTheDocument()
    expect(row.element().getAttribute('style')).toBeNull()
    await row.click()
    expect(onopen).toHaveBeenCalledOnce()
  })

  it('shows who has the conversation open now, beside the row (not inside its button), and keeps the unread count', async () => {
    const company = await companyWith('me', [{ userId: 'anna', where: onItem('conversation', 'c1', 'general', 'messages') }], directory)
    const { row } = mount(company)
    const stack = page.getByTestId('messages-conversation-presence')
    await expect.element(stack).toHaveAccessibleName('Anna Müller has this open')
    expect(row.element().contains(stack.element())).toBe(false)
    await expect.element(row.getByTestId('messages-unread')).toBeVisible()
    // The row's button leaves room for the stack, so the unread count is never under it.
    expect(row.element().getAttribute('style')).toMatch(/padding-right: \d+px/)
  })

  it('narrow rows: at most two avatars, +n for the rest', async () => {
    const here = onItem('conversation', 'c1', 'general', 'messages')
    const company = await companyWith(
      'me',
      ['anna', 'ben', 'cara', 'dan'].map((userId) => ({ userId, where: here })),
      directory,
    )
    mount(company)
    const stack = page.getByTestId('messages-conversation-presence')
    expect(stack.getByTestId('messages-conversation-presence-avatar').all()).toHaveLength(2)
    await expect.element(stack.getByTestId('messages-conversation-presence-more')).toHaveTextContent('+2')
    await expect.element(page.getByTestId('messages-unread')).toBeVisible()
  })

  it('nobody on this conversation (me, or someone elsewhere): no avatars', async () => {
    const company = await companyWith(
      'me',
      [
        { userId: 'me', where: onItem('conversation', 'c1', 'general', 'messages') },
        { userId: 'anna', where: onItem('conversation', 'c2', 'random', 'messages') },
        { userId: 'ben', where: onItem('drive_file', 'c1', 'c1.txt') },
      ],
      directory,
    )
    mount(company)
    await expect.element(page.getByTestId('messages-conversation-presence')).not.toBeInTheDocument()
  })

  it('tapping the avatars shows who, and does not open the conversation', async () => {
    const company = await companyWith('me', [{ userId: 'anna', where: onItem('conversation', 'c1', 'general', 'messages') }], directory)
    const { onopen } = mount(company, { current: true })
    await userEvent.click(page.getByTestId('messages-conversation-presence'))
    await expect.element(page.getByTestId('messages-conversation-presence-list')).toBeVisible()
    expect(onopen).not.toHaveBeenCalled()
  })
})
