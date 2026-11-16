import { describe, expect, it } from 'vitest'
import {
  aptInstallArgs,
  assertClaimHashAllowed,
  bootstrapRouting,
  caddyUnitAction,
  parseRtcPortsFlag,
  parseTrustedProxyFlag,
  resolveNodeIp,
  resolveRtcPorts,
  resolveTrustedProxy,
  withLivekit,
} from './bootstrap.ts'
import { claimFromHash } from './claim.ts'
import { livekitWorkload } from './livekit.ts'
import { workloadSchema } from './spec.ts'

describe('the node IP LiveKit advertises (explicit, never guessed)', () => {
  it('an explicit --node-ip wins and is saved', () => {
    expect(resolveNodeIp('203.0.113.7', null)).toBe('203.0.113.7')
    expect(resolveNodeIp('198.51.100.2', '203.0.113.7')).toBe('198.51.100.2')
  })
  it('a re-run (upgrade) keeps the saved one', () => {
    expect(resolveNodeIp(undefined, '203.0.113.7')).toBe('203.0.113.7')
  })
  it('neither given nor saved: the install stops before it changes anything, saying what to pass', () => {
    expect(() => resolveNodeIp(undefined, null)).toThrow(/--node-ip <public IP of this server>/)
  })
  it('refuses something that is not an IP address', () => {
    expect(() => resolveNodeIp('my-server', null)).toThrow(/not an IP address/)
  })
})

describe('hosted install flags (self-hosted passes none)', () => {
  it('--rtc-ports: default 7881/7882 on a first install, kept on re-runs, an explicit flag changes it', () => {
    expect(resolveRtcPorts(undefined, null)).toEqual({ tcp: 7881, udp: 7882 })
    expect(resolveRtcPorts(undefined, { tcp: 21000, udp: 21001 })).toEqual({ tcp: 21000, udp: 21001 })
    expect(resolveRtcPorts({ tcp: 22000, udp: 22001 }, { tcp: 21000, udp: 21001 })).toEqual({ tcp: 22000, udp: 22001 })
  })
  it('--rtc-ports parses <tcp>,<udp> and refuses anything else in plain words', () => {
    expect(parseRtcPortsFlag('21000,21001')).toEqual({ tcp: 21000, udp: 21001 })
    expect(parseRtcPortsFlag('7881,7882')).toEqual({ tcp: 7881, udp: 7882 })
    for (const bad of ['21000', '21000,21000', '7881,21000', '80,443', '21000;21001', 'a,b', '30000,30001']) {
      expect(() => parseRtcPortsFlag(bad)).toThrow(/--rtc-ports/)
    }
  })
  it('--trusted-proxy: an IPv4 CIDR, none by default, kept on re-runs, an explicit flag changes it', () => {
    expect(parseTrustedProxyFlag('10.0.0.1/32')).toBe('10.0.0.1/32')
    for (const bad of ['10.0.0.1', '10.0.0.1/33', '::1/128', 'router']) expect(() => parseTrustedProxyFlag(bad)).toThrow(/IPv4 CIDR/)
    expect(resolveTrustedProxy(undefined, null)).toBeNull()
    expect(resolveTrustedProxy(undefined, '10.0.0.1/32')).toBe('10.0.0.1/32')
    expect(resolveTrustedProxy('10.0.0.2/32', '10.0.0.1/32')).toBe('10.0.0.2/32')
  })
  it('--claim-hash: first install only; a re-run with it stops before anything changes', () => {
    expect(() => assertClaimHashAllowed('a'.repeat(64), false)).not.toThrow()
    expect(() => assertClaimHashAllowed(undefined, true)).not.toThrow()
    expect(() => assertClaimHashAllowed('a'.repeat(64), true)).toThrow(/first install/)
  })
  it('--claim-hash seeds the hash with the usual expiry, never a token', () => {
    const now = new Date('2026-11-16T00:00:00Z')
    expect(claimFromHash('ab'.repeat(32), now)).toEqual({ hash: 'ab'.repeat(32), expiresAt: '2026-11-23T00:00:00.000Z' })
    expect(() => claimFromHash('AB'.repeat(32), now)).toThrow(/64 lowercase hex/)
    expect(() => claimFromHash('ab', now)).toThrow(/64 lowercase hex/)
  })
})

