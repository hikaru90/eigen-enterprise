import { describe, expect, it } from 'vitest'
import type { DesiredState } from './company-repo.ts'
import { readDeployLog } from './deploys.ts'
import { emptyJournal } from './journal.ts'
import { prepareRelease, reconcile, type SecretAccess } from './reconcile.ts'
import type { SecretMap } from './secrets.ts'
import { workloadSchema } from './spec.ts'
import type { RunResult, System } from './system.ts'

/** In-memory box: files, unit states, and a scripted health answer per port. */
class FakeSystem implements System {
  files = new Map<string, string>()
  hashes = new Map<string, string>()
  /** tarball path → files it contains (relative path → content) */
  tarballs = new Map<string, Record<string, string>>()
  units = new Map<string, string>()
  healthy = new Set<number>()
  caddyLoads: unknown[] = []
  commands: string[] = []
  /** unit → NRestarts systemd reports (a crash-looping candidate). */
  restarts = new Map<string, number>()
  /** unit → what journalctl prints for it. */
  journals = new Map<string, string>()
  /** What a sandboxed build step prints. */
  buildOutput = ''
  private clock = 0

  async readFile(p: string) {
    return this.files.get(p) ?? null
  }
  async writeFile(p: string, c: string) {
    this.files.set(p, c)
  }
  async mkdirp() {}
  async exists(p: string) {
    return [...this.files.keys()].some((k) => k === p || k.startsWith(p + '/'))
  }
  async remove(p: string) {
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k)
  }
  async sha256File(p: string) {
    const h = this.hashes.get(p)
    if (!h) throw new Error(`ENOENT ${p}`)
    return h
  }
  async run(cmd: string, args: string[]): Promise<RunResult> {
    this.commands.push([cmd, ...args].join(' '))
    const ok = { code: 0, stdout: '', stderr: '' }
    if (cmd === 'tar') {
      const content = this.tarballs.get(args[1]!)
      if (!content) return { code: 2, stdout: '', stderr: 'no such tarball' }
      for (const [rel, text] of Object.entries(content)) this.files.set(`${args[3]}/${rel}`, text)
      return ok
    }
    if (cmd === 'mv') {
      for (const [k, v] of [...this.files.entries()]) {
        if (k.startsWith(args[0]! + '/')) {
          this.files.delete(k)
          this.files.set(args[1]! + k.slice(args[0]!.length), v)
        }
      }
      return ok
    }
    if (cmd === 'journalctl') return { code: 0, stdout: this.journals.get(args[args.indexOf('-u') + 1]!) ?? '', stderr: '' }
    if (cmd === 'systemd-run') return { code: 0, stdout: this.buildOutput, stderr: '' }
    if (cmd === 'systemctl' && args[0] === 'show') {
      const unit = args.at(-1)!
      if (args.includes('NRestarts')) return { code: 0, stdout: `${this.restarts.get(unit) ?? 0}\n`, stderr: '' }
      return { code: 0, stdout: '1\n', stderr: '' }
    }
    if (cmd === 'systemctl') {
      const [verb, ...rest] = args
      const unit = rest.filter((a) => !a.startsWith('--')).at(-1) ?? ''
      if (verb === 'is-active') return { code: 0, stdout: (this.units.get(args[1]!) ?? 'inactive') + '\n', stderr: '' }
      if (verb === 'restart' || verb === 'start') this.units.set(unit, 'active')
      if (verb === 'stop' || (verb === 'disable' && args.includes('--now'))) this.units.set(unit, 'inactive')
      return ok
    }
    return ok
  }
  async httpOk(port: number) {
    return this.healthy.has(port)
  }
  async caddyLoad(cfg: unknown) {
    this.caddyLoads.push(cfg)
  }
  async sleep(ms: number) {
    this.clock += ms
  }
  now() {
    return new Date(this.clock)
  }
}

const memSecrets = (): SecretAccess & { data: SecretMap } => {
  const data: SecretMap = {}
  return {
    data,
    all: () => data,
    async set(w, n, v) {
      data[w] = { ...(data[w] ?? {}), [n]: v }
    },
  }
}

const EE_JSON = JSON.stringify({ runtime: 'node', node: '22', start: ['node', 'build/index.js'], health: '/api/health' })

