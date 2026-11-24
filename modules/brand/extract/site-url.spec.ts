import { describe, expect, it } from 'vitest'
import { normalizeSiteUrl, siteUrlSchema } from './site-url'

describe('normalizeSiteUrl', () => {
  it('gives a bare host https://', () => {
    expect(normalizeSiteUrl('www.eigenenterprise.app')).toBe('https://www.eigenenterprise.app')
    expect(normalizeSiteUrl('  example.com/about ')).toBe('https://example.com/about')
  })
  it('keeps an explicit http(s) URL', () => {
    expect(normalizeSiteUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeSiteUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })
  it('refuses what is not an http(s) site', () => {
    for (const bad of [
      '',
      '   ',
      'not a url',
      'ftp://example.com',
      'javascript:alert(1)',
      'https://',
    ]) {
      expect(normalizeSiteUrl(bad), bad).toBeNull()
    }
  })
})

describe('siteUrlSchema', () => {
  it('normalises, and refuses with a person-facing message', () => {
    expect(siteUrlSchema.parse('www.eigenenterprise.app')).toBe('https://www.eigenenterprise.app')
    const r = siteUrlSchema.safeParse('not a url')
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.issues[0].message).toMatch(/not a web address/)
  })
})
