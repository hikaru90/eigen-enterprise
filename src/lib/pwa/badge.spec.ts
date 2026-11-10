import { describe, expect, it, vi } from 'vitest'
import { syncAppBadge, totalUnread } from './badge'

describe('totalUnread', () => {
  it('sums the unread counts of every conversation', () => {
    expect(totalUnread([{ unread: 2 }, { unread: 0 }, { unread: 5 }])).toBe(7)
    expect(totalUnread([])).toBe(0)
  })
})

describe('syncAppBadge', () => {
  it('shows the count on the app icon, and clears it at zero', async () => {
    const nav = { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) }
    await syncAppBadge(4, nav)
    expect(nav.setAppBadge).toHaveBeenCalledWith(4)
    await syncAppBadge(0, nav)
    expect(nav.clearAppBadge).toHaveBeenCalledTimes(1)
  })

  it('does nothing where the platform has no app badge', async () => {
    await expect(syncAppBadge(3, {})).resolves.toBeUndefined()
  })

  it('a refused badge is logged, never thrown into the page', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const nav = { setAppBadge: vi.fn(async () => Promise.reject(new Error('NotAllowed'))), clearAppBadge: vi.fn() }
    await syncAppBadge(1, nav)
    expect(error).toHaveBeenCalledWith('[pwa] app badge update failed', expect.any(Error))
    error.mockRestore()
  })
})
