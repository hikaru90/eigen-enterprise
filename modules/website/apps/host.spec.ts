import { describe, expect, it } from 'vitest'
import { appHost, appSlug, freeName } from './host'

describe('appHost', () => {
  it('on the local box: <app>.ee.localhost next to the console (local CA)', () => {
    expect(appHost('os.ee.localhost', 'shop')).toBe('shop.ee.localhost')
  })
  it('pre-DNS on a server: <app>.<ip>.sslip.io', () => {
    expect(appHost('203-0-113-7.sslip.io', 'shop')).toBe('shop.203-0-113-7.sslip.io')
    expect(appHost('os.203-0-113-7.sslip.io', 'shop')).toBe('shop.203-0-113-7.sslip.io')
  })
  it("on the owner's own domain there is no automatic host: the owner gives one", () => {
    expect(appHost('os.kindred.dev', 'shop')).toBeNull()
  })
  it('a bare localhost console still yields a name under localhost', () => {
    expect(appHost('localhost', 'shop')).toBe('shop.localhost')
  })
})

describe('appSlug', () => {
  it('turns a repo name into a valid app name', () => {
    expect(appSlug('node-js-getting-started')).toBe('node-js-getting-started')
    expect(appSlug('My_Site.v2')).toBe('my-site-v2')
    expect(appSlug('2048')).toBe('app-2048')
    expect(appSlug('a'.repeat(50))).toHaveLength(31)
  })
})

describe('freeName', () => {
  it('keeps the base when it is free and moves to -2, -3 … when taken (case-insensitive)', () => {
    expect(freeName(new Set(), 'shop')).toBe('shop')
    expect(freeName(new Set(['shop', 'Shop']), 'shop')).toBe('shop-2')
    expect(freeName(new Set(['shop', 'shop-2']), 'shop')).toBe('shop-3')
  })
  it('the variant still fits the 31-character app-name shape', () => {
    const long = 'a'.repeat(31)
    expect(freeName(new Set([long]), long)).toBe(`${'a'.repeat(29)}-2`)
    expect(freeName(new Set([long, `${'a'.repeat(29)}-2`]), long)).toBe(`${'a'.repeat(29)}-3`)
  })
})