function desired(sha: string, extra: Partial<DesiredState> = {}): DesiredState {
  return {
    rev: 'r'.repeat(40),
    workloads: [
      workloadSchema.parse({
        name: 'site',
        tier: 'app',
        source: { kind: 'release', tarball: `/rel/${sha}.tgz`, sha256: sha },
      }),
    ],
    routes: [{ host: 'site.example.com', workload: 'site' }],
    settings: { consoleHost: 'os.example.com', publicHost: null, acmeEmail: null },
    ...extra,
  }
}

function box(...shas: string[]) {
  const sys = new FakeSystem()
  for (const s of shas) {
    sys.hashes.set(`/rel/${s}.tgz`, s)
    sys.tarballs.set(`/rel/${s}.tgz`, { 'ee.json': EE_JSON })
  }
  return sys
}

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

describe('prepareRelease', () => {
  it('two processes unpacking the same release never share a temporary directory', async () => {
    const sys = box(A)
    const tarTargets: string[] = []
    const run = sys.run.bind(sys)
    sys.run = async (cmd, args) => {
      if (cmd === 'tar') tarTargets.push(args[3]!)
      return run(cmd, args)
    }
    const workload = desired(A).workloads[0]!
    const [one, two] = await Promise.all([prepareRelease(sys, workload), prepareRelease(sys, workload)])
    expect(one.id).toBe(two.id)
    expect(new Set(tarTargets).size).toBe(tarTargets.length)
  })
})

describe('reconcile', () => {
  it('first deploy: health-gated, then the edge points at it', async () => {
    const sys = box(A)
    sys.healthy.add(4100)
    const journal = emptyJournal()
    await reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets: memSecrets(), healthTimeoutMs: 10_000 })
    expect(journal.workloads.site?.active).toBe('a')
    expect(JSON.stringify(sys.caddyLoads.at(-1))).toContain('127.0.0.1:4100')
    expect(sys.files.get('/etc/systemd/system/ee-site-a.service')).toContain('SocketBindAllow=tcp:4100')
  })

  it('a failing candidate never replaces the healthy release', async () => {
    const sys = box(A, B)
    sys.healthy.add(4100)
    const journal = emptyJournal()
    const secrets = memSecrets()
    await reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets, healthTimeoutMs: 10_000 })
    const loadsBefore = sys.caddyLoads.length

    // B's slot (port 4101) never becomes healthy: reported loudly, the old release keeps serving.
    await expect(
      reconcile({ sys, repo: { read: async () => desired(B) }, journal, secrets, healthTimeoutMs: 5_000 }),
    ).rejects.toThrow(/site: .*did not answer GET \/api\/health.*previous release keeps serving/)
    expect(journal.workloads.site?.active).toBe('a')
    expect(sys.caddyLoads.length).toBe(loadsBefore) // edge untouched
    expect(sys.units.get('ee-site-b.service')).toBe('inactive')
    expect(journal.events.some((e) => e.type === 'deploy.failed' && /keeps serving/.test(e.message))).toBe(true)
  })

  it('does not flap a release that already failed, until desired state changes', async () => {
    const sys = box(A, B)
    sys.healthy.add(4100)
    const journal = emptyJournal()
    const secrets = memSecrets()
    await reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets, healthTimeoutMs: 10_000 })
    await expect(reconcile({ sys, repo: { read: async () => desired(B) }, journal, secrets, healthTimeoutMs: 5_000 })).rejects.toThrow()
    const restarts = () => sys.commands.filter((c) => c === 'systemctl restart ee-site-b.service').length
    expect(restarts()).toBe(1)
    await expect(reconcile({ sys, repo: { read: async () => desired(B) }, journal, secrets, healthTimeoutMs: 5_000 })).rejects.toThrow()
    expect(restarts()).toBe(1)
    expect(journal.workloads.site?.active).toBe('a')
  })

  it('a healthy candidate switches the edge, then drains the old slot', async () => {
    const sys = box(A, B)
    sys.healthy.add(4100).add(4101)
    const journal = emptyJournal()
    const secrets = memSecrets()
    await reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets, healthTimeoutMs: 10_000 })
    await reconcile({ sys, repo: { read: async () => desired(B) }, journal, secrets, healthTimeoutMs: 10_000 })
    expect(journal.workloads.site?.active).toBe('b')
    expect(JSON.stringify(sys.caddyLoads.at(-1))).toContain('127.0.0.1:4101')
    const switchIdx = sys.commands.findIndex((c) => c.includes('disable --now --quiet ee-site-a.service'))
    expect(switchIdx).toBeGreaterThan(-1)
  })

  it('is a no-op when nothing changed', async () => {
    const sys = box(A)
    sys.healthy.add(4100)
    const journal = emptyJournal()
    const secrets = memSecrets()
    await reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets, healthTimeoutMs: 10_000 })
    const restarts = sys.commands.filter((c) => c.startsWith('systemctl restart')).length
    await reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets, healthTimeoutMs: 10_000 })
    expect(sys.commands.filter((c) => c.startsWith('systemctl restart')).length).toBe(restarts)
    expect(sys.caddyLoads.length).toBe(1)
  })

  it('refuses a release whose checksum does not match', async () => {
    const sys = box(A)
    sys.hashes.set(`/rel/${A}.tgz`, 'f'.repeat(64))
    await expect(
      reconcile({ sys, repo: { read: async () => desired(A) }, journal: emptyJournal(), secrets: memSecrets() }),
    ).rejects.toThrow(/checksum mismatch/)
  })

  it('fails with catalog_gap when the app needs something eigen lacks', async () => {
    const sys = box(A)
    sys.tarballs.set(`/rel/${A}.tgz`, {
      'ee.json': JSON.stringify({ runtime: 'node', node: '22', start: ['node', 'x.js'], capabilities: ['chromium'] }),
    })
    await expect(
      reconcile({ sys, repo: { read: async () => desired(A) }, journal: emptyJournal(), secrets: memSecrets() }),
    ).rejects.toThrow(/catalog_gap: eigen doesn't provide capability chromium/)
  })

  it('fails loudly on a declared secret that was never set', async () => {
    const sys = box(A)
    const d = desired(A)
    d.workloads[0] = { ...d.workloads[0]!, secrets: ['STRIPE_KEY'] }
    await expect(
      reconcile({ sys, repo: { read: async () => d }, journal: emptyJournal(), secrets: memSecrets() }),
    ).rejects.toThrow(/STRIPE_KEY is declared but not set/)
  })
})

