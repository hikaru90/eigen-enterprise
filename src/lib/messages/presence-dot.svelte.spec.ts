import type { PresenceView } from './presence'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import PresenceDot from './presence-dot.svelte'
import PresenceSelf from './presence-self.svelte'

const NOW = new Date('2026-11-12T12:00:00.000Z')
const view = (over: Partial<PresenceView> = {}): PresenceView => ({
  userId: 'bea',
  status: 'online',
  doNotDisturb: false,
  lastSeenAt: null,
  ...over,
})

describe('presence-dot.svelte', () => {
  it('names the status for screen readers and as a tooltip — never color alone', async () => {
    render(PresenceDot, { presence: view({ status: 'away' }), now: NOW })
    const dot = page.getByRole('img', { name: 'Away' })
    await expect.element(dot).toHaveAttribute('title', 'Away')
    await expect.element(dot).toHaveAttribute('data-status', 'away')
  })

  it('each busy state has its own glyph, offline is a hollow ring', async () => {
    for (const status of ['in_call', 'dnd', 'away', 'online', 'offline'] as const) {
      const { unmount } = render(PresenceDot, { presence: view({ status }), now: NOW })
      const dot = page.getByTestId('presence-dot')
      await expect.element(dot).toHaveAttribute('data-status', status)
      await expect.element(dot).toHaveAttribute('data-glyph', { in_call: 'phone', dnd: 'bar', away: 'clock', online: 'none', offline: 'ring' }[status])
      unmount()
    }
  })

  it('offline people say when they were last active', async () => {
    render(PresenceDot, { presence: view({ status: 'offline', lastSeenAt: '2026-11-12T10:00:00.000Z' }), now: NOW })
    await expect.element(page.getByRole('img', { name: 'Active 2 h ago' })).toBeInTheDocument()
  })
})

describe('presence-self.svelte', () => {
  it('shows my status and a Do not disturb switch that asks to turn it on', async () => {
    const ontoggle = vi.fn()
    render(PresenceSelf, { name: 'Bea Member', image: null, presence: view(), now: NOW, saving: false, error: null, ontoggle })
    await expect.element(page.getByTestId('presence-self-label')).toHaveTextContent('Online')
    const toggle = page.getByRole('switch', { name: 'Do not disturb' })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    expect(ontoggle).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('with Do not disturb on, the switch is on and turns it off', async () => {
    const ontoggle = vi.fn()
    render(PresenceSelf, {
      name: 'Bea Member',
      image: null,
      presence: view({ status: 'dnd', doNotDisturb: true }),
      now: NOW,
      saving: false,
      error: null,
      ontoggle,
    })
    await expect.element(page.getByTestId('presence-self-label')).toHaveTextContent('Do not disturb')
    const toggle = page.getByRole('switch', { name: 'Do not disturb' })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    expect(ontoggle).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('is disabled while saving, and says when status is unavailable', async () => {
    render(PresenceSelf, {
      name: 'Bea Member',
      image: null,
      presence: view(),
      now: NOW,
      saving: true,
      error: 'Status is unavailable right now; reload to try again.',
      ontoggle: vi.fn(),
    })
    await expect.element(page.getByRole('switch', { name: 'Do not disturb' })).toBeDisabled()
    await expect.element(page.getByRole('alert')).toHaveTextContent('Status is unavailable')
  })
})
