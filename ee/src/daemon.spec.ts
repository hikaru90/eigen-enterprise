import { randomBytes } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { controlHandler, Ee } from './daemon.ts'
import { emptyJournal } from './journal.ts'
import { PATHS } from './paths.ts'
import { SecretStore } from './secret-store.ts'
import type { RunResult, System } from './system.ts'

/** Minimal box for the control verbs: files in memory, ssh-keygen writes a pair. */
class FakeSystem implements System {
  files = new Map<string, string>()
  /** Files at the rev a mirror is asked about (git ls-tree / git show). */
  gitTree: Record<string, string> = {}
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
  async httpOk() {
    return true
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
})
