import { describe, expect, it } from 'vitest'
import {
  fetchStrategy,
  notificationFor,
  notificationTarget,
  OFFLINE_HTML,
  parsePushPayload,
  UNREADABLE_PUSH,
} from './sw-core'

const data = (raw: string) => ({ text: () => raw })

describe('parsePushPayload', () => {
  it('reads the server payload (title, body, url, tag, badge)', () => {
    const raw = JSON.stringify({ title: 'Bea', body: 'hi', url: '/messages?c=1', tag: 'messages-1', badge: 3 })
    expect(parsePushPayload(data(raw))).toEqual({
      title: 'Bea',
      body: 'hi',
      url: '/messages?c=1',
      tag: 'messages-1',
      badge: 3,
    })
  })

  it('a payload without a badge carries none', () => {
    const raw = JSON.stringify({ title: 'T', body: 'B', url: '/', tag: 't' })
    expect(parsePushPayload(data(raw)).badge).toBeUndefined()
  })

  it('an unreadable push says so — never a made-up message', () => {
    // Every push must show a notification (iOS revokes silent ones), so a broken
    // payload is shown as broken, not dropped and not dressed up.
    expect(parsePushPayload(null)).toEqual(UNREADABLE_PUSH)
    expect(parsePushPayload(data('not json'))).toEqual(UNREADABLE_PUSH)
    expect(parsePushPayload(data(JSON.stringify({ title: 'only a title' })))).toEqual(UNREADABLE_PUSH)
    expect(parsePushPayload(data(JSON.stringify({ title: 'T', body: 'B', url: '/', tag: 't', badge: -1 })))).toEqual(
      UNREADABLE_PUSH,
    )
  })
})

describe('notificationFor', () => {
  it('replaces the previous notification of the same conversation (tag) and keeps the url', () => {
    const n = notificationFor({ title: 'Bea', body: 'hi', url: '/messages?c=1', tag: 'messages-1' })
    expect(n.title).toBe('Bea')
    expect(n.options).toMatchObject({
      body: 'hi',
      tag: 'messages-1',
      renotify: true,
      data: { url: '/messages?c=1' },
      icon: '/app-icon/any-192.png',
      badge: '/notification-badge.png',
    })
  })
})

describe('notificationTarget', () => {
  it('resolves app paths on the origin', () => {
    expect(notificationTarget({ url: '/messages?c=1&t=2' }, 'https://os.co.test')).toEqual({
      href: 'https://os.co.test/messages?c=1&t=2',
      path: '/messages?c=1&t=2',
    })
  })

  it('never leaves the origin, and opens the app when the data has no url', () => {
    expect(notificationTarget({ url: 'https://evil.test/x' }, 'https://os.co.test').href).toBe('https://os.co.test/')
    expect(notificationTarget(null, 'https://os.co.test').path).toBe('/')
  })
})

describe('fetchStrategy', () => {
  const origin = 'https://os.co.test'
  const shell = new Set(['/_app/immutable/entry/start.abc.js', '/pwa-192.png'])
  const req = (url: string, mode: RequestMode = 'cors', method = 'GET') => ({ url, mode, method })

  it('serves the hashed app shell from cache', () => {
    expect(fetchStrategy(req(`${origin}/_app/immutable/entry/start.abc.js`), origin, shell)).toBe('cache')
  })

  it('page loads go to the network, with an explicit offline page when it is unreachable', () => {
    expect(fetchStrategy(req(`${origin}/messages`, 'navigate'), origin, shell)).toBe('network-or-offline')
  })

  it('leaves everything else alone: APIs, the live stream, other origins, writes', () => {
    expect(fetchStrategy(req(`${origin}/api/messages/stream?after=1`), origin, shell)).toBe('passthrough')
    expect(fetchStrategy(req(`${origin}/api/messages/conversations`), origin, shell)).toBe('passthrough')
    expect(fetchStrategy(req('https://fonts.googleapis.com/css'), origin, shell)).toBe('passthrough')
    expect(fetchStrategy(req(`${origin}/pwa-192.png`, 'cors', 'POST'), origin, shell)).toBe('passthrough')
  })
})

describe('OFFLINE_HTML', () => {
  it('tells the person they are offline and lets them retry', () => {
    expect(OFFLINE_HTML).toContain('offline')
    expect(OFFLINE_HTML).toContain('location.reload()')
  })
})