describe('owner contract (no ee.json in the repo)', () => {
  const contract = { runtime: 'node', node: '22', build: [['npm', 'install', '--omit=dev']], start: ['node', 'index.js'], health: '/' }
  const gitWorkload = (c: unknown) =>
    workloadSchema.parse({
      name: 'shop',
      tier: 'app',
      source: { kind: 'git', mirror: 'sources/gh-shop.git', ref: 'main', rev: 'c'.repeat(40) },
      contract: c,
    })

  it('a release without ee.json builds from the contract in the company repo', async () => {
    const sys = new FakeSystem()
    const rel = await prepareRelease(sys, gitWorkload(contract))
    expect(rel.contract.start).toEqual(['node', 'index.js'])
    expect(JSON.parse(sys.files.get(`${rel.dir}/ee.json`)!)).toMatchObject({ runtime: 'node', start: ['node', 'index.js'] })
  })

  it('the owner contract wins over a repo ee.json, and a changed contract is a new release', async () => {
    const sys = new FakeSystem()
    const one = await prepareRelease(sys, gitWorkload(contract))
    const two = await prepareRelease(sys, gitWorkload({ ...contract, start: ['node', 'server.js'] }))
    expect(one.id).not.toBe(two.id)
    expect(two.contract.start).toEqual(['node', 'server.js'])
  })

  it('a missing runtime in the owner contract is a catalog gap', async () => {
    const sys = new FakeSystem()
    await expect(prepareRelease(sys, gitWorkload({ ...contract, node: '18' }))).rejects.toThrow(/catalog_gap: .*node@18/)
  })
})

