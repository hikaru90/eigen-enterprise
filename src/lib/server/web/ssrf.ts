import { BlockList, isIP } from 'node:net'

/**
 * Which addresses the AI may open (web.fetch, wish 133f8e82): the public internet only. Loopback,
 * private, link-local (cloud metadata at 169.254.169.254), carrier-grade NAT, multicast, reserved
 * and documentation ranges are refused for IPv4 and IPv6, IPv4-mapped IPv6 included. The check
 * runs on the address a connection is made to (fetch-page.ts checks at DNS lookup time), so a
 * name that resolves to a private address is refused too.
 */
const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(net, prefix, 'ipv6')

/** The IPv4 address inside an IPv4-mapped/compatible IPv6 address (::ffff:a.b.c.d), else null. */
function mappedIpv4(address: string): string | null {
  const m = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (m) return m[1]!
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address)
  if (!hex) return null
  const hi = parseInt(hex[1]!, 16)
  const lo = parseInt(hex[2]!, 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** True only for a public unicast address; anything unparseable is refused. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '')
  const family = isIP(bare)
  if (family === 4) return !blocked.check(bare, 'ipv4')
  if (family === 6) {
    const v4 = mappedIpv4(bare)
    if (v4 !== null) return isPublicAddress(v4)
    if (/^::ffff:/i.test(bare)) return false
    return !blocked.check(bare, 'ipv6')
  }
  return false
}
