import { describe, expect, it } from 'vitest'
import { readDomainsConfig } from './config'

describe('readDomainsConfig', () => {
  it('none set → null (self-hosted: no buying here)', () => {
    expect(readDomainsConfig({})).toBeNull()
    expect(readDomainsConfig({ EE_DOMAINS_API_BASE: ' ', EE_DOMAINS_TOKEN: '' })).toBeNull()
  })

  it('both set → the config', () => {
    expect(readDomainsConfig({ EE_DOMAINS_API_BASE: 'https://cloud.example.com', EE_DOMAINS_TOKEN: 'tok' })).toEqual({
      apiBase: 'https://cloud.example.com',
      token: 'tok',
    })
  })

  it('a partial set throws naming the missing one', () => {
    expect(() => readDomainsConfig({ EE_DOMAINS_API_BASE: 'https://cloud.example.com' })).toThrow(
      /EE_DOMAINS_TOKEN is not set/,
    )
    expect(() => readDomainsConfig({ EE_DOMAINS_TOKEN: 'tok' })).toThrow(/EE_DOMAINS_API_BASE is not set/)
  })

  it('the base must be a bare https origin', () => {
    expect(() => readDomainsConfig({ EE_DOMAINS_API_BASE: 'http://cloud.example.com', EE_DOMAINS_TOKEN: 't' })).toThrow(
      /bare https origin/,
    )
    expect(() => readDomainsConfig({ EE_DOMAINS_API_BASE: 'https://cloud.example.com/api', EE_DOMAINS_TOKEN: 't' })).toThrow(
      /bare https origin/,
    )
    expect(() => readDomainsConfig({ EE_DOMAINS_API_BASE: 'cloud', EE_DOMAINS_TOKEN: 't' })).toThrow(/not a URL/)
  })
})
