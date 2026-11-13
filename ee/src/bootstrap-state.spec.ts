import { describe, expect, it } from 'vitest'
import { aptInstallArgs, bootstrapRouting, caddyUnitAction, resolveNodeIp, withLivekit } from './bootstrap.ts'
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

describe('withLivekit: what a (re-)run seeds for calls', () => {
  const os = workloadSchema.parse({ name: 'os', tier: 'system', source: { kind: 'release', tarball: '/r/os.tgz', sha256: 'a'.repeat(64) } })
  const settings = { consoleHost: 'os.example.com', publicHost: null, acmeEmail: null, callsHost: null, rtcNodeIp: null, contributeHub: 'off' }
  const lk = livekitWorkload('/var/lib/ee/releases/livekit-server-1.13.11-linux-x64.tar.gz', 'b'.repeat(64))

  it('adds the livekit workload, saves the node IP and routes the calls host', () => {
    const s = withLivekit({ workloads: [os], routes: [{ host: 'os.example.com', workload: 'os' }], settings }, lk, '203.0.113.7')
    expect(s.workloads.map((w) => w.name)).toEqual(['os', 'livekit'])
    expect(s.settings).toMatchObject({ rtcNodeIp: '203.0.113.7', callsHost: 'rtc.os.example.com' })
    expect(s.routes).toContainEqual({ host: 'rtc.os.example.com', workload: 'livekit' })
  })

  it('a re-run replaces the livekit release in place (one workload, one calls route)', () => {
    const once = withLivekit({ workloads: [os], routes: [{ host: 'os.example.com', workload: 'os' }], settings }, lk, '203.0.113.7')
    const next = livekitWorkload('/var/lib/ee/releases/livekit-server-1.13.12-linux-x64.tar.gz', 'c'.repeat(64))
    const twice = withLivekit(once, next, '203.0.113.7')
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
