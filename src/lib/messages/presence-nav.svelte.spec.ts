import type { PresenceView } from './presence'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import PresenceNav from './presence-nav.svelte'
import { SelfPresence, type SelfPresenceFetch } from './self-presence.svelte'

const view = (over: Partial<PresenceView> = {}): PresenceView => ({
  userId: 'bea',
  status: 'online',
  doNotDisturb: false,
  lastSeenAt: '2026-11-13T09:00:00.000Z',
  ...over,
})

const answer = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

function keeper(start: PresenceView | null, fetch: SelfPresenceFetch = vi.fn<SelfPresenceFetch>()) {
  const self = new SelfPresence({ fetch })
  if (start) self.receive(start)
  return self
}

const props = (self: SelfPresence) => ({ self, name: 'Bea Member', email: 'bea@k.test', image: null })

describe('presence-nav.svelte (my status at the foot of the main nav — Contribute e4ef6be1)', () => {
  it('shows my name, the status dot on my picture and the status in words', async () => {
    render(PresenceNav, props(keeper(view({ status: 'dnd', doNotDisturb: true }))))
    await expect.element(page.getByTestId('shell-user')).toHaveTextContent('Bea Member')
    await expect.element(page.getByTestId('shell-presence-label')).toHaveTextContent('Do not disturb')
    await expect.element(page.getByTestId('shell-presence-dot')).toHaveAttribute('data-status', 'dnd')
    await expect
      .element(page.getByTestId('shell-presence-trigger'))
      .toHaveAccessibleName('Your status: Do not disturb. Change status')
  })

  it('opens my status card: the email and the Do not disturb switch, which saves', async () => {
    const fetch = vi.fn<SelfPresenceFetch>(async () => answer({ presence: view({ status: 'dnd', doNotDisturb: true }) }))
    const self = keeper(view(), fetch)
    render(PresenceNav, props(self))
    await page.getByTestId('shell-presence-trigger').click()
    await expect.element(page.getByTestId('shell-presence-email')).toHaveTextContent('bea@k.test')
    const toggle = page.getByRole('switch', { name: 'Do not disturb' })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    // Its own id: Messages shows its own copy of the switch (id presence-dnd) on the same screen.
    await expect.element(toggle).toHaveAttribute('id', 'shell-presence-dnd')
    await toggle.click()
    expect(fetch).toHaveBeenCalledWith('/api/messages/presence', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ doNotDisturb: true }) }))
    await expect.element(page.getByTestId('shell-presence-label')).toHaveTextContent('Do not disturb')
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
  })

  it('a status change from elsewhere shows at once', async () => {
    const self = keeper(view())
    render(PresenceNav, props(self))
    await expect.element(page.getByTestId('shell-presence-label')).toHaveTextContent('Online')
    self.receive(view({ status: 'in_call' }))
    await expect.element(page.getByTestId('shell-presence-label')).toHaveTextContent('In a call')
    await expect.element(page.getByTestId('shell-presence-dot')).toHaveAttribute('data-status', 'in_call')
  })

  it('before the first heartbeat answers it says so, with no made-up dot', async () => {
    render(PresenceNav, props(keeper(null)))
    await expect.element(page.getByTestId('shell-presence-label')).toHaveTextContent('Checking status…')
    await expect.element(page.getByTestId('shell-presence-dot')).not.toBeInTheDocument()
  })

  it('a status that cannot be loaded is shown, never hidden', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const self = keeper(null, async () => Promise.reject(new TypeError('Failed to fetch')))
    self.beat({ clientId: 'tab-0123456789', state: 'active' })
    render(PresenceNav, props(self))
    await expect.element(page.getByTestId('shell-presence-label')).toHaveTextContent('Status unavailable')
    await page.getByTestId('shell-presence-trigger').click()
    await expect.element(page.getByRole('alert')).toHaveTextContent('Status could not be updated: Failed to fetch')
    err.mockRestore()
  })
})
