import { describe, expect, it } from 'vitest'
import { pushPromptState, type PushEnvironment } from './push-prompt'

const env = (over: Partial<PushEnvironment> = {}): PushEnvironment => ({
  serviceWorker: true,
  pushManager: true,
  notification: true,
  permission: 'default',
  subscribed: false,
  standalone: false,
  ...over,
})

describe('pushPromptState', () => {
  it('asks when push is possible and not yet on for this device', () => {
    expect(pushPromptState(env())).toBe('ask')
    // Permission granted earlier, but this device has no subscription (e.g. it was removed).
    expect(pushPromptState(env({ permission: 'granted' }))).toBe('ask')
  })

  it('is on when this device is subscribed', () => {
    expect(pushPromptState(env({ permission: 'granted', subscribed: true }))).toBe('on')
  })

  it('reports a blocked permission', () => {
    expect(pushPromptState(env({ permission: 'denied' }))).toBe('denied')
  })

  it('asks to install first in a browser tab that only gets push once installed (iPhone Safari)', () => {
    expect(pushPromptState(env({ pushManager: false, notification: false }))).toBe('install-first')
  })

  it('is unsupported where even the installed app has no push', () => {
    expect(pushPromptState(env({ pushManager: false, standalone: true }))).toBe('unsupported')
    expect(pushPromptState(env({ serviceWorker: false }))).toBe('unsupported')
  })
})
