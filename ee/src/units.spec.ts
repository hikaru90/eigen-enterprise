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

  it('points a workload at each capability it declares, and only those', () => {
    expect(unit).not.toContain('EE_CAP_')
    const withChromium = renderUnit({ workload, contract: { ...contract, capabilities: ['chromium'] }, slot: 'a', port: 4100, releaseDir: '/r' })
    expect(withChromium).toContain('Environment="EE_CAP_CHROMIUM=/opt/ee/capabilities/chromium/chrome-headless-shell"')
  })

  it('gives a chromium workload back only the syscalls the browser needs, after the deny list', () => {
    // Seen on the box 2026-11-23: chrome-headless-shell dies with SIGSYS under the hardening
    // without these (Landlock self-sandboxing, dropping capabilities, lowering its own priority).
    expect(unit).not.toContain('landlock_create_ruleset')
    const lines = renderUnit({ workload, contract: { ...contract, capabilities: ['chromium'] }, slot: 'a', port: 4100, releaseDir: '/r' }).split('\n')
    const deny = lines.indexOf('SystemCallFilter=~@privileged @resources')
    const allow = lines.indexOf('SystemCallFilter=landlock_create_ruleset capset setpriority')
    expect(deny).toBeGreaterThan(-1)
    expect(allow).toBeGreaterThan(deny)
    for (const line of HARDENING) expect(lines).toContain(line)
  })

  it('always carries the full hardening block', () => {
    for (const line of HARDENING) expect(unit).toContain(line)
  })

  it('resolves "node" to the pinned runtime, never the host binary', () => {
    expect(unit).toContain('ExecStart=/opt/ee/runtimes/node-22/bin/node build/index.js')
    expect(unit).toContain('ExecStartPre=/opt/ee/runtimes/node-22/bin/node scripts/migrate.mjs')
  })

  it('npm and npx start commands resolve to the pinned runtime, with that runtime on PATH (npm start finds node)', () => {
    const npmUnit = renderUnit({ workload, contract: { ...contract, start: ['npm', 'run', 'start'] }, slot: 'a', port: 4100, releaseDir: '/r' })
    expect(npmUnit).toContain('ExecStart=/opt/ee/runtimes/node-22/bin/npm run start')
    expect(npmUnit).toContain('Environment="PATH=/opt/ee/runtimes/node-22/bin:/usr/bin:/bin"')
    expect(npmUnit).toContain('Environment="npm_config_cache=/tmp/npm-cache"')
    // Apps that keep data under ~ (e.g. ~/.local/share/<app>) get their persistent state dir as HOME.
    expect(npmUnit).toContain(`Environment="HOME=/var/lib/ee-state/${workload.name}"`)
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
    // Every app knows where the platform API is; only a key decides what it may do there.
    expect(unit).toContain('Environment="EE_API_URL=http://127.0.0.1:4000"')
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
      trustedProxy: null,
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
      trustedProxy: null,
    }) as { apps: { tls: { automation: { policies: unknown[] } } } }
    expect(cfg.apps.tls.automation.policies).toEqual([
      { subjects: ['kindred.digital'], issuers: [{ module: 'acme', email: 'ops@kindred.digital' }] },
      { subjects: ['os.ee.test'], issuers: [{ module: 'internal' }] },
    ])
  })

  it('self-hosted (no trusted proxy): no listener wrappers anywhere', () => {
    const cfg = renderCaddyConfig({
      routes: [{ host: 'os.example.com', workload: 'os' }],
      upstreams: { os: { kind: 'proxy', port: 4100 } },
      acmeEmail: null,
      trustedProxy: null,
      internal: [{ port: 4000, workload: 'os' }],
    })
    expect(JSON.stringify(cfg)).not.toContain('listener_wrappers')
  })

  it('behind a router: the public server takes PROXY protocol from it only; loopback servers never', () => {
    const cfg = renderCaddyConfig({
      routes: [{ host: 'os.example.com', workload: 'os' }],
      upstreams: { os: { kind: 'proxy', port: 4100 } },
      acmeEmail: null,
      trustedProxy: '10.0.0.1/32',
      internal: [{ port: 4000, workload: 'os' }],
    }) as { apps: { http: { servers: Record<string, Record<string, unknown>> } } }
    const servers = cfg.apps.http.servers
    expect(servers.ee!.listen).toEqual([':443', ':80'])
    expect(servers.ee!.listener_wrappers).toEqual([
      { wrapper: 'proxy_protocol', allow: ['10.0.0.1/32'], timeout: '5s' },
      { wrapper: 'tls' },
    ])
    expect(servers['internal-os']!.listener_wrappers).toBeUndefined()
  })

  it('fails loudly when a route points at a workload with no live upstream', () => {
    expect(() =>
      renderCaddyConfig({ routes: [{ host: 'a.example.com', workload: 'ghost' }], upstreams: {}, acmeEmail: null, trustedProxy: null }),
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

describe('renderUnit: binary runtime with host ports (livekit-server)', () => {
  const livekit = workloadSchema.parse({
    name: 'livekit',
    tier: 'system',
    source: { kind: 'release', tarball: '/var/lib/ee/releases/livekit.tar.gz', sha256: 'b'.repeat(64) },
    ports: [
      { port: 7881, proto: 'tcp' },
      { port: 7882, proto: 'udp' },
    ],
  })
  const binary = appContractSchema.parse({ runtime: 'binary', start: ['./livekit-server'], health: '/' })
  const releaseDir = '/var/lib/ee/workloads/livekit/releases/r1'
  const unit = renderUnit({ workload: livekit, contract: binary, slot: 'a', port: 4102, releaseDir })

  it('execs the program from the release by absolute path, with no node runtime anywhere', () => {
    expect(unit).toContain(`ExecStart=${releaseDir}/livekit-server`)
    expect(unit).not.toContain('/opt/ee/runtimes')
    expect(unit).not.toContain('NODE_ENV')
    expect(unit).not.toContain('npm_config')
    expect(unit).toContain('Environment="PATH=/usr/bin:/bin"')
  })

  it('carries the same hardening, and may open only its own loopback port plus its declared host ports', () => {
    // The two host-port exceptions are pinned by their own tests below; every other line is verbatim.
    for (const line of HARDENING.filter((l) => !l.startsWith('RestrictAddressFamilies=') && !l.startsWith('ProcSubset='))) {
      expect(unit).toContain(line)
    }
    expect(unit).toContain('DynamicUser=yes')
    expect(unit).toContain('SocketBindAllow=tcp:4102')
    expect(unit).toContain('SocketBindAllow=tcp:7881')
    expect(unit).toContain('SocketBindAllow=udp:7882')
    expect(unit).toContain('SocketBindDeny=any')
    expect(unit).toContain(`ReadOnlyPaths=${releaseDir}`)
    expect(unit).toContain('EnvironmentFile=/run/ee/env/livekit-a.env')
  })

  it('a media server may also read the interface list (AF_NETLINK) to bind its host ports; nothing else is added', () => {
    expect(unit).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK')
    expect(unit.match(/^RestrictAddressFamilies=/gm)).toHaveLength(1)
    expect(unit).not.toMatch(/CapabilityBoundingSet=.+/)
    expect(unit).not.toMatch(/AmbientCapabilities=.+/)
  })

  it('a media server sees system-wide /proc counters (loadavg, stat — LiveKit node load), still not other processes', () => {
    // Found on the box (2026-11-11): under ProcSubset=pid, LiveKit logged "open /proc/loadavg" as an ERROR every 2 s.
    expect(unit).toContain('ProcSubset=all')
    expect(unit).not.toContain('ProcSubset=pid')
    expect(unit.match(/^ProcSubset=/gm)).toHaveLength(1)
    expect(unit).toContain('ProtectProc=invisible')
    expect(unit).toContain('ProtectKernelTunables=yes')
  })

  it('a workload without host ports keeps the plain address families and binds only its own port', () => {
    const plain = renderUnit({ workload: { ...livekit, ports: undefined }, contract: binary, slot: 'b', port: 4103, releaseDir })
    expect(plain).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n')
    expect(plain).toContain('ProcSubset=pid')
    expect(plain).not.toContain('ProcSubset=all')
    expect(plain).not.toContain('SocketBindAllow=udp')
    expect(plain.match(/^SocketBindAllow=/gm)).toEqual(['SocketBindAllow='])
  })

  it('refuses a binary contract on a non-system workload (defence in depth behind the catalog)', () => {
    expect(() =>
      renderUnit({ workload: { ...livekit, tier: 'app', ports: undefined }, contract: binary, slot: 'a', port: 4102, releaseDir }),
    ).toThrow(/system/)
  })
})
