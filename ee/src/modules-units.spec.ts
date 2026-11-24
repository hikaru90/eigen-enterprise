import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_SOCKET_DIR } from '../../contracts/module-protocol.ts'
import { MODULE_UNIT_ENV } from '../../contracts/module-workload.ts'
import { MODULE_BUNDLE_STORE, MODULE_BUNDLE_HANDOFF_DIR } from '../../contracts/module-workload.ts'
import { productionSources } from './backup/box.ts'
import { PATHS } from './paths.ts'
import { workloadSchema } from './spec.ts'
import { HARDENING, MODULE_UNIT_SOCKET_DIR, renderModuleUnit, renderUnit } from './units.ts'

const input = {
  id: 'hello',
  commit: 'c1'.repeat(20),
  start: ['node', 'index.mjs'],
  node: '22',
  resources: { memoryMb: 64, cpuPercent: 10 },
  releaseDir: '/var/lib/ee/workloads/mod-hello/releases/abc',
  socketDir: '/var/lib/ee-state/os/modules/hello/run',
  envFile: '/run/ee/env/mod-hello.env',
}
const lines = (u: string) => u.split('\n')

describe('renderModuleUnit: the hardened, network-less module unit (plan/phase-upgrades-u2.md §5)', () => {
  const unit = renderModuleUnit(input)

  it('runs as ee-mod-<id> with the full HARDENING block, unix sockets only', () => {
    expect(lines(unit)).toContain('User=ee-mod-hello')
    for (const h of HARDENING) {
      if (h.startsWith('RestrictAddressFamilies=')) continue
      expect(lines(unit)).toContain(h)
    }
    expect(lines(unit).filter((l) => l.startsWith('RestrictAddressFamilies='))).toEqual(['RestrictAddressFamilies=AF_UNIX'])
  })

  it('has no network at all: a private network namespace, no IP, no binds', () => {
    expect(lines(unit)).toEqual(expect.arrayContaining(['PrivateNetwork=yes', 'IPAddressDeny=any', 'SocketBindDeny=any']))
    expect(unit).not.toMatch(/SocketBindAllow/)
    expect(unit).not.toMatch(/AF_INET/)
  })

  it('has no state dir, sees its release read-only and the kernel socket dir at /run/ee-module, and nothing else of /var/lib or /run', () => {
    expect(unit).not.toMatch(/StateDirectory/)
    expect(lines(unit)).toContain('TemporaryFileSystem=/var/lib:ro /run:ro')
    expect(lines(unit)).toContain(`BindReadOnlyPaths=${input.releaseDir}`)
    expect(lines(unit)).toContain(`BindPaths=${input.socketDir}:/run/ee-module`)
    expect(MODULE_UNIT_SOCKET_DIR).toBe(MODULE_SOCKET_DIR)
    expect(lines(unit)).toContain('InaccessiblePaths=-/etc/ee -/etc/caddy -/var/lib/postgresql -/var/log')
    expect(unit).not.toMatch(/ReadWritePaths/)
  })

  it('gets exactly the module env, plus HOME=/tmp and its EnvironmentFile (token + declared secrets)', () => {
    const env = Object.fromEntries([...unit.matchAll(/^Environment="([A-Z_]+)=(.*)"$/gm)].map((m) => [m[1], m[2]]))
    expect(Object.keys(env).sort()).toEqual([...MODULE_UNIT_ENV, 'HOME'].sort())
    expect(env).toEqual({
      EE_MODULE_ID: 'hello',
      EE_MODULE_COMMIT: input.commit,
      EE_MODULE_SOCKET: '/run/ee-module/kernel.sock',
      NODE_ENV: 'production',
      PATH: '/opt/ee/runtimes/node-22/bin:/usr/bin:/bin',
      HOME: '/tmp',
    })
    expect(lines(unit)).toContain('EnvironmentFile=/run/ee/env/mod-hello.env')
    for (const name of ['EE_API_URL', 'DATABASE_URL', 'EE_STATE_DIR', 'PORT', 'EE_WORKLOAD']) expect(unit).not.toContain(name)
  })

  it('starts the manifest argv on the pinned runtime from the release', () => {
    expect(lines(unit)).toContain('ExecStart=/opt/ee/runtimes/node-22/bin/node index.mjs')
    expect(lines(unit)).toContain(`WorkingDirectory=${input.releaseDir}`)
  })

  it('takes memory and CPU from the manifest, capped at 1024M and 100 %', () => {
    expect(lines(unit)).toEqual(expect.arrayContaining(['MemoryMax=64M', 'CPUQuota=10%']))
    const big = renderModuleUnit({ ...input, resources: { memoryMb: 4096, cpuPercent: 400 } })
    expect(lines(big)).toEqual(expect.arrayContaining(['MemoryMax=1024M', 'CPUQuota=100%']))
  })

  it('is never enabled for boot ([Install] absent): ee starts it after it wrote the env file', () => {
    expect(unit).not.toMatch(/\[Install\]/)
  })

  it('leaves the app/system unit template unchanged', () => {
    const w = workloadSchema.parse({ name: 'shop', tier: 'app', source: { kind: 'release', tarball: '/r.tgz', sha256: 'a'.repeat(64) } })
    const u = renderUnit({ workload: w, contract: { runtime: 'node', node: '22', start: ['node', 'x.js'], build: [], preStart: [], health: '/', services: [], capabilities: [] }, slot: 'a', port: 4100, releaseDir: '/r' })
    expect(lines(u)).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6')
  })
})

