import { describe, expect, it } from 'vitest'
import type { DesiredState } from './company-repo.ts'
import { readDeployLog } from './deploys.ts'
import { emptyJournal } from './journal.ts'
import { livekitWorkload } from './livekit.ts'
import { allowRetry, prepareRelease, reconcile, renderLiveEnvFiles, type SecretAccess } from './reconcile.ts'
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
    settings: { consoleHost: 'os.example.com', publicHost: null, acmeEmail: null, callsHost: null, rtcNodeIp: null },
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

  it('a start command ee cannot run fails ONCE, with the reason in the record — no retry every tick', async () => {
    const sys = box(A)
    sys.tarballs.set(`/rel/${A}.tgz`, { 'ee.json': JSON.stringify({ runtime: 'node', node: '22', start: ['bash', 'run.sh'], health: '/' }) })
    const journal = emptyJournal()
    const secrets = memSecrets()
    await expect(reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets, healthTimeoutMs: 5_000 })).rejects.toThrow(/argv\[0\]/)
    await expect(reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets, healthTimeoutMs: 5_000 })).rejects.toThrow(/unchanged since/)
    const failed = journal.events.filter((e) => e.type === 'deploy.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.message).toMatch(/argv\[0\]/)
    expect(journal.workloads.site?.lastError).toMatch(/argv\[0\]/)
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

  it('the app\'s encrypted env vars reach its build steps through a 0600 env file, never argv, and a changed value rebuilds', async () => {
    const sys = new FakeSystem()
    const written: Array<{ path: string; content: string; mode?: number }> = []
    const write = sys.writeFile.bind(sys)
    sys.writeFile = async (p: string, c: string, mode?: number) => {
      written.push({ path: p, content: c, mode })
      return write(p, c)
    }
    const runs: string[][] = []
    const run = sys.run.bind(sys)
    sys.run = async (cmd: string, args: string[]) => {
      if (cmd === 'systemd-run') {
        runs.push(args)
        // the env file exists while the build step runs
        const f = args.find((a: string) => a.startsWith('EnvironmentFile='))!.slice('EnvironmentFile='.length)
        expect(sys.files.get(f)).toMatch(/^PUBLIC_API_URL="https:\/\/api\.(example|other)"$/m)
      }
      return run(cmd, args)
    }
    const one = await prepareRelease(sys, gitWorkload(contract), undefined, { PUBLIC_API_URL: 'https://api.example', STRIPE_KEY: 'sk_live_secret' })

    const step = runs.find((a) => a.includes('install'))!
    expect(step.join(' ')).not.toContain('sk_live_secret')
    // Build steps install dev dependencies (vite, rollup's native binary) despite
    // NODE_ENV=production — as Nixpacks does with NPM_CONFIG_PRODUCTION=false.
    expect(step).toContain('npm_config_include=dev')
    expect(step).toContain('NODE_ENV=production')
    // Node's default heap is too small for big builds: 75% of the build's memory cap.
    expect(step).toContain('NODE_OPTIONS=--max-old-space-size=1152')
    const envPath = step.find((a) => a.startsWith('EnvironmentFile='))!.slice('EnvironmentFile='.length)
    expect(written.find((w) => w.path === envPath)?.mode).toBe(0o600)
    expect(sys.files.has(envPath)).toBe(false) // removed after the build

    const two = await prepareRelease(sys, gitWorkload(contract), undefined, { PUBLIC_API_URL: 'https://api.other', STRIPE_KEY: 'sk_live_secret' })
    expect(two.id).not.toBe(one.id)
    expect(one.id).not.toContain('sk_live_secret')
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

  it('an explicit redeploy (allowRetry) tries the same failed release once more; ticks still do not', async () => {
    const sys = box(A)
    const journal = emptyJournal()
    const secrets = memSecrets()
    const pass = () => reconcile({ sys, repo: { read: async () => desired(A) }, journal, secrets, healthTimeoutMs: 5_000 })
    await expect(pass()).rejects.toThrow()
    await expect(pass()).rejects.toThrow()
    const restarts = () => sys.commands.filter((c) => c === 'systemctl restart ee-site-a.service').length
    expect(restarts()).toBe(1)
    allowRetry(journal, 'site')
    await expect(pass()).rejects.toThrow()
    expect(restarts()).toBe(2)
    expect(journal.deploys).toHaveLength(2)
    await expect(pass()).rejects.toThrow()
    expect(restarts()).toBe(2)
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

describe('livekit-server as a system workload (calls)', () => {
  const OS_SHA = 'd'.repeat(64)
  const LK_A = 'e'.repeat(64)
  const LK_B = 'f'.repeat(64)
  const BINARY_JSON = JSON.stringify({ runtime: 'binary', start: ['./livekit-server'], health: '/' })
  const KEY = 'APIabcdef012345'
  const SECRET = 'x'.repeat(43)

  function callsBox() {
    const sys = new FakeSystem()
    sys.hashes.set(`/rel/${OS_SHA}.tgz`, OS_SHA)
    sys.tarballs.set(`/rel/${OS_SHA}.tgz`, { 'ee.json': EE_JSON })
    for (const s of [LK_A, LK_B]) {
      sys.hashes.set(`/rel/lk-${s}.tgz`, s)
      sys.tarballs.set(`/rel/lk-${s}.tgz`, { 'ee.json': BINARY_JSON, 'livekit-server': '\x7fELF' })
    }
    return sys
  }
  const callsSecrets = () => {
    const s = memSecrets()
    s.data['livekit'] = { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET }
    return s
  }
  function callsState(lkSha: string, settings: Partial<DesiredState['settings']> = {}): DesiredState {
    return {
      rev: 'r'.repeat(40),
      // HEAD lists workloads/ sorted by file name: livekit (ports 4100/4101), then os (4102/4103).
      workloads: [
        workloadSchema.parse(livekitWorkload(`/rel/lk-${lkSha}.tgz`, lkSha)),
        workloadSchema.parse({ name: 'os', tier: 'system', source: { kind: 'release', tarball: `/rel/${OS_SHA}.tgz`, sha256: OS_SHA } }),
      ],
      routes: [
        { host: 'os.example.com', workload: 'os' },
        { host: 'rtc.os.example.com', workload: 'livekit' },
      ],
      settings: { consoleHost: 'os.example.com', publicHost: null, acmeEmail: null, callsHost: 'rtc.os.example.com', rtcNodeIp: '203.0.113.7', ...settings },
    }
  }
  const envFile = (sys: FakeSystem, name: string) => sys.files.get(`/run/ee/env/${name}.env`) ?? ''
  const livekitConfigIn = (sys: FakeSystem, slot: 'a' | 'b') => {
    const line = envFile(sys, `livekit-${slot}`).split('\n').find((l) => l.startsWith('LIVEKIT_CONFIG='))!
    return JSON.parse(line.slice('LIVEKIT_CONFIG="'.length, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'))
  }

  it('first deploy: livekit runs from its release with the media ports, its config, and the edge routes rtc.<console> to it', async () => {
    const sys = callsBox()
    sys.healthy.add(4100).add(4102)
    const journal = emptyJournal()
    await reconcile({ sys, repo: { read: async () => callsState(LK_A) }, journal, secrets: callsSecrets(), healthTimeoutMs: 10_000 })

    expect(journal.workloads.livekit?.active).toBe('a')
    const unit = sys.files.get('/etc/systemd/system/ee-livekit-a.service')!
    expect(unit).toMatch(/ExecStart=\/var\/lib\/ee\/workloads\/livekit\/releases\/[0-9a-f-]+\/livekit-server\n/)
    expect(unit).toContain('SocketBindAllow=tcp:4100')
    expect(unit).toContain('SocketBindAllow=tcp:7881')
    expect(unit).toContain('SocketBindAllow=udp:7882')

    const cfg = livekitConfigIn(sys, 'a')
    expect(cfg).toMatchObject({ port: 4100, rtc: { node_ip: '203.0.113.7', tcp_port: 7881, udp_port: 7882 }, keys: { [KEY]: SECRET } })
    expect(cfg.webhook).toEqual({ api_key: KEY, urls: ['http://127.0.0.1:4000/api/calls/livekit'] })

    const caddy = JSON.stringify(sys.caddyLoads.at(-1))
    expect(caddy).toContain('"host":["rtc.os.example.com"]')
    expect(caddy).toMatch(/"rtc\.os\.example\.com"\]\}\],"handle":\[\{"handler":"subroute","routes":\[\{"handle":\[\{"handler":"reverse_proxy","upstreams":\[\{"dial":"127\.0\.0\.1:4100"\}\]/)
    // os reaches LiveKit's server API on a stable loopback listener, never via the public calls host.
    const servers = (sys.caddyLoads.at(-1) as { apps: { http: { servers: Record<string, { listen: string[]; routes: unknown[] }> } } }).apps.http.servers
    expect(servers['internal-livekit']?.listen).toEqual(['127.0.0.1:4001'])
    expect(JSON.stringify(servers['internal-livekit']?.routes)).toContain('"dial":"127.0.0.1:4100"')
  })

  it('os gets LIVEKIT_API_KEY, LIVEKIT_API_SECRET and LIVEKIT_URL through its root-only env file', async () => {
    const sys = callsBox()
    sys.healthy.add(4100).add(4102)
    await reconcile({ sys, repo: { read: async () => callsState(LK_A) }, journal: emptyJournal(), secrets: callsSecrets(), healthTimeoutMs: 10_000 })
    const env = envFile(sys, 'os-a')
    expect(env).toContain(`LIVEKIT_API_KEY="${KEY}"`)
    expect(env).toContain(`LIVEKIT_API_SECRET="${SECRET}"`)
    expect(env).toContain('LIVEKIT_URL="wss://rtc.os.example.com"')
    expect(env).toContain('LIVEKIT_API_URL="http://127.0.0.1:4001"')
    // Secrets never land in the unit file (world-readable) — only in the 0600 env file.
    expect(sys.files.get('/etc/systemd/system/ee-os-a.service')).not.toContain(SECRET)
    expect(sys.files.get('/etc/systemd/system/ee-livekit-a.service')).not.toContain(SECRET)
  })

  it('an unchanged pass restarts nothing (calls in progress keep running)', async () => {
    const sys = callsBox()
    sys.healthy.add(4100).add(4102)
    const journal = emptyJournal()
    const secrets = callsSecrets()
    const pass = () => reconcile({ sys, repo: { read: async () => callsState(LK_A) }, journal, secrets, healthTimeoutMs: 10_000 })
    await pass()
    const before = sys.commands.filter((c) => /^systemctl (restart|stop|start) ee-livekit/.test(c)).length
    await pass()
    expect(sys.commands.filter((c) => /^systemctl (restart|stop|start) ee-livekit/.test(c)).length).toBe(before)
  })

  it('a new livekit release stops the live slot BEFORE starting the candidate (host ports are exclusive: no blue-green)', async () => {
    const sys = callsBox()
    sys.healthy.add(4100).add(4101).add(4102)
    const journal = emptyJournal()
    const secrets = callsSecrets()
    await reconcile({ sys, repo: { read: async () => callsState(LK_A) }, journal, secrets, healthTimeoutMs: 10_000 })
    await reconcile({ sys, repo: { read: async () => callsState(LK_B) }, journal, secrets, healthTimeoutMs: 10_000 })

    const stopOld = sys.commands.indexOf('systemctl stop ee-livekit-a.service')
    const startNew = sys.commands.indexOf('systemctl restart ee-livekit-b.service')
    expect(stopOld).toBeGreaterThan(-1)
    expect(startNew).toBeGreaterThan(stopOld)
    expect(journal.workloads.livekit?.active).toBe('b')
    expect(livekitConfigIn(sys, 'b').port).toBe(4101)
    expect(JSON.stringify(sys.caddyLoads.at(-1))).toContain('127.0.0.1:4101')
    expect(journal.events.some((e) => e.type === 'deploy.started' && e.workload === 'livekit' && /stopped ee-livekit-a\.service first/.test(e.message))).toBe(true)
  })

  it('a failing livekit candidate is stopped and the previous release is started again', async () => {
    const sys = callsBox()
    sys.healthy.add(4100).add(4102)
    const journal = emptyJournal()
    const secrets = callsSecrets()
    await reconcile({ sys, repo: { read: async () => callsState(LK_A) }, journal, secrets, healthTimeoutMs: 10_000 })
    await expect(
      reconcile({ sys, repo: { read: async () => callsState(LK_B) }, journal, secrets, healthTimeoutMs: 5_000 }),
    ).rejects.toThrow(/livekit: .*previous release was started again/)
    expect(journal.workloads.livekit?.active).toBe('a')
    expect(sys.units.get('ee-livekit-b.service')).toBe('inactive')
    expect(sys.units.get('ee-livekit-a.service')).toBe('active')
    const restartOld = sys.commands.lastIndexOf('systemctl start ee-livekit-a.service')
    expect(restartOld).toBeGreaterThan(sys.commands.indexOf('systemctl disable --now --quiet ee-livekit-b.service'))
  })

  it('without a node IP, livekit fails loudly (no guessing) and os still deploys', async () => {
    const sys = callsBox()
    sys.healthy.add(4100).add(4102)
    const journal = emptyJournal()
    await expect(
      reconcile({ sys, repo: { read: async () => callsState(LK_A, { rtcNodeIp: null }) }, journal, secrets: callsSecrets(), healthTimeoutMs: 10_000 }),
    ).rejects.toThrow(/livekit: no node IP .*--node-ip/)
    expect(journal.workloads.livekit?.active).toBeNull()
    expect(journal.workloads.os?.active).toBe('a')
  })

  it('a binary contract on an app is a catalog gap', async () => {
    const sys = box(A)
    sys.tarballs.set(`/rel/${A}.tgz`, { 'ee.json': BINARY_JSON })
    await expect(
      reconcile({ sys, repo: { read: async () => desired(A) }, journal: emptyJournal(), secrets: memSecrets() }),
    ).rejects.toThrow(/catalog_gap: .*runtime binary \(system workloads only\)/)
  })

  it('at boot, the env files are rendered again with the livekit config and the os call env', async () => {
    const sys = callsBox()
    sys.healthy.add(4100).add(4102)
    const journal = emptyJournal()
    const secrets = callsSecrets()
    await reconcile({ sys, repo: { read: async () => callsState(LK_A) }, journal, secrets, healthTimeoutMs: 10_000 })
    const before = { lk: envFile(sys, 'livekit-a'), os: envFile(sys, 'os-a') }
    for (const k of [...sys.files.keys()]) if (k.startsWith('/run/ee/env/')) sys.files.delete(k)
    expect(await renderLiveEnvFiles(sys, callsState(LK_A), journal, secrets.data)).toBe(2)
    expect(envFile(sys, 'livekit-a')).toBe(before.lk)
    expect(envFile(sys, 'os-a')).toBe(before.os)
  })
})
