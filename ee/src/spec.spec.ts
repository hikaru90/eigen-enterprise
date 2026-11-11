import { describe, expect, it } from 'vitest'
import {
  appContractSchema,
  assertInCatalog,
  CATALOG,
  CatalogGapError,
  hostPortCollisions,
  routesSchema,
  workloadSchema,
} from './spec.ts'

const release = { kind: 'release', tarball: '/var/lib/ee/releases/os-0.3.0.tar.gz', sha256: 'a'.repeat(64) }

describe('workload schema', () => {
  it('accepts a minimal workload and fills defaults', () => {
    const w = workloadSchema.parse({ name: 'os', tier: 'system', source: release })
    expect(w.resources).toEqual({ memoryMb: 512, cpuPercent: 100 })
    expect(w.secrets).toEqual([])
    expect(w.deploy.auto).toBe(false)
  })

  it.each([
    ['privileged', { privileged: true }],
    ['user', { user: 'root' }],
    ['host mounts', { volumes: [{ host: '/', mount: '/host' }] }],
    ['ports', { ports: [80] }],
    ['capabilities on the workload', { capabilities: ['CAP_SYS_ADMIN'] }],
    ['network mode', { network: 'host' }],
  ])('rejects any way to weaken the sandbox: %s', (_label, extra) => {
    expect(() => workloadSchema.parse({ name: 'x1', tier: 'app', source: release, ...extra })).toThrow()
  })

  it('rejects reserved env keys', () => {
    expect(() =>
      workloadSchema.parse({ name: 'x1', tier: 'app', source: release, env: { PORT: '80' } }),
    ).toThrow(/reserved/)
    // ee injects the platform API address itself; an app may not point it elsewhere.
    expect(() =>
      workloadSchema.parse({
        name: 'x1',
        tier: 'app',
        source: release,
        env: { EE_API_URL: 'http://evil' },
      }),
    ).toThrow(/reserved/)
  })

  it('rejects a git source outside the local mirrors', () => {
    expect(() =>
      workloadSchema.parse({
        name: 'x1',
        tier: 'app',
        source: { kind: 'git', mirror: '../../etc/passwd', ref: 'main', rev: 'b'.repeat(40) },
      }),
    ).toThrow()
  })

  it('requires a pinned 40-char rev for git sources', () => {
    expect(() =>
      workloadSchema.parse({
        name: 'x1',
        tier: 'app',
        source: { kind: 'git', mirror: 'sources/app.git', ref: 'main', rev: 'main' },
      }),
    ).toThrow()
  })
})

describe('app contract (ee.json)', () => {
  it('node requires start and a version', () => {
    expect(() => appContractSchema.parse({ runtime: 'node' })).toThrow(/start/)
  })

  it('rejects environments an app could bring itself', () => {
    expect(() =>
      appContractSchema.parse({ runtime: 'node', node: '22', start: ['node', 'x.js'], dockerfile: 'Dockerfile' }),
    ).toThrow()
  })
})

describe('catalog (D16: a gap is an eigen change)', () => {
  it('passes what the catalog has', () => {
    const c = appContractSchema.parse({
      runtime: 'node',
      node: '22',
      start: ['node', 'build/index.js'],
      services: ['postgres'],
    })
    expect(() => assertInCatalog(c, 'app')).not.toThrow()
  })

  it('names every missing entry', () => {
    const c = appContractSchema.parse({
      runtime: 'node',
      node: '18',
      start: ['node', 'x.js'],
      services: ['redis'],
      capabilities: ['chromium'],
    })
    try {
      assertInCatalog(c, 'app')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogGapError)
      expect((err as CatalogGapError).missing).toEqual(['runtime node@18', 'service redis', 'capability chromium'])
    }
  })
})

describe('routes', () => {
  it('rejects duplicate hosts', () => {
    expect(() =>
      routesSchema.parse([
        { host: 'a.example.com', workload: 'os' },
        { host: 'a.example.com', workload: 'app' },
      ]),
    ).toThrow(/duplicate/)
  })

  it('rejects malformed hostnames', () => {
    expect(() => routesSchema.parse([{ host: 'http://x', workload: 'os' }])).toThrow()
  })
})

