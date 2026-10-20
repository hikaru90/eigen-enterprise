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
