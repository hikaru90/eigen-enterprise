import { describe, expect, it } from 'vitest'
import type { DesiredState } from './company-repo.ts'
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
    ).rejects.toThrow(/site: .*health check.*previous release keeps serving/)
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
