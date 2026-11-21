import type { PushEnvironment } from './push-prompt'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { NotificationDevice } from '$lib/kernel/notification-tools'
import PushDevices from './push-devices.svelte'

const iphone: NotificationDevice = {
  id: 'd1',
  endpointHash: 'hash-iphone',
  service: 'web.push.apple.com',
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15',
  since: '2026-11-01T08:00:00.000Z',
  lastSeen: '2026-11-20T08:00:00.000Z',
}
const laptop: NotificationDevice = {
  id: 'd2',
  endpointHash: 'hash-laptop',
  service: 'fcm.googleapis.com',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0',
  since: '2026-10-01T08:00:00.000Z',
  lastSeen: '2026-11-19T08:00:00.000Z',
}
const env = (over: Partial<PushEnvironment> = {}): PushEnvironment => ({
  serviceWorker: true,
  pushManager: true,
  notification: true,
  permission: 'granted',
  subscribed: true,
  standalone: true,
  ...over,
})

describe('push-devices.svelte — Settings → Account → Notifications', () => {
  it('lists this person’s devices with notifications on and marks this one', async () => {
    render(PushDevices, {
      devices: [iphone, laptop],
      currentEndpointHash: async () => 'hash-iphone',
      sendTest: vi.fn(),
      readEnv: async () => env(),
      enable: vi.fn(),
    })
    await expect.element(page.getByTestId('push-device-d1')).toHaveTextContent('iPhone')
    await expect.element(page.getByTestId('push-device-d1')).toHaveTextContent('This device')
    await expect.element(page.getByTestId('push-device-d2')).toHaveTextContent('Macintosh')
    await expect.element(page.getByTestId('push-device-d2')).not.toHaveTextContent('This device')
  })

  it('sends a test notification to one device and says how it went', async () => {
    const sendTest = vi.fn(async () => ({ sent: 1, failed: 0, removed: 0 }))
    render(PushDevices, {
      devices: [iphone, laptop],
      currentEndpointHash: async () => null,
      sendTest,
      readEnv: async () => env({ subscribed: false }),
      enable: vi.fn(),
    })
    await page.getByTestId('push-device-test-d2').click()
    await vi.waitFor(() => expect(sendTest).toHaveBeenCalledWith('d2'))
    await expect.element(page.getByTestId('push-device-d2')).toHaveTextContent('Sent')
  })

  it('shows the push service’s refusal instead of "Sent"', async () => {
    const sendTest = vi.fn(async () => {
      throw new Error('Push delivery failed: 403 BadJwtToken')
    })
    render(PushDevices, {
      devices: [iphone],
      currentEndpointHash: async () => null,
      sendTest,
      readEnv: async () => env({ subscribed: false }),
      enable: vi.fn(),
    })
    await page.getByTestId('push-device-test-d1').click()
    await expect.element(page.getByTestId('push-device-d1')).toHaveTextContent('403 BadJwtToken')
  })

  it('offers to turn notifications on when this device is not listed', async () => {
    const onchanged = vi.fn()
    const enable = vi.fn(async () => {})
    render(PushDevices, {
      devices: [],
      currentEndpointHash: async () => null,
      sendTest: vi.fn(),
      readEnv: async () => env({ permission: 'default', subscribed: false }),
      enable,
      onchanged,
    })
    await expect.element(page.getByTestId('push-devices-empty')).toBeInTheDocument()
    await page.getByTestId('push-banner-enable').click()
    await vi.waitFor(() => expect(onchanged).toHaveBeenCalledOnce())
  })
})
