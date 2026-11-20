import type { System } from './system.ts'
import { mustRun } from './system.ts'
import { PATHS } from './paths.ts'

/**
 * The network a Drive app preview runs in (plan/phase-drive-app-preview.md,
 * isolation follow-up 2026-11-20): its own network namespace, joined to the
 * box by one veth pair. Outbound it reaches the internet (npm registry, the
 * APIs a dev server calls) through NAT; it can't reach the box itself
 * (loopback services, Caddy's internal listeners, any of the box's
 * addresses) or private ranges (LAN, cloud metadata), except the DNS
 * servers. Caddy reaches the dev server through a small forwarder inside the
 * namespace on NS_ADDR:FORWARD_PORT.
 *
 * Why not IPAddressDeny=localhost on the unit: systemd's IP filter applies
 * to both directions, so it also drops Caddy's proxied connections in.
 */
export const PREVIEW_NETNS = 'ee-preview'
export const NETNS_PATH = `/run/netns/${PREVIEW_NETNS}`
export const HOST_IF = 'ee-pv0'
export const NS_IF = 'ee-pv1'
export const HOST_ADDR = '10.237.0.1'
export const NS_ADDR = '10.237.0.2'
export const NET_CIDR = '10.237.0.0/30'
/** Where the in-namespace forwarder listens; Caddy dials NS_ADDR:FORWARD_PORT. */
export const FORWARD_PORT = 8080
export const NFT_TABLE = 'ee_preview'
export const PREVIEW_RESOLV = `${PATHS.root}/preview-net/resolv.conf`
export const PREVIEW_NFT = `${PATHS.root}/preview-net/ruleset.nft`

/** Address ranges a preview never reaches (besides the box itself), except its DNS servers. */
const PRIVATE_V4 = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '127.0.0.0/8']

export type PreviewNet = {
  /** The resolv.conf the preview units see, and the path it is mounted over (resolv.conf's real file). */
  resolvConf: string
  resolvTarget: string
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** IPv4 `nameserver` lines of a resolv.conf, loopback ones left out (a stub resolver on the host is unreachable from the namespace). */
export function parseResolvers(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*nameserver\s+(\S+)/.exec(line)
    const addr = m?.[1]
    if (!addr || !IPV4.test(addr) || addr.startsWith('127.')) continue
    if (!out.includes(addr)) out.push(addr)
  }
  return out
}

/**
 * The nftables table, replaced atomically on every apply (the leading
 * add+delete is the idempotent-replace idiom). ee boxes run no Docker and no
 * other router, so forwarding is closed for everything but the preview link.
 */
