import { describe, expect, it } from 'vitest'
import { endpointHash } from '$lib/push/endpoint-hash'
import { parseReplacedEndpoint, pushDeviceView } from './device'
import {
  isPushSubscriptionInfrastructureError,
  parsePushSubscriptionBody,
  PUSH_SUBSCRIBE_USER_ERROR,
} from './subscription'

describe('parsePushSubscriptionBody', () => {
  it('accepts valid subscription JSON', () => {
    const input = parsePushSubscriptionBody({
      endpoint: 'https://push.example/send/abc',
      keys: { p256dh: 'key1', auth: 'key2' },
    })
    expect(input).toEqual({
      endpoint: 'https://push.example/send/abc',
      keys: { p256dh: 'key1', auth: 'key2' },
    })
  })

  it('rejects endpoint with interior whitespace', () => {
    expect(() =>
      parsePushSubscriptionBody({
        endpoint: 'https://push.example/a b',
        keys: { p256dh: 'k', auth: 'a' },
      }),
    ).toThrow(/whitespace/)
  })

  it('rejects missing keys', () => {
    expect(() => parsePushSubscriptionBody({ endpoint: 'https://push.example/x' })).toThrow(/keys/)
  })
})

describe('isPushSubscriptionInfrastructureError', () => {
  it('detects Drizzle Failed query dumps', () => {
    expect(
      isPushSubscriptionInfrastructureError(
        new Error(
          'Failed query: insert into "push_subscription" ("id", "user_id") values (default, $1)',
        ),
      ),
    ).toBe(true)
  })

  it('does not treat validation messages as infrastructure errors', () => {
    expect(isPushSubscriptionInfrastructureError(new Error('endpoint is required'))).toBe(false)
  })

  it('exports a user-safe subscribe error constant', () => {
    expect(PUSH_SUBSCRIBE_USER_ERROR.includes('Failed query')).toBe(false)
    expect(PUSH_SUBSCRIBE_USER_ERROR.length).toBeGreaterThan(20)
  })
})

describe('pushDeviceView', () => {
  const row = {
    id: 's1',
    userId: 'u1',
    endpoint: 'https://web.push.apple.com/QGx2dk',
    p256dh: 'p',
    auth: 'a',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)',
    createdAt: new Date('2026-11-01T08:00:00Z'),
    updatedAt: new Date('2026-11-20T08:00:00Z'),
  }

  it('lists a device without its endpoint or keys: the push service, the hash, when', async () => {
    const view = await pushDeviceView(row)
    expect(view).toEqual({
      id: 's1',
      endpointHash: await endpointHash(row.endpoint),
      service: 'web.push.apple.com',
      userAgent: row.userAgent,
      since: '2026-11-01T08:00:00.000Z',
      lastSeen: '2026-11-20T08:00:00.000Z',
    })
    expect(JSON.stringify(view)).not.toContain('QGx2dk')
  })
})

describe('parseReplacedEndpoint', () => {
  it('reads the endpoint a renewed subscription replaces (pushsubscriptionchange)', () => {
    expect(parseReplacedEndpoint({ replacesEndpoint: ' https://old ' }, 'https://new')).toBe('https://old')
  })

  it('is null when absent or the same endpoint', () => {
    expect(parseReplacedEndpoint({}, 'https://new')).toBeNull()
    expect(parseReplacedEndpoint({ replacesEndpoint: 'https://new' }, 'https://new')).toBeNull()
  })

  it('rejects a replacesEndpoint that is not a string', () => {
    expect(() => parseReplacedEndpoint({ replacesEndpoint: 3 }, 'https://new')).toThrow(/replacesEndpoint/)
  })
})