describe('host ports (system workloads only, from an allow-list)', () => {
  const sys = (ports: unknown) => ({ name: 'livekit', tier: 'system', source: release, ports })

  it('a system workload may open the allow-listed media ports', () => {
    const w = workloadSchema.parse(sys([{ port: 7881, proto: 'tcp' }, { port: 7882, proto: 'udp' }]))
    expect(w.ports).toEqual([{ port: 7881, proto: 'tcp' }, { port: 7882, proto: 'udp' }])
  })

  it('a workload without ports serializes without the field (existing workloads keep their fingerprint)', () => {
    expect('ports' in workloadSchema.parse({ name: 'os', tier: 'system', source: release })).toBe(false)
  })

  it.each(['app', 'module'])('a %s workload may not open a host port', (tier) => {
    expect(() => workloadSchema.parse({ ...sys([{ port: 7882, proto: 'udp' }]), tier })).toThrow(/system/)
  })

  it.each([
    [{ port: 22, proto: 'tcp' }],
    [{ port: 7881, proto: 'udp' }],
    [{ port: 7882, proto: 'tcp' }],
    [{ port: 5432, proto: 'tcp' }],
  ])('rejects a port outside the allow-list: %o', (p) => {
    expect(() => workloadSchema.parse(sys([p]))).toThrow(/allow-list/)
  })

  it('rejects the same port twice in one workload', () => {
    expect(() => workloadSchema.parse(sys([{ port: 7882, proto: 'udp' }, { port: 7882, proto: 'udp' }]))).toThrow(/twice/)
  })

  it('rejects unknown keys on a port (no host binding, no range)', () => {
    expect(() => workloadSchema.parse(sys([{ port: 7882, proto: 'udp', host: '0.0.0.0' }]))).toThrow()
  })

  it('rejects two workloads holding the same host port', () => {
    const a = workloadSchema.parse(sys([{ port: 7882, proto: 'udp' }]))
    const b = workloadSchema.parse({ ...sys([{ port: 7882, proto: 'udp' }]), name: 'livekit-two' })
    expect(hostPortCollisions([a])).toEqual([])
    expect(hostPortCollisions([a, b])).toEqual(['udp/7882 is held by both livekit and livekit-two'])
  })
})

describe('binary runtime (a static executable shipped in the release)', () => {
  const binary = { runtime: 'binary', start: ['./livekit-server'], health: '/' }

  it('runs a start argv relative to the release', () => {
    expect(appContractSchema.parse(binary).start).toEqual(['./livekit-server'])
  })

  it('requires start', () => {
    expect(() => appContractSchema.parse({ runtime: 'binary' })).toThrow(/start/)
  })

  it.each([
    ['an absolute program', { start: ['/usr/bin/sh'] }],
    ['a program found on PATH', { start: ['sh'] }],
    ['a program outside the release', { start: ['./../../bin/sh'] }],
    ['build steps', { build: [['./configure']] }],
    ['a node version', { node: '22' }],
    ['pre-start steps', { preStart: [['./migrate']] }],
    ['a static dir', { staticDir: 'public' }],
  ])('rejects %s', (_label, extra) => {
    expect(() => appContractSchema.parse({ ...binary, ...extra })).toThrow()
  })

  it('is a system-only runtime: an app or module asking for it is a catalog gap', () => {
    const c = appContractSchema.parse(binary)
    expect(() => assertInCatalog(c, 'system')).not.toThrow()
    for (const tier of ['app', 'module'] as const) {
      try {
        assertInCatalog(c, tier)
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(CatalogGapError)
        expect((err as CatalogGapError).missing).toEqual(['runtime binary (system workloads only)'])
      }
    }
  })

  it('the catalog lists binary as a system runtime, never as an app runtime', () => {
    expect(Object.keys(CATALOG.runtimes)).toEqual(['node', 'static'])
    expect(CATALOG.systemRuntimes).toEqual(['binary'])
  })
})