describe('the module field of a workload (spec.ts)', () => {
  const source = { kind: 'release', tarball: `${MODULE_BUNDLE_STORE}/hello/${'b'.repeat(64)}.tar.gz`, sha256: 'b'.repeat(64) }
  const contract = { runtime: 'node', node: '22', start: ['node', 'index.mjs'] }
  const module = { id: 'hello', version: '0.1.0', commit: 'c1'.repeat(20), manifest: {}, receipt: {}, desired: 'running' }
  const base = { name: 'mod-hello', tier: 'module', source, contract, module }

  it('a module workload parses, with stopReason and sentence defaulting to null', () => {
    expect(workloadSchema.parse(base).module).toEqual({ ...module, stopReason: null, sentence: null })
  })

  it('is allowed only on the module tier, named mod-<id>, from a release, with no workload env', () => {
    expect(() => workloadSchema.parse({ ...base, tier: 'app' })).toThrow(/only module workloads carry a module/)
    expect(() => workloadSchema.parse({ ...base, name: 'mod-other' })).toThrow(/named mod-hello/)
    expect(() => workloadSchema.parse({ ...base, env: { FOO: 'bar' } })).toThrow(/never workload env/)
    expect(() => workloadSchema.parse({ ...base, source: { kind: 'git', mirror: 'sources/x.git', ref: 'main', rev: 'a'.repeat(40) } })).toThrow(/release source/)
    expect(() => workloadSchema.parse({ ...base, contract: undefined })).toThrow(/carries the contract/)
  })

  it('stopped says why; running has no reason', () => {
    expect(() => workloadSchema.parse({ ...base, module: { ...module, desired: 'stopped' } })).toThrow(/says why/)
    expect(() => workloadSchema.parse({ ...base, module: { ...module, stopReason: 'person', sentence: 'x' } })).toThrow(/no stop reason/)
    expect(workloadSchema.parse({ ...base, module: { ...module, desired: 'stopped', stopReason: 'person', sentence: 'Ada switched it off.' } }).module?.desired).toBe('stopped')
  })

  it('an old module-tier workload without the field still parses (the generic path)', () => {
    expect(workloadSchema.parse({ name: 'legacy', tier: 'module', source }).module).toBeUndefined()
  })
})

describe("ee's bundle takes zod and js-yaml from ee's own node_modules (the contract files import them too)", () => {
  it('one copy of each in dist/ee.mjs', async () => {
    const { build } = await import('esbuild')
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as { scripts: { bundle: string }; dependencies: Record<string, string> }
    expect(pkg.dependencies).toHaveProperty('js-yaml')
    const aliases = Object.fromEntries([...pkg.scripts.bundle.matchAll(/--alias:([^=\s]+)=(\S+)/g)].map((m) => [m[1]!, m[2]!]))
    expect(aliases).toEqual({ zod: 'zod', 'js-yaml': 'js-yaml' })
    const r = await build({
      entryPoints: [join(import.meta.dirname, 'main.ts')],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      alias: aliases,
      absWorkingDir: join(import.meta.dirname, '..'),
      write: false,
      metafile: true,
      logLevel: 'silent',
    })
    const roots = new Set(
      Object.keys(r.metafile.inputs)
        .map((k) => /^(.*node_modules\/(?:zod|js-yaml))\//.exec(k)?.[1])
        .filter((k): k is string => k !== undefined),
    )
    expect([...roots].sort()).toEqual(['node_modules/js-yaml', 'node_modules/zod'])
  }, 30_000)
})

describe('paths and the backup set', () => {
  it('the bundle store and hand-off dir are the contract ones', () => {
    expect(PATHS.moduleBundles).toBe(MODULE_BUNDLE_STORE)
    expect(PATHS.moduleHandoff).toBe(`${PATHS.osState}/${MODULE_BUNDLE_HANDOFF_DIR}`)
    expect(PATHS.moduleRepo).toBe(`${PATHS.osState}/module-repo`)
  })

  it('bundles and the module repo are in the backup (a restore runs the same bytes)', () => {
    expect(productionSources().eeState).toEqual(expect.arrayContaining([MODULE_BUNDLE_STORE, '/var/lib/ee-state/os/module-repo']))
  })
})
