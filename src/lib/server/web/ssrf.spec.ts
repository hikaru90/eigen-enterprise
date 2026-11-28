import { describe, expect, it } from 'vitest'
import { isPublicAddress } from './ssrf'

describe('isPublicAddress', () => {
  it('allows public unicast addresses', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '[2a00:1450:4001:80b::200e]'])
      expect(isPublicAddress(a), a).toBe(true)
  })

  it('refuses loopback, private, link-local, metadata, CGNAT, multicast and reserved ranges', () => {
    for (const a of [
      '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1',
      'localhost', 'not-an-ip', '',
    ])
      expect(isPublicAddress(a), a).toBe(false)
  })
})
