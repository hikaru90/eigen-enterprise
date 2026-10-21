import { randomBytes } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { controlHandler, Ee } from './daemon.ts'
import { DeployRun, forgetDeploys } from './deploys.ts'
import { emptyJournal } from './journal.ts'
import { PATHS } from './paths.ts'
import { SecretStore } from './secret-store.ts'
import type { RunResult, System } from './system.ts'

/** Minimal box for the control verbs: files in memory, ssh-keygen writes a pair. */
class FakeSystem implements System {
  files = new Map<string, string>()
  /** Files at the rev a mirror is asked about (git ls-tree / git show). */
  gitTree: Record<string, string> = {}
  symlinks = new Set<string>()
  async readFile(p: string) {
    return this.files.get(p) ?? null
  }
  async writeFile(p: string, c: string) {
    this.files.set(p, c)
  }
  async mkdirp() {}
  async exists(p: string) {
    return this.files.has(p)
  }
  async remove(p: string) {
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k)
  }
  async sha256File(): Promise<string> {
    throw new Error('unused')
  }
  async run(cmd: string, args: string[]): Promise<RunResult> {
    if (cmd === 'ssh-keygen') {
      const f = args[args.indexOf('-f') + 1]!
      this.files.set(f, 'PRIVATE-KEY-MATERIAL')
      this.files.set(`${f}.pub`, 'ssh-ed25519 AAAAPUB ee-deploy\n')
    }
    if (cmd === 'git' && args.includes('ls-tree') && args.includes('-r')) {
      if (args.includes('--name-only')) {
        return { code: 0, stdout: Object.keys(this.gitTree).join('\n') + '\n', stderr: '' }
      }
      // ls-tree -r -t --long <rev>: every blob and the trees above them.
      const dirs = new Set<string>()
      for (const p of Object.keys(this.gitTree)) {
        const parts = p.split('/')
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
      }
      const lines = [
        ...[...dirs].map((d) => `040000 tree ${'0'.repeat(40)}       -\t${d}`),
        ...Object.entries(this.gitTree).map(([p, c]) => `100644 blob ${'1'.repeat(40)} ${Buffer.byteLength(c)}\t${p}`),
      ]
      return { code: 0, stdout: lines.join('\n') + '\n', stderr: '' }
    }
    if (cmd === 'git' && args.includes('ls-tree') && args.includes('--long')) {
      const path = args.at(-1)!
      const c = this.gitTree[path]
      if (c === undefined) return { code: 0, stdout: '', stderr: '' }
      const mode = this.symlinks.has(path) ? '120000' : '100644'
      return { code: 0, stdout: `${mode} blob ${'1'.repeat(40)} ${Buffer.byteLength(c)}\t${path}\n`, stderr: '' }
    }
    if (cmd === 'git' && args.includes('cat-file')) {
      const path = args.at(-1)!.split(':')[1]!
      return { code: 0, stdout: this.gitTree[path] ?? '', stderr: '' }
    }
    if (cmd === 'git' && args.includes('ls-tree')) {
      const path = args.at(-1)!
      return { code: 0, stdout: path in this.gitTree ? `${path}\n` : '', stderr: '' }
    }
    if (cmd === 'git' && args.includes('show')) {
      const path = args.at(-1)!.split(':')[1]!
      return { code: 0, stdout: this.gitTree[path] ?? '', stderr: '' }
    }
    if (cmd === 'git') return { code: 0, stdout: `${'a'.repeat(40)}\trefs/heads/main\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  /** Per-path answers of the OS on 127.0.0.1 (null: everything answers 2xx). */
  httpPaths: Record<string, boolean> | null = null
  async httpOk(_port: number, path: string) {
    return this.httpPaths ? (this.httpPaths[path] ?? false) : true
  }
  async caddyLoad() {}
  async sleep() {}
  now() {
    return new Date('2026-10-20T00:00:00Z')
  }
}

let server: Server | null = null
let dir: string | null = null
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)))
  if (dir) await rm(dir, { recursive: true, force: true })
  server = null
})

async function start() {
  const sys = new FakeSystem()
  sys.files.set(PATHS.masterKey, randomBytes(32).toString('base64'))
  const ee = new Ee(sys, await SecretStore.open(sys))
  ee.journal = emptyJournal()
  dir = await mkdtemp(join(tmpdir(), 'ee-ctl-'))
  const socketPath = join(dir, 'ee.sock')
  server = createServer(controlHandler(ee))
  await new Promise<void>((r) => server!.listen(socketPath, r))
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; data: any }>((resolve, reject) => {
      const text = body === undefined ? '' : JSON.stringify(body)
      const req = request({ socketPath, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, (res) => {
        let raw = ''
        res.on('data', (d) => (raw += String(d)))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : null }))
      })
      req.on('error', reject)
      req.end(text)
    })
  return { sys, ee, call }
}

describe('control API: claim links (ee claim-link)', () => {
  it('mints a link only while eigenEnterprise says nobody claimed the company', async () => {
    const { sys, ee, call } = await start()
    sys.httpPaths = { '/api/claim/open': true, '/api/health': true }
    vi.spyOn(ee.repo, 'read').mockResolvedValue({ settings: { consoleHost: 'os.kindred.test' } } as never)
    vi.spyOn(ee, 'reconcile').mockResolvedValue(undefined as never)
    const ok = await call('POST', '/v1/claim', { author: 'root' })
    expect(ok.status).toBe(200)
    expect(ok.data.url).toMatch(/\/claim\?token=/)
    expect(ee.secrets.all()['os']?.['EE_CLAIM_TOKEN_HASH']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses once the company has an owner, and stores nothing', async () => {
    const { sys, ee, call } = await start()
    sys.httpPaths = { '/api/claim/open': false, '/api/health': true }
    const r = await call('POST', '/v1/claim', { author: 'root' })
    expect(r.status).toBe(409)
    expect(JSON.stringify(r.data)).toMatch(/already has an owner/)
    expect(ee.secrets.all()['os']?.['EE_CLAIM_TOKEN_HASH']).toBeUndefined()
    expect(ee.journal.events.map((e) => e.type)).not.toContain('claim.issued')
  })

  it('refuses when eigenEnterprise is not answering (cannot tell)', async () => {
    const { sys, call } = await start()
    sys.httpPaths = {}
    const r = await call('POST', '/v1/claim', { author: 'root' })
    expect(r.status).toBe(503)
  })
})

describe('control API: deploy keys', () => {
  it('create → check → delete; only the public key ever comes back', async () => {
    const { sys, ee, call } = await start()
    const created = await call('POST', '/v1/deploy-keys', { repo: 'kindred/app', author: 'human:u1' })
    expect(created.status).toBe(200)
    expect(created.data).toEqual({ keyId: expect.stringMatching(/^dk_/), publicKey: 'ssh-ed25519 AAAAPUB ee-deploy' })
    expect(JSON.stringify(created.data)).not.toContain('PRIVATE')
    expect(sys.files.get(PATHS.secrets)).not.toContain('PRIVATE-KEY-MATERIAL')

    const checked = await call('POST', `/v1/deploy-keys/${created.data.keyId}/check`, { repo: 'kindred/app' })
    expect(checked.data).toEqual({ ok: true, branches: ['main'] })

    const deleted = await call('DELETE', `/v1/deploy-keys/${created.data.keyId}`, { author: 'human:u1' })
    expect(deleted).toEqual({ status: 200, data: { ok: true } })
    expect(ee.secrets.all()['_deploy_keys']?.[created.data.keyId]).toBeUndefined()
    expect(ee.journal.events.map((e) => e.type)).toEqual(['deploy_key.created', 'deploy_key.deleted'])

    const again = await call('DELETE', `/v1/deploy-keys/${created.data.keyId}`, { author: 'human:u1' })
    expect(again.status).toBe(404)
  })

  it('rejects a malformed repo or key id', async () => {
    const { call } = await start()
    expect((await call('POST', '/v1/deploy-keys', { repo: 'not a repo', author: 'a' })).status).toBe(400)
    expect((await call('DELETE', '/v1/deploy-keys/../../etc', { author: 'a' })).status).toBe(404)
  })

  it('the secret scope is not settable through POST /v1/secrets', async () => {
    const { call } = await start()
    const r = await call('POST', '/v1/secrets', { workload: '_deploy_keys', name: 'X', value: 'y', author: 'a' })
    expect(r.status).toBe(403)
  })
})

describe('control API: apps from the dashboard', () => {
  it('GET /v1/catalog lists the runtimes eigen provides', async () => {
    const { call } = await start()
    const r = await call('GET', '/v1/catalog')
    expect(r.status).toBe(200)
    expect(r.data.runtimes.node).toContain('22')
  })

  it('POST /v1/apps refuses a contract the catalog lacks, as a catalog_gap naming it', async () => {
    const { call } = await start()
    const r = await call('POST', '/v1/apps', {
      name: 'shop',
      source: { kind: 'git', mirror: 'sources/gh-shop.git', ref: 'main', rev: 'c'.repeat(40) },
      env: {},
      secrets: [],
      deploy: { auto: false },
      contract: { runtime: 'node', node: '18', start: ['node', 'index.js'] },
      author: 'human:u1',
    })
    expect(r.status).toBe(422)
    expect(r.data).toMatchObject({ type: 'urn:ee:catalog_gap', missing: ['runtime node@18'] })
  })

  it('GET /v1/sources/contract reads ee.json at a rev from the mirror, or says there is none', async () => {
    const { sys, call } = await start()
    const rev = 'c'.repeat(40)
    sys.files.set(`${PATHS.company}/sources/gh-shop.git`, '')
    sys.gitTree = { 'ee.json': JSON.stringify({ runtime: 'node', node: '22', start: ['node', 'index.js'] }) }
    const found = await call('GET', `/v1/sources/contract?name=gh-shop&rev=${rev}`)
    expect(found.status).toBe(200)
    expect(found.data).toMatchObject({ present: true, contract: { runtime: 'node', start: ['node', 'index.js'] }, gap: null })

    sys.gitTree = { 'ee.json': JSON.stringify({ runtime: 'node', node: '16', start: ['node', 'index.js'] }) }
    const gap = await call('GET', `/v1/sources/contract?name=gh-shop&rev=${rev}`)
    expect(gap.data).toMatchObject({ present: true, gap: ['runtime node@16'] })

    sys.gitTree = {}
    const none = await call('GET', `/v1/sources/contract?name=gh-shop&rev=${rev}`)
    expect(none.data).toEqual({ present: false, contract: null, gap: null, error: null })

    expect((await call('GET', `/v1/sources/contract?name=../x&rev=${rev}`)).status).toBe(400)
    expect((await call('GET', `/v1/sources/contract?name=gh-nope&rev=${rev}`)).status).toBe(404)
  })

  it('GET /v1/events?workload= returns that workload’s deploy history, newest last', async () => {
    const { ee, call } = await start()
    ee.journal.events.push(
      { id: '1', time: 't1', type: 'deploy.started', workload: 'shop', message: 'm1', data: {} },
      { id: '2', time: 't2', type: 'deploy.started', workload: 'other', message: 'm2', data: {} },
      { id: '3', time: 't3', type: 'deploy.succeeded', workload: 'shop', message: 'm3', data: { release: 'r' } },
    )
    const r = await call('GET', '/v1/events?workload=shop')
    expect(r.status).toBe(200)
    expect(r.data.events.map((e: { id: string }) => e.id)).toEqual(['1', '3'])
  })

  it('GET /v1/sources/tree lists the repo at a rev, bounded by depth', async () => {
    const { sys, call } = await start()
    const rev = 'c'.repeat(40)
    sys.files.set(`${PATHS.company}/sources/gh-shop.git`, '')
    sys.gitTree = { 'README.md': '# shop', 'package.json': '{}', 'server/main.js': 'x', 'server/lib/deep.js': 'y' }
    const r = await call('GET', `/v1/sources/tree?name=gh-shop&rev=${rev}&depth=2`)
    expect(r.status).toBe(200)
    const paths = r.data.entries.map((e: { path: string }) => e.path)
    expect(paths).toEqual(expect.arrayContaining(['README.md', 'package.json', 'server', 'server/main.js', 'server/lib']))
    expect(paths).not.toContain('server/lib/deep.js')
    expect(r.data.entries.find((e: { path: string }) => e.path === 'package.json')).toEqual({ path: 'package.json', type: 'blob', size: 2 })
    expect(r.data.truncated).toBe(false)
    expect((await call('GET', `/v1/sources/tree?name=gh-nope&rev=${rev}&depth=1`)).status).toBe(404)
    expect((await call('GET', `/v1/sources/tree?name=gh-shop&rev=${rev}&depth=99`)).status).toBe(400)
  })

  it('GET /v1/sources/file returns one text file, refusing traversal, symlinks, binaries and big files', async () => {
    const { sys, call } = await start()
    const rev = 'c'.repeat(40)
    sys.files.set(`${PATHS.company}/sources/gh-shop.git`, '')
    sys.gitTree = { 'README.md': '# shop\nrun node server/main.js', 'big.txt': 'a'.repeat(64 * 1024 + 1), 'logo.png': 'PNG\u0000\u0001', link: 'x' }
    sys.symlinks.add('link')
    const ok = await call('GET', `/v1/sources/file?name=gh-shop&rev=${rev}&path=README.md`)
    expect(ok).toEqual({ status: 200, data: { path: 'README.md', size: 30, content: '# shop\nrun node server/main.js' } })
    for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../b', 'a//b', '.git/config', 'a\\b']) {
      expect((await call('GET', `/v1/sources/file?name=gh-shop&rev=${rev}&path=${encodeURIComponent(bad)}`)).status).toBe(400)
    }
    expect((await call('GET', `/v1/sources/file?name=gh-shop&rev=${rev}&path=big.txt`)).status).toBe(413)
    expect((await call('GET', `/v1/sources/file?name=gh-shop&rev=${rev}&path=logo.png`)).status).toBe(415)
    expect((await call('GET', `/v1/sources/file?name=gh-shop&rev=${rev}&path=link`)).status).toBe(415)
    expect((await call('GET', `/v1/sources/file?name=gh-shop&rev=${rev}&path=missing.md`)).status).toBe(404)
  })
})

describe('control API: deploys (progress + log per attempt)', () => {
  it('GET /v1/deploys?workload= lists that workload’s attempts newest first, with status and stages', async () => {
    const { sys, ee, call } = await start()
    const one = new DeployRun(sys, ee.journal, 'shop', () => [])
    one.stage('fetching')
    await one.succeed('rel1')
    const two = new DeployRun(sys, ee.journal, 'shop', () => [])
    two.stage('building')
    new DeployRun(sys, ee.journal, 'other', () => [])
    const r = await call('GET', '/v1/deploys?workload=shop')
    expect(r.status).toBe(200)
    expect(r.data.deploys.map((d: { id: string }) => d.id)).toEqual([two.record.id, one.record.id])
    expect(r.data.deploys[0]).toMatchObject({ status: 'running', stage: 'building' })
    expect(r.data.deploys[1]).toMatchObject({ status: 'live', release: 'rel1' })
    expect((await call('GET', '/v1/deploys?workload=../x')).status).toBe(400)
  })

  it('GET /v1/deploys/:id/log returns the bounded, redacted log, live while running and after it ends', async () => {
    const { sys, ee, call } = await start()
    const run = new DeployRun(sys, ee.journal, 'shop', () => ['hunter2-secret'])
    run.stage('health')
    run.log('start', "Error: Cannot find module 'index.js'\ncode: 'MODULE_NOT_FOUND'\npw=hunter2-secret")
    const live = await call('GET', `/v1/deploys/${run.record.id}/log`)
    expect(live.status).toBe(200)
    expect(live.data.deploy).toMatchObject({ id: run.record.id, status: 'running', stage: 'health' })
    expect(live.data.lines.join('\n')).toContain('MODULE_NOT_FOUND')
    await run.fail('the app crashed on start (exit status 1)')
    const ended = await call('GET', `/v1/deploys/${run.record.id}/log`)
    expect(ended.data.deploy).toMatchObject({ status: 'failed', error: 'the app crashed on start (exit status 1)' })
    expect(ended.data.lines.join('\n')).toContain('MODULE_NOT_FOUND')
    expect(JSON.stringify(ended.data)).not.toContain('hunter2-secret')
    const many = new DeployRun(sys, ee.journal, 'shop', () => [])
    many.log('build', Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n'))
    const bounded = await call('GET', `/v1/deploys/${many.record.id}/log`)
    expect(bounded.data.lines).toHaveLength(400)
    expect(bounded.data.lines.at(-1)).toBe('line 999')
    expect((await call('GET', '/v1/deploys/00000000-0000-0000-0000-000000000000/log')).status).toBe(404)
    expect((await call('GET', '/v1/deploys/..%2Fetc/log')).status).toBe(404)
  })

  it('removing an app forgets its deploys and their logs', async () => {
    // (DELETE /v1/apps commits to the company repo, which this fake box has no git for; the
    // verb calls forgetDeploys right before forgetWorkload.)
    const { sys, ee, call } = await start()
    const run = new DeployRun(sys, ee.journal, 'shop', () => [])
    await run.fail('x')
    const other = new DeployRun(sys, ee.journal, 'other', () => [])
    await other.fail('y')
    expect(sys.files.has(`${PATHS.root}/deploys/${run.record.id}.log`)).toBe(true)
    await forgetDeploys(sys, ee.journal, 'shop')
    expect(ee.journal.deploys.map((d) => d.workload)).toEqual(['other'])
    expect(sys.files.has(`${PATHS.root}/deploys/${run.record.id}.log`)).toBe(false)
    expect((await call('GET', `/v1/deploys/${run.record.id}/log`)).status).toBe(404)
  })

  it('GET /v1/sources/files lists the repo’s files at a rev, for the agent harness to diagnose', async () => {
    const { sys, call } = await start()
    sys.files.set(`${PATHS.company}/sources/gh-shop.git`, '')
    sys.gitTree = { 'package.json': '{}', 'server.js': '' }
    const r = await call('GET', `/v1/sources/files?name=gh-shop&rev=${'c'.repeat(40)}`)
    expect(r.status).toBe(200)
    expect(r.data).toEqual({ files: ['package.json', 'server.js'], truncated: false })
  })
})
