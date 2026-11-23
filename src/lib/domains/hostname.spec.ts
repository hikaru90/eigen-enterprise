import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toolInputJsonSchema } from '$lib/kernel/openapi'
import { HOSTNAME as EE_HOSTNAME } from '../../../ee/src/spec'
import { HOSTNAME_MAX_LENGTH, hostnameSchema, isHostname, registrableDomainOf } from './hostname'

/** A syntactically valid host of `length` characters (196..259): three 63-char labels, one more, then .com. */
function hostOfLength(length: number): string {
  return `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(length - 196)}.com`
}

describe('the one hostname validator (kernel side)', () => {
  it.each([
    'shop.example.com',
    'os.ee.localhost',
    'localhost',
    'Shop.Example.com',
    'a..com',
    hostOfLength(253),
    hostOfLength(254),
  ])('agrees with ee’s HOSTNAME (ee keeps its own copy) on %j', (h) => {
    expect(isHostname(h)).toBe(EE_HOSTNAME.test(h))
  })

  it('caps a host at 253 characters', () => {
    expect(hostOfLength(253)).toHaveLength(253)
    expect(isHostname(hostOfLength(253))).toBe(true)
    expect(isHostname(hostOfLength(254))).toBe(false)
    expect(hostnameSchema.safeParse(hostOfLength(254)).success).toBe(false)
    expect(HOSTNAME_MAX_LENGTH).toBe(253)
  })

  it('reaches models as a plain pattern plus maxLength — no lookaround a constrained decoder refuses', () => {
    // OpenRouter's OpenInference (DeepSeek Flash) answered every chat turn offering a
    // tool with the old `^(?=.{1,253}$)…` pattern with HTTP 400 (demo, 2026-11-23).
    const schema = toolInputJsonSchema(z.object({ host: hostnameSchema })) as {
      properties: { host: { pattern: string; maxLength: number } }
    }
    expect(schema.properties.host.maxLength).toBe(253)
    expect(schema.properties.host.pattern).not.toMatch(/\(\?<?[=!]/)
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
