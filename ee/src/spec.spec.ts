import { describe, expect, it } from 'vitest'
import {
  appContractSchema,
  assertInCatalog,
  CatalogGapError,
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
    expect(() => assertInCatalog(c)).not.toThrow()
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
      assertInCatalog(c)
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
