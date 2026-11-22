import { describe, expect, it } from 'vitest'
import { HOSTNAME as EE_HOSTNAME } from '../../../ee/src/spec'
import { HOSTNAME, hostnameSchema, isHostname, registrableDomainOf } from './hostname'

describe('the one hostname validator (kernel side)', () => {
  it('is exactly ee’s HOSTNAME pattern (ee keeps its own copy)', () => {
    expect(HOSTNAME.source).toBe(EE_HOSTNAME.source)
  })

  it.each([
    'shop.example.com',
    'eigenenterprise.app',
    'news.kindred.co.uk',
    'os.ee.localhost',
    'a-b.c1.io',
  ])('accepts %s', (h) => expect(isHostname(h)).toBe(true))

  it.each([
    'localhost',
    'https://x.com',
    'x.com/',
    '-a.com',
    'a..com',
    'Shop.Example.com',
    '1.2.3.4',
    'a.com.',
    '',
  ])('refuses %j', (h) => expect(isHostname(h)).toBe(false))

  it('the schema trims and lowercases before it checks', () => {
    expect(hostnameSchema.parse('  Shop.Example.COM ')).toBe('shop.example.com')
    expect(hostnameSchema.safeParse('not a host').success).toBe(false)
  })
})

describe('registrableDomainOf (the public suffix list, never string cuts)', () => {
  it.each([
    ['eigenenterprise.app', 'eigenenterprise.app'],
    ['www.eigenenterprise.app', 'eigenenterprise.app'],
    ['rtc.one.eigenenterprise.app', 'eigenenterprise.app'],
    ['news.kindred.co.uk', 'kindred.co.uk'],
    ['acme.github.io', 'acme.github.io'],
  ])('%s → %s', (host, zone) => expect(registrableDomainOf(host)).toBe(zone))

  it('a bare public suffix has no registrable domain', () => {
    expect(registrableDomainOf('co.uk')).toBeNull()
  })
})
