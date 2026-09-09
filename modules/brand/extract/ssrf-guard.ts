import { lookup } from 'node:dns/promises'

/**
 * SSRF guard for site capture (phase-2d M2): the owner may point the extractor
 * at any public site, but the capture browser must never be pointed at the
 * instance's own network, loopback, or cloud metadata endpoints.
 */

const BLOCKED_IPV4: Array<[number, number]> = (() => {
  const cidr = (base: string, bits: number): [number, number] => {
    const [a, b, c, d] = base.split('.').map(Number)
    const net = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return [net, mask]
  }
  return [
    cidr('0.0.0.0', 8), // this network
    cidr('10.0.0.0', 8), // private
    cidr('100.64.0.0', 10), // CGNAT (includes 169.254-adjacent metadata in some clouds)
    cidr('127.0.0.0', 8), // loopback
    cidr('169.254.0.0', 16), // link-local / cloud metadata
    cidr('172.16.0.0', 12), // private
    cidr('192.168.0.0', 16), // private
    cidr('198.18.0.0', 15), // benchmarking
    cidr('224.0.0.0', 4), // multicast
    cidr('240.0.0.0', 4), // reserved
  ]
})()

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const part of parts) {
    const v = Number(part)
    if (!Number.isInteger(v) || v < 0 || v > 255 || !/^\d+$/.test(part)) return null
    n = (n * 256 + v) >>> 0
  }
  return n
}

function isPublicIpv4(address: string): boolean {
  const n = ipv4ToNumber(address)
  if (n === null) return false
  return !BLOCKED_IPV4.some(([net, mask]) => ((n & mask) >>> 0) === net)
}

/** Expand an IPv6 address into its 8 hextets (zone id stripped); null when unparseable. */
function ipv6Hextets(address: string): number[] | null {
  const cleaned = address.replace(/^\[|\]$/g, '').split('%')[0]
  const halves = cleaned.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : []
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  if (groups.length !== 8) return null
  const hextets: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    hextets.push(parseInt(group, 16))
  }
  return hextets
}

function isPublicIpv6(address: string): boolean {
  // Dotted-quad tail form: ::ffff:10.0.0.1
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (dotted) return isPublicIpv4(dotted[1])

  const hextets = ipv6Hextets(address)
  if (!hextets) return false

  const first = hextets[0]
  if (first === 0) {
    // :: (unspecified), ::1 (loopback), ::ffff:x/96 + ::x.x.x.x (IPv4-mapped)
    if (hextets.every((h) => h === 0)) return false
    if (hextets.slice(0, 7).every((h) => h === 0) && hextets[7] === 1) return false
    if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
      return isPublicIpv4(`${(hextets[6] >> 8) & 0xff}.${hextets[6] & 0xff}.${(hextets[7] >> 8) & 0xff}.${hextets[7] & 0xff}`)
    }
    if (hextets.slice(0, 5).every((h) => h === 0)) {
      // ::x.x.x.x compatible / other low mappings — treat as non-public
      return false
    }
  }
  if (first >= 0xfc00 && first <= 0xfeff) return false // unique local fc00::/7
  if (first >= 0xfe80 && first <= 0xfebf) return false // link-local fe80::/10
  if (first >= 0xff00) return false // multicast ff00::/8
  return true
}

/** Pure range check over a textual IP address (v4 or v6). */
export function isPublicAddress(address: string): boolean {
  if (address.includes(':')) return isPublicIpv6(address)
  return isPublicIpv4(address)
}

/**
 * Validates a capture target BEFORE any browser is launched: http/https only,
 * no embedded credentials, and every DNS-resolved address must be public.
 * Throws loud on violation — callers never fall back.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http/https URLs can be captured, got ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials cannot be captured')
  }
  if (!url.hostname) {
    throw new Error(`URL has no hostname: ${rawUrl}`)
  }
  const addresses = await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0) {
    throw new Error(`hostname resolved to no addresses: ${url.hostname}`)
  }
  for (const entry of addresses) {
    if (!isPublicAddress(entry.address)) {
      throw new Error(
        `refusing to capture ${url.hostname}: resolves to non-public address ${entry.address} (SSRF guard)`,
      )
    }
  }
  return url
}
