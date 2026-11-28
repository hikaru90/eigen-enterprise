import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, goto: vi.fn() }))
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }))

import NotificationBell from './notification-bell.svelte'

const item = (key: string, unread: boolean) => ({
  key,
  kind: 'question',
  title: 'Ony asks',
  detail: `Question ${key}`,
  href: '/m/memory/questions',
  at: '2026-11-27T10:00:00.000Z',
  unread,
})
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe('notification-bell.svelte', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    return () => vi.unstubAllGlobals()
  })

  it('shows the unread count on the bell and lists what needs me', async () => {
    fetchMock.mockResolvedValue(ok({ items: [item('question:a', true), item('question:b', false)], mentions: [], unread: 1 }))
    render(NotificationBell)
    await expect.element(page.getByTestId('notification-bell-count')).toHaveTextContent('1')
    await page.getByTestId('notification-bell').click()
    await expect.element(page.getByText('Question question:a')).toBeVisible()
    await expect.element(page.getByText('Question question:b')).toBeVisible()
  })

  it('lists mentions with the rest, newest first, and counts them', async () => {
    const mention = { ...item('mention:m1', true), kind: 'mention', title: 'Kim mentioned you in #general', detail: 'hey @bea', href: '/messages?c=c1', at: '2026-11-28T10:00:00.000Z' }
    fetchMock.mockResolvedValue(ok({ items: [item('question:a', true)], mentions: [mention], unread: 2 }))
    render(NotificationBell)
    await expect.element(page.getByTestId('notification-bell-count')).toHaveTextContent('2')
    await page.getByTestId('notification-bell').click()
    const rows = page.getByTestId('notification-bell-item')
    await expect.element(rows.nth(0)).toHaveAttribute('data-kind', 'mention')
    await expect.element(rows.nth(0)).toHaveAttribute('href', '/messages?c=c1')
    await expect.element(rows.nth(1)).toHaveAttribute('data-kind', 'question')
    await page.getByTestId('notification-bell-mark-all').click()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/notifications',
      expect.objectContaining({ body: JSON.stringify({ keys: ['mention:m1', 'question:a'] }) }),
    )
  })

  it('marks all read through the API and the count goes away', async () => {
    fetchMock.mockResolvedValueOnce(ok({ items: [item('question:a', true)], mentions: [], unread: 1 }))
    fetchMock.mockResolvedValueOnce(ok({ items: [item('question:a', false)], mentions: [], unread: 0 }))
    render(NotificationBell)
    await page.getByTestId('notification-bell').click()
    await page.getByTestId('notification-bell-mark-all').click()
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/notifications',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ keys: ['question:a'] }) }),
    )
    await expect.element(page.getByTestId('notification-bell-count')).not.toBeInTheDocument()
  })

  it('says when nothing needs me, and says a failed load', async () => {
    fetchMock.mockResolvedValueOnce(ok({ items: [], mentions: [], unread: 0 }))
    render(NotificationBell)
    await page.getByTestId('notification-bell').click()
    await expect.element(page.getByText('Nothing needs you right now.')).toBeVisible()
  })

  it('a failed load is said, not hidden', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ message: 'db down' }) })
    render(NotificationBell)
    await page.getByTestId('notification-bell').click()
    await expect.element(page.getByText(/db down/)).toBeVisible()
  })
})
