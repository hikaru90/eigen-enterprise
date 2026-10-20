import { describe, expect, it } from 'vitest'
import { renderCaddyConfig } from './caddy.ts'
import { appContractSchema, workloadSchema } from './spec.ts'
import { HARDENING, renderUnit } from './units.ts'

const workload = workloadSchema.parse({
  name: 'os',
  tier: 'system',
  source: { kind: 'release', tarball: '/var/lib/ee/releases/os.tar.gz', sha256: 'a'.repeat(64) },
  env: { AGE_GRAPH_NAME: 'eigen_graph', WEIRD: 'has "quotes" and %percent' },
})
const contract = appContractSchema.parse({
  runtime: 'node',
  node: '22',
  start: ['node', 'build/index.js'],
  preStart: [['node', 'scripts/migrate.mjs']],
  services: ['postgres'],
})

describe('renderUnit', () => {
  const unit = renderUnit({ workload, contract, slot: 'a', port: 4100, releaseDir: '/var/lib/ee/workloads/os/releases/r1' })

  it('always carries the full hardening block', () => {
    for (const line of HARDENING) expect(unit).toContain(line)
  })

  it('resolves "node" to the pinned runtime, never the host binary', () => {
    expect(unit).toContain('ExecStart=/opt/ee/runtimes/node-22/bin/node build/index.js')
    expect(unit).toContain('ExecStartPre=/opt/ee/runtimes/node-22/bin/node scripts/migrate.mjs')
  })

  it('both slots of a workload run as the same (dynamic) user, so they share its state', () => {
    const b = renderUnit({ workload, contract, slot: 'b', port: 4101, releaseDir: '/r' })
    expect(unit).toContain('User=ee-os')
    expect(b).toContain('User=ee-os')
    expect(unit).toContain('DynamicUser=yes')
  })

  it('binds only its own port and owns the reserved env', () => {
    expect(unit).toContain('SocketBindAllow=tcp:4100')
    expect(unit).toContain('SocketBindDeny=any')
    expect(unit).toContain('Environment="PORT=4100"')
    expect(unit).toContain('Environment="HOST=127.0.0.1"')
  })

  it('escapes env values for systemd', () => {
    expect(unit).toContain('Environment="WEIRD=has \\"quotes\\" and %%percent"')
  })

  it('depends on postgres only when the contract declares it', () => {
    expect(unit).toContain('Requires=postgresql.service')
    const noPg = renderUnit({
      workload,
      contract: { ...contract, services: [] },
      slot: 'b',
      port: 4101,
      releaseDir: '/r',
    })
    expect(noPg).not.toContain('postgresql.service')
  })

  it('grants the control socket only when the template passes the group', () => {
    expect(unit).not.toContain('SupplementaryGroups')
    const os = renderUnit({
      workload,
      contract,
      slot: 'a',
      port: 4100,
      releaseDir: '/r',
      supplementaryGroups: ['ee-control'],
    })
    expect(os).toContain('SupplementaryGroups=ee-control')
  })

  it('refuses relative program paths that could resolve via PATH', () => {
    expect(() =>
      renderUnit({ workload, contract: { ...contract, start: ['sh', '-c', 'x'] }, slot: 'a', port: 1, releaseDir: '/r' }),
    ).toThrow(/argv\[0\]/)
  })
})

describe('renderCaddyConfig', () => {
  it('routes hosts to live upstreams with a public-surface allowlist', () => {
    const cfg = renderCaddyConfig({
      routes: [
        { host: 'kindred.digital', workload: 'os', allowPaths: ['/s/*', '/_app/*'], rootRewrite: '/s/home' },
        { host: 'os.kindred.digital', workload: 'os' },
      ],
      upstreams: { os: { kind: 'proxy', port: 4100 } },
      acmeEmail: null,
    })
    const json = JSON.stringify(cfg)
    expect(json).toContain('"dial":"127.0.0.1:4100"')
    expect(json).toContain('"status_code":404')
    expect(json).toContain('"uri":"/s/home"')
    expect(json).toContain('unix//run/caddy/admin.sock')
  })

  it('uses ACME for public hosts and the local CA only for reserved test TLDs', () => {
    const cfg = renderCaddyConfig({
      routes: [
        { host: 'kindred.digital', workload: 'os' },
        { host: 'os.ee.test', workload: 'os' },
      ],
      upstreams: { os: { kind: 'proxy', port: 4100 } },
      acmeEmail: 'ops@kindred.digital',
    }) as { apps: { tls: { automation: { policies: unknown[] } } } }
    expect(cfg.apps.tls.automation.policies).toEqual([
      { subjects: ['kindred.digital'], issuers: [{ module: 'acme', email: 'ops@kindred.digital' }] },
      { subjects: ['os.ee.test'], issuers: [{ module: 'internal' }] },
    ])
  })

  it('fails loudly when a route points at a workload with no live upstream', () => {
    expect(() =>
      renderCaddyConfig({ routes: [{ host: 'a.example.com', workload: 'ghost' }], upstreams: {}, acmeEmail: null }),
    ).toThrow(/no live upstream/)
  })
})

describe('renderUnit portEnv', () => {
  it('sets the app-specific port variable next to PORT', () => {
    const c = appContractSchema.parse({ runtime: 'node', node: '22', start: ['node', 'index.js'], portEnv: 'APP_PORT' })
    const u = renderUnit({ workload, contract: c, slot: 'a', port: 4102, releaseDir: '/r' })
    expect(u).toContain('Environment="APP_PORT=4102"')
    expect(u).toContain('Environment="PORT=4102"')
  })
  it('a contract may not point portEnv at a reserved key', () => {
    expect(() => appContractSchema.parse({ runtime: 'node', node: '22', start: ['node', 'i.js'], portEnv: 'HOST' })).toThrow()
  })
})