describe('withLivekit: what a (re-)run seeds for calls', () => {
  const os = workloadSchema.parse({ name: 'os', tier: 'system', source: { kind: 'release', tarball: '/r/os.tgz', sha256: 'a'.repeat(64) } })
  const settings = { consoleHost: 'os.example.com', publicHost: null, acmeEmail: null, callsHost: null, rtcNodeIp: null, contributeHub: 'off', rtcPorts: { tcp: 7881, udp: 7882 }, trustedProxy: null, managed: null, suspended: false }
  const lk = livekitWorkload('/var/lib/ee/releases/livekit-server-1.13.11-linux-x64.tar.gz', 'b'.repeat(64), { tcp: 7881, udp: 7882 })

  it('adds the livekit workload, saves the node IP and routes the calls host', () => {
    const s = withLivekit({ workloads: [os], routes: [{ host: 'os.example.com', workload: 'os' }], settings }, lk, '203.0.113.7', { tcp: 7881, udp: 7882 })
    expect(s.workloads.map((w) => w.name)).toEqual(['os', 'livekit'])
    expect(s.settings).toMatchObject({ rtcNodeIp: '203.0.113.7', callsHost: 'rtc.os.example.com' })
    expect(s.routes).toContainEqual({ host: 'rtc.os.example.com', workload: 'livekit' })
  })

  it('a re-run replaces the livekit release in place (one workload, one calls route)', () => {
    const once = withLivekit({ workloads: [os], routes: [{ host: 'os.example.com', workload: 'os' }], settings }, lk, '203.0.113.7', { tcp: 7881, udp: 7882 })
    const next = livekitWorkload('/var/lib/ee/releases/livekit-server-1.13.12-linux-x64.tar.gz', 'c'.repeat(64), { tcp: 7881, udp: 7882 })
    const twice = withLivekit(once, next, '203.0.113.7', { tcp: 7881, udp: 7882 })
    expect(twice.workloads.filter((w) => w.name === 'livekit')).toHaveLength(1)
    expect(twice.workloads.find((w) => w.name === 'livekit')?.source).toMatchObject({ sha256: 'c'.repeat(64) })
    expect(twice.routes.filter((r) => r.workload === 'livekit')).toHaveLength(1)
  })
})

const sslip = '152-53-118-209.sslip.io'
const prior = {
  routes: [{ host: sslip, workload: 'os' }, { host: 'cerberusblue.com', workload: 'site' }],
  settings: { consoleHost: sslip, publicHost: null, acmeEmail: null },
  origin: `https://${sslip}`,
}

describe('bootstrapRouting: what a (re-)run saves for the console', () => {
  it('a plain re-run keeps the console host, routes, ORIGIN and acme email', () => {
    expect(bootstrapRouting(prior, { consoleHost: sslip })).toEqual({ routes: prior.routes, settings: prior.settings, origin: prior.origin })
  })

  it('an explicit --console-host on a re-run moves the console there (route, settings, ORIGIN); the old host keeps working', () => {
    const r = bootstrapRouting(prior, { consoleHost: 'os.cerberusblue.com', explicitHost: true, acmeEmail: 'a@cerberusblue.com' })
    expect(r.settings).toEqual({ consoleHost: 'os.cerberusblue.com', publicHost: null, acmeEmail: 'a@cerberusblue.com' })
    expect(r.origin).toBe('https://os.cerberusblue.com')
    expect(r.routes).toEqual([...prior.routes, { host: 'os.cerberusblue.com', workload: 'os' }])
  })

  it('an explicit --acme-email alone is applied', () => {
    expect(bootstrapRouting(prior, { consoleHost: sslip, acmeEmail: 'a@b.co' }).settings.acmeEmail).toBe('a@b.co')
  })

  it('first run: the console host, its route and ORIGIN', () => {
    expect(bootstrapRouting(null, { consoleHost: sslip })).toEqual({
      routes: [{ host: sslip, workload: 'os' }],
      settings: { consoleHost: sslip, publicHost: null, acmeEmail: null },
      origin: `https://${sslip}`,
    })
  })
})

describe('re-runs keep the sites up (upgrade = re-run)', () => {
  it('Caddy restarts only when its unit changed; otherwise it is just kept running (no dropped requests)', () => {
    expect(caddyUnitAction(null, 'unit v1')).toBe('restart')
    expect(caddyUnitAction('unit v1', 'unit v2')).toBe('restart')
    expect(caddyUnitAction('unit v1', 'unit v1')).toBe('start')
  })

  it('installs missing packages but never upgrades installed ones (Postgres/Caddy would restart mid-upgrade)', () => {
    const args = aptInstallArgs(['postgresql-16', 'caddy'])
    expect(args).toContain('--no-upgrade')
    expect(args.slice(-2)).toEqual(['postgresql-16', 'caddy'])
  })
})
