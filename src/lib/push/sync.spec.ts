import { describe, expect, it } from 'vitest'
import { base64UrlToBytes, bytesToBase64Url } from './keys'
import { startupPushAction } from './sync'

const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'

describe('server key encoding', () => {
  it('round-trips the VAPID public key (base64url, no padding)', () => {
    expect(bytesToBase64Url(base64UrlToBytes(KEY))).toBe(KEY)
  })
})

describe('startupPushAction — every app start re-validates this device', () => {
  const local = (key: string | null) => ({ endpoint: 'https://web.push.apple.com/x', serverKey: key })

  it('re-registers an existing subscription with the server (it may have lost or pruned it)', () => {
    expect(startupPushAction({ permission: 'granted', local: local(KEY), vapidKey: KEY })).toBe('register')
    // A browser that does not expose the key: register as is.
    expect(startupPushAction({ permission: 'granted', local: local(null), vapidKey: KEY })).toBe('register')
  })

  it('subscribes anew when the subscription was made with another VAPID key (pushes to it never arrive)', () => {
    expect(startupPushAction({ permission: 'granted', local: local('BOther'), vapidKey: KEY })).toBe('resubscribe')
  })

  it('does nothing without a subscription or without permission — turning it on is the person’s tap', () => {
    expect(startupPushAction({ permission: 'granted', local: null, vapidKey: KEY })).toBe('none')
    expect(startupPushAction({ permission: 'default', local: local(KEY), vapidKey: KEY })).toBe('none')
    expect(startupPushAction({ permission: 'denied', local: local(KEY), vapidKey: KEY })).toBe('none')
  })
})
