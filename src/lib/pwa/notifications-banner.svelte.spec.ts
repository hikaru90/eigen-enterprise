import type { PushEnvironment } from './push-prompt'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import NotificationsBanner from './notifications-banner.svelte'

const env = (over: Partial<PushEnvironment> = {}): PushEnvironment => ({
  serviceWorker: true,
  pushManager: true,
  notification: true,
  permission: 'default',
  subscribed: false,
  standalone: true,
  ...over,
})

describe('notifications-banner.svelte — "Turn on notifications on this device"', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('in the installed app without a subscription, offers to turn notifications on and does it on the tap', async () => {
    let current = env()
    const enable = vi.fn(async () => {
      current = env({ permission: 'granted', subscribed: true })
    })
    const onenabled = vi.fn()
    render(NotificationsBanner, { variant: 'floating', standaloneOnly: true, readEnv: async () => current, enable, onenabled })

    const banner = page.getByTestId('push-banner')
    await expect.element(banner).toHaveAttribute('data-state', 'ask')
    await expect.element(banner).toHaveTextContent('Turn on notifications on this device')
    // Nothing is asked before the person taps (iOS allows the permission prompt only from a tap).
    expect(enable).not.toHaveBeenCalled()

    await page.getByTestId('push-banner-enable').click()
    await vi.waitFor(() => expect(enable).toHaveBeenCalledOnce())
    await expect.element(banner).not.toBeInTheDocument()
    expect(onenabled).toHaveBeenCalledOnce()
  })

  it('shows why when turning on fails, and keeps the offer', async () => {
    const enable = vi.fn(async () => {
      throw new Error('Notification permission was not granted')
    })
    render(NotificationsBanner, { variant: 'floating', standaloneOnly: true, readEnv: async () => env(), enable })

    await page.getByTestId('push-banner-enable').click()
    await expect.element(page.getByTestId('push-banner-error')).toHaveTextContent('Notification permission was not granted')
    await expect.element(page.getByTestId('push-banner')).toHaveAttribute('data-state', 'ask')
  })

  it('standaloneOnly: stays hidden in a browser tab', async () => {
    const readEnv = vi.fn(async () => env({ standalone: false }))
    render(NotificationsBanner, { variant: 'floating', standaloneOnly: true, readEnv, enable: vi.fn() })
    await vi.waitFor(() => expect(readEnv).toHaveBeenCalled())
    await expect.element(page.getByTestId('push-banner')).not.toBeInTheDocument()
  })

  it('is hidden once this device gets notifications', async () => {
    const readEnv = vi.fn(async () => env({ permission: 'granted', subscribed: true }))
    render(NotificationsBanner, { variant: 'floating', readEnv, enable: vi.fn() })
    await vi.waitFor(() => expect(readEnv).toHaveBeenCalled())
    await expect.element(page.getByTestId('push-banner')).not.toBeInTheDocument()
  })

  it('a "Not now" in the browser does not hide the offer in the installed app', async () => {
    localStorage.setItem('eigenenterprise:push-banner-dismissed:ask', '1')
    render(NotificationsBanner, { readEnv: async () => env({ standalone: true }), enable: vi.fn() })
    await expect.element(page.getByTestId('push-banner')).toHaveAttribute('data-state', 'ask')
  })

  it('"Not now" in the installed app is remembered for the installed app', async () => {
    const first = render(NotificationsBanner, { readEnv: async () => env(), enable: vi.fn() })
    await page.getByTestId('push-banner-dismiss').click()
    await expect.element(page.getByTestId('push-banner')).not.toBeInTheDocument()
    expect(localStorage.getItem('eigenenterprise:push-banner-dismissed:app:ask')).toBe('1')
    first.unmount()

    const readEnv = vi.fn(async () => env())
    render(NotificationsBanner, { readEnv, enable: vi.fn() })
    await vi.waitFor(() => expect(readEnv).toHaveBeenCalled())
    await expect.element(page.getByTestId('push-banner')).not.toBeInTheDocument()
  })

  it('inline (Settings): no "Not now", always offered while this device is off', async () => {
    localStorage.setItem('eigenenterprise:push-banner-dismissed:app:ask', '1')
    render(NotificationsBanner, { variant: 'inline', readEnv: async () => env(), enable: vi.fn() })
    await expect.element(page.getByTestId('push-banner')).toHaveAttribute('data-state', 'ask')
    await expect.element(page.getByTestId('push-banner-dismiss')).not.toBeInTheDocument()
  })
})
