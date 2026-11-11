import { describe, expect, it } from 'vitest'
import { addDomain, callsHostFor, removeDomain, setConsoleHost, withCallsHost } from './domains.ts'
import { livekitWorkload } from './livekit.ts'
import { workloadSchema } from './spec.ts'

const source = { kind: 'release', tarball: '/var/lib/ee/releases/x.tar.gz', sha256: 'a'.repeat(64) } as const
const os = workloadSchema.parse({ name: 'os', tier: 'system', source, env: { ORIGIN: 'https://os.example.com' } })
const lk = workloadSchema.parse(livekitWorkload('/var/lib/ee/releases/lk.tar.gz', 'b'.repeat(64)))
const site = workloadSchema.parse({ name: 'site', tier: 'app', source })
const settings = { consoleHost: 'os.example.com', publicHost: null, acmeEmail: null, callsHost: null, rtcNodeIp: '203.0.113.7' }

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