describe('a candidate that fails its health gate', () => {
  const failures = (j: ReturnType<typeof emptyJournal>) =>
    j.events.filter((e) => e.workload === 'site' && (e.type === 'deploy.failed' || e.type === 'workload.error'))

  it('records ONE failure, never re-prefixes the message, and does not retry an unchanged release', async () => {
    const sys = box(A)
    const journal = emptyJournal()
    const secrets = memSecrets()
    for (let i = 0; i < 3; i++) {
      await expect(reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets, healthTimeoutMs: 5_000 })).rejects.toThrow(/site: /)
    }
    expect(failures(journal)).toHaveLength(1)
    expect(journal.workloads.site?.lastError).not.toMatch(/site: site:/)
    expect(journal.events.every((e) => !/site: site:/.test(e.message))).toBe(true)
    expect(sys.commands.filter((c) => c === 'systemctl restart ee-site-a.service')).toHaveLength(1)
    expect(journal.deploys.filter((d) => d.workload === 'site')).toHaveLength(1)
  })

  it('a crash-looping candidate fails fast, and its unit is stopped AND disabled', async () => {
    const sys = box(A)
    sys.restarts.set('ee-site-a.service', 5)
    const journal = emptyJournal()
    await expect(
      reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets: memSecrets(), healthTimeoutMs: 240_000 }),
    ).rejects.toThrow(/crash/)
    expect(sys.commands.filter((c) => c === 'systemctl is-active ee-site-a.service').length).toBeLessThan(5)
    expect(sys.commands).toContain('systemctl disable --now --quiet ee-site-a.service')
    expect(sys.units.get('ee-site-a.service')).toBe('inactive')
    expect(failures(journal)).toHaveLength(1)
  })

  it('captures the build output and the candidate journal per deploy, with secrets redacted, and records the stages', async () => {
    const sys = box(A)
    sys.tarballs.set(`/rel/${A}.tgz`, {
      'ee.json': JSON.stringify({ runtime: 'node', node: '22', build: [['npm', 'ci']], start: ['node', 'index.js'], health: '/' }),
    })
    sys.buildOutput = 'added 57 packages in 3s\n'
    sys.restarts.set('ee-site-a.service', 3)
    sys.journals.set(
      'ee-site-a.service',
      "Error: Cannot find module '/var/lib/ee/workloads/site/releases/x/index.js'\n  code: 'MODULE_NOT_FOUND'\nusing key sk_live_SUPERSECRET42\n",
    )
    const secrets = memSecrets()
    await secrets.set('site', 'API_KEY', 'sk_live_SUPERSECRET42')
    const d = desired(A)
    d.workloads[0] = { ...d.workloads[0]!, secrets: ['API_KEY'] }
    const journal = emptyJournal()
    await expect(reconcile({ sys, repo: { read: async () => d }, journal, secrets, healthTimeoutMs: 10_000 })).rejects.toThrow()

    const [dep] = journal.deploys
    expect(dep).toMatchObject({ workload: 'site', status: 'failed', stage: 'failed' })
    expect(dep!.stages.map((s) => s.stage)).toEqual(['fetching', 'building', 'starting', 'health', 'failed'])
    expect(dep!.stages.every((s) => !Number.isNaN(Date.parse(s.at)))).toBe(true)
    expect(dep!.error).toMatch(/crash/)
    expect(dep!.error).not.toContain('\n')
    const log = (await readDeployLog(sys, dep!.id)).join('\n')
    expect(log).toContain('added 57 packages')
    expect(log).toContain('MODULE_NOT_FOUND')
    expect(log).not.toContain('sk_live_SUPERSECRET42')
    const event = failures(journal)[0]!
    expect(JSON.stringify(event)).toContain('MODULE_NOT_FOUND')
    expect(JSON.stringify(event)).not.toContain('sk_live_SUPERSECRET42')
    expect(event.data.deployId).toBe(dep!.id)
  })

  it('a healthy deploy ends live, with its stages', async () => {
    const sys = box(A)
    sys.healthy.add(4100)
    const journal = emptyJournal()
    await reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets: memSecrets(), healthTimeoutMs: 10_000 })
    expect(journal.deploys[0]).toMatchObject({ status: 'live', stage: 'live', error: null })
    expect(journal.deploys[0]!.stages.map((s) => s.stage)).toEqual(['fetching', 'starting', 'health', 'live'])
    // A no-op pass starts no deploy.
    await reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets: memSecrets(), healthTimeoutMs: 10_000 })
    expect(journal.deploys).toHaveLength(1)
  })

  it('a build that fails is recorded once and not rebuilt every tick', async () => {
    const sys = box(A)
    sys.tarballs.set(`/rel/${A}.tgz`, {
      'ee.json': JSON.stringify({ runtime: 'node', node: '22', build: [['npm', 'ci']], start: ['node', 'index.js'], health: '/' }),
    })
    const run = sys.run.bind(sys)
    sys.run = async (cmd, args) => (cmd === 'systemd-run' ? { code: 1, stdout: 'npm ERR! missing package-lock.json', stderr: '' } : run(cmd, args))
    const journal = emptyJournal()
    for (let i = 0; i < 3; i++) {
      await expect(reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets: memSecrets() })).rejects.toThrow(/build step/)
    }
    expect(failures(journal)).toHaveLength(1)
    expect(journal.deploys).toHaveLength(1)
    expect(journal.deploys[0]!.stage).toBe('failed')
    expect((await readDeployLog(sys, journal.deploys[0]!.id)).join('\n')).toContain('missing package-lock.json')
  })
})
