import { describe, expect, it } from 'vitest'
import { addDomain, callsHostFor, removeDomain, setConsoleHost, setDomain, withCallsHost } from './domains.ts'
import { livekitWorkload } from './livekit.ts'
import { workloadSchema } from './spec.ts'

const source = { kind: 'release', tarball: '/var/lib/ee/releases/x.tar.gz', sha256: 'a'.repeat(64) } as const
const os = workloadSchema.parse({ name: 'os', tier: 'system', source, env: { ORIGIN: 'https://os.example.com' } })
const lk = workloadSchema.parse(livekitWorkload('/var/lib/ee/releases/lk.tar.gz', 'b'.repeat(64), { tcp: 7881, udp: 7882 }))
const site = workloadSchema.parse({ name: 'site', tier: 'app', source })
const settings = { consoleHost: 'os.example.com', publicHost: null, acmeEmail: null, callsHost: null, rtcNodeIp: '203.0.113.7', contributeHub: 'off', rtcPorts: { tcp: 7881, udp: 7882 }, trustedProxy: null, managed: null, suspended: false, releaseSource: null }

const base = (workloads = [os, lk, site]) =>
  withCallsHost({ workloads, routes: [{ host: 'os.example.com', workload: 'os' }], settings })

describe('the calls host (rtc.<console host> → livekit)', () => {
  it('is derived from the console host', () => {
    expect(callsHostFor('os.example.com')).toBe('rtc.os.example.com')
    expect(callsHostFor('os.ee.localhost')).toBe('rtc.os.ee.localhost')
  })

  it('withCallsHost routes it to the livekit workload and records it in settings', () => {
    const s = base()
    expect(s.routes).toEqual([
      { host: 'os.example.com', workload: 'os' },
      { host: 'rtc.os.example.com', workload: 'livekit' },
    ])
    expect(s.settings.callsHost).toBe('rtc.os.example.com')
  })

  it('is idempotent', () => {
    expect(withCallsHost(base())).toEqual(base())
  })

  it('without a livekit workload there is no calls host', () => {
    const s = base([os, site])
    expect(s.routes).toEqual([{ host: 'os.example.com', workload: 'os' }])
    expect(s.settings.callsHost).toBeNull()
  })

  it('follows the console host when it moves (old calls route gone)', () => {
    const s = setConsoleHost(base(), 'console.example.org')
    expect(s.settings.callsHost).toBe('rtc.console.example.org')
    expect(s.routes.filter((r) => r.workload === 'livekit')).toEqual([{ host: 'rtc.console.example.org', workload: 'livekit' }])
  })

  it('refuses to take a host another workload already has', () => {
    const s = base()
    const clash = { ...s, routes: [...s.routes, { host: 'rtc.console.example.org', workload: 'site' }] }
    expect(() => setConsoleHost(clash, 'console.example.org')).toThrow(/rtc\.console\.example\.org .*site/)
  })

  it('cannot be removed or given to another workload', () => {
    const s = base()
    expect(() => removeDomain(s, 'rtc.os.example.com')).toThrow(/calls host/)
    expect(() => addDomain(s, { host: 'rtc.os.example.com', workload: 'site', role: 'app' })).toThrow(/calls host/)
    expect(() => addDomain(s, { host: 'rtc.os.example.com', workload: 'os', role: 'public' })).toThrow(/calls host/)
  })

  it('livekit gets no app hosts (a system workload)', () => {
    expect(() => addDomain(base(), { host: 'meet.example.com', workload: 'livekit', role: 'app' })).toThrow(/system workload/)
  })
})

describe('setting what a host shows replaces its previous target and says which', () => {
  const shop = workloadSchema.parse({ name: 'shop', tier: 'app', source })
  const withSite = () => setDomain(base([os, lk, site, shop]), { host: 'www.example.com', workload: 'site', role: 'app' }).state

  it('a new host replaced nothing', () => {
    const r = setDomain(base(), { host: 'www.example.com', workload: 'site', role: 'app' })
    expect(r.replaced).toBeNull()
    expect(r.state.routes).toContainEqual({ host: 'www.example.com', workload: 'site' })
  })

  it('switching a host to another app names the app it showed before', () => {
    const r = setDomain(withSite(), { host: 'www.example.com', workload: 'shop', role: 'app' })
    expect(r.replaced).toBe('site')
    expect(r.state.routes.filter((x) => x.host === 'www.example.com')).toEqual([{ host: 'www.example.com', workload: 'shop' }])
  })

  it('making an app host the public website names the app', () => {
    expect(setDomain(withSite(), { host: 'www.example.com', workload: 'os', role: 'public' }).replaced).toBe('site')
  })

  it('making an app host the console host names the app', () => {
    expect(setDomain(withSite(), { host: 'www.example.com', workload: 'os', role: 'console' }).replaced).toBe('site')
  })

  it('setting the same target again replaced nothing', () => {
    expect(setDomain(withSite(), { host: 'www.example.com', workload: 'site', role: 'app' }).replaced).toBeNull()
  })

  it('addDomain is the state half of setDomain', () => {
    const i = { host: 'www.example.com', workload: 'shop', role: 'app' } as const
    expect(addDomain(withSite(), i)).toEqual(setDomain(withSite(), i).state)
  })
})