export function nftRuleset(resolvers: readonly string[]): string {
  if (resolvers.length === 0) throw new Error('nftRuleset: at least one DNS server is required')
  const dns = `{ ${resolvers.join(', ')} }`
  return [
    `table inet ${NFT_TABLE} {}`,
    `delete table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    '  chain input {',
    '    type filter hook input priority -10; policy accept;',
    `    iifname "${HOST_IF}" ct state established,related accept`,
    `    iifname "${HOST_IF}" drop`,
    '  }',
    '  chain forward {',
    '    type filter hook forward priority -10; policy drop;',
    `    iifname "${HOST_IF}" ip daddr ${dns} meta l4proto { udp, tcp } th dport 53 accept`,
    `    iifname "${HOST_IF}" ip daddr { ${PRIVATE_V4.join(', ')} } drop`,
    `    iifname "${HOST_IF}" meta nfproto ipv4 accept`,
    `    oifname "${HOST_IF}" ct state established,related accept`,
    '  }',
    '  chain postrouting {',
    '    type nat hook postrouting priority 100;',
    `    ip saddr ${NET_CIDR} oifname != "${HOST_IF}" masquerade`,
    '  }',
    '}',
    '',
  ].join('\n')
}

/** The DNS servers the box itself uses upstream: resolv.conf, else systemd-resolved's upstream list. */
async function upstreamResolvers(sys: System): Promise<string[]> {
  const direct = parseResolvers((await sys.readFile('/etc/resolv.conf')) ?? '')
  if (direct.length > 0) return direct
  const resolved = parseResolvers((await sys.readFile('/run/systemd/resolve/resolv.conf')) ?? '')
  if (resolved.length > 0) return resolved
  throw new Error('no DNS server for previews: /etc/resolv.conf and /run/systemd/resolve/resolv.conf list no non-loopback IPv4 nameserver')
}

/**
 * Set up (or repair) the preview network. Idempotent: the namespace and the
 * veth pair are created when missing, addresses and routes are (re)applied,
 * the nftables table is replaced. Fails loud: a preview never runs on the
 * host network.
 */
export async function ensurePreviewNet(sys: System): Promise<PreviewNet> {
  const resolvers = await upstreamResolvers(sys)
  const namespaces = await mustRun(sys, 'ip', ['netns', 'list'])
  if (!namespaces.split('\n').some((l) => l.trim().split(/\s+/)[0] === PREVIEW_NETNS)) {
    await mustRun(sys, 'ip', ['netns', 'add', PREVIEW_NETNS])
  }
  const link = await sys.run('ip', ['link', 'show', HOST_IF])
  if (link.code !== 0) {
    await mustRun(sys, 'ip', ['link', 'add', HOST_IF, 'type', 'veth', 'peer', 'name', NS_IF])
    await mustRun(sys, 'ip', ['link', 'set', NS_IF, 'netns', PREVIEW_NETNS])
  }
  await mustRun(sys, 'ip', ['addr', 'replace', `${HOST_ADDR}/30`, 'dev', HOST_IF])
  await mustRun(sys, 'ip', ['link', 'set', HOST_IF, 'up'])
  await mustRun(sys, 'ip', ['-n', PREVIEW_NETNS, 'addr', 'replace', `${NS_ADDR}/30`, 'dev', NS_IF])
  await mustRun(sys, 'ip', ['-n', PREVIEW_NETNS, 'link', 'set', NS_IF, 'up'])
  await mustRun(sys, 'ip', ['-n', PREVIEW_NETNS, 'link', 'set', 'lo', 'up'])
  await mustRun(sys, 'ip', ['-n', PREVIEW_NETNS, 'route', 'replace', 'default', 'via', HOST_ADDR])
  await mustRun(sys, 'sysctl', ['-qw', 'net.ipv4.ip_forward=1'])
  await sys.mkdirp(`${PATHS.root}/preview-net`, 0o755)
  // A file, not stdin: nft refuses a pipe ("Not a regular file: /dev/stdin").
  await sys.writeFile(PREVIEW_NFT, nftRuleset(resolvers), 0o600)
  await mustRun(sys, 'nft', ['-f', PREVIEW_NFT])
  await sys.writeFile(PREVIEW_RESOLV, resolvers.map((r) => `nameserver ${r}`).join('\n') + '\n', 0o644)
  // /etc/resolv.conf may be a symlink (systemd-resolved's stub): mount over the file it points at.
  const resolvTarget = (await mustRun(sys, 'readlink', ['-f', '/etc/resolv.conf'])).trim()
  if (!resolvTarget.startsWith('/')) throw new Error(`readlink -f /etc/resolv.conf gave "${resolvTarget}"`)
  return { resolvConf: PREVIEW_RESOLV, resolvTarget }
}

/**
 * The in-namespace forwarder: NS_ADDR:FORWARD_PORT → the dev server's own
 * listener (often only 127.0.0.1 or [::1] inside the namespace). Plain TCP
 * piping, so HTTP and websockets (hot reload) both pass.
 */
export function forwarderScript(target: { host: string; port: number }): string {
  const host = target.host.replace(/^\[|\]$/g, '')
  return [
    "const net = require('node:net')",
    `const server = net.createServer((c) => { const u = net.connect(${target.port}, ${JSON.stringify(host)}); c.pipe(u); u.pipe(c); const end = () => { c.destroy(); u.destroy() }; c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end) })`,
    `server.listen(${FORWARD_PORT}, ${JSON.stringify(NS_ADDR)})`,
  ].join('; ')
}
