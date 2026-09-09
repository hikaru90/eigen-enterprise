import { describe, expect, it } from 'vitest'
import { assertPublicUrl, isPublicAddress } from './ssrf-guard'

describe('isPublicAddress', () => {
  const blocked = [
    '127.0.0.1',
    '127.8.8.8',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '198.18.0.5',
    '::1',
    '::',
    'fe80::1',
    'fec0::1',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.0.5',
    '::ffff:7f00:1',
  ]

  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '172.15.255.255',
    '100.128.0.1',
    '100.63.255.255',
    '192.169.0.1',
    '198.20.0.1',
    '2606:4700::6810:84e5',
    '2a00:1450:4001:81b::200e',
    '::ffff:8.8.8.8',
  ]

  for (const address of blocked) {
    it(`blocks ${address}`, () => {
      expect(isPublicAddress(address)).toBe(false)
    })
  }

  for (const address of allowed) {
    it(`allows ${address}`, () => {
      expect(isPublicAddress(address)).toBe(true)
    })
  }
})

describe('assertPublicUrl', () => {
  it('rejects non-http schemes', async () => {
    await expect(assertPublicUrl('ftp://example.com')).rejects.toThrow(/http\/https/)
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http\/https/)
  })

  it('rejects embedded credentials', async () => {
    await expect(assertPublicUrl('https://user:pass@example.com')).rejects.toThrow(/credentials/)
    await expect(assertPublicUrl('https://owner@example.com')).rejects.toThrow(/credentials/)
  })

  it('rejects unparseable urls', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toThrow(/invalid URL/)
  })

  it('rejects loopback hostnames via DNS resolution', async () => {
    await expect(assertPublicUrl('http://localhost')).rejects.toThrow()
  })

  it('rejects hostnames that resolve to private ranges', async () => {
    await expect(assertPublicUrl('http://127.0.0.1')).rejects.toThrow(/non-public/)
    await expect(assertPublicUrl('http://10.0.0.2')).rejects.toThrow(/non-public/)
  })

  it('returns the parsed url for public hosts', async () => {
    const url = await assertPublicUrl('https://example.com/path')
    expect(url.hostname).toBe('example.com')
  })
})
