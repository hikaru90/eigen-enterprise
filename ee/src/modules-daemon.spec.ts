import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseModuleManifestYaml } from '../../contracts/module-manifest.ts'
import { settingsSchema, type DesiredState } from './company-repo.ts'
import { controlHandler, Ee } from './daemon.ts'
import { emptyJournal } from './journal.ts'
import { ModuleBox } from './module-test-box.ts'
import { PATHS } from './paths.ts'
import { SecretStore } from './secret-store.ts'
import { workloadSchema } from './spec.ts'

const manifest = parseModuleManifestYaml(
  readFileSync(join(import.meta.dirname, '../../contracts/fixtures/modules/hello/module.yaml'), 'utf8').replace('secrets: []', 'secrets: [STRIPE_API_KEY]'),
)

/** The control API mounts /v1/modules (modules.ts) and guards /v1/secrets for modules. */

let server: Server | null = null
let dir: string | null = null
afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)))
  if (dir) await rm(dir, { recursive: true, force: true })
  server = null
})

const hello = workloadSchema.parse({
  name: 'mod-hello',
  tier: 'module',
  source: { kind: 'release', tarball: `/var/lib/ee/modules/hello/${'b'.repeat(64)}.tar.gz`, sha256: 'b'.repeat(64) },
  secrets: ['STRIPE_API_KEY'],
  contract: { runtime: 'node', node: '22', start: ['node', 'index.mjs'] },
  module: {
    id: 'hello',
    version: '0.1.0',
    commit: 'c1'.repeat(20),
    manifest: manifest as unknown as Record<string, unknown>,
    receipt: {},
    desired: 'running',
  },
})

/** A JSON answer, read loosely by the assertions. */
type Answer = { [key: string]: Answer } & { modules: { id: string }[]; module: unknown; type: string; detail: string }

async function start(workloads = [hello]) {
  const sys = new ModuleBox()
  sys.files.set(PATHS.masterKey, randomBytes(32).toString('base64'))
  const ee = new Ee(sys, await SecretStore.open(sys))
  ee.journal = emptyJournal()
  const desired: DesiredState = { rev: 'r1', workloads, routes: [], settings: settingsSchema.parse({ consoleHost: 'os.example.com' }) }
  vi.spyOn(ee.repo, 'read').mockResolvedValue(desired)
  dir = await mkdtemp(join(tmpdir(), 'ee-mod-'))
  const socketPath = join(dir, 'ee.sock')
  server = createServer(controlHandler(ee))
  await new Promise<void>((r) => server!.listen(socketPath, r))
  const call = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; data: Answer }>((resolve, reject) => {
      const text = body === undefined ? '' : JSON.stringify(body)
      const req = request({ socketPath, path, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } }, (res) => {
        let raw = ''
        res.on('data', (d) => (raw += String(d)))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : null }))
      })
      req.on('error', reject)
      req.end(text)
    })
  return { ee, sys, call }
}

describe('control API: /v1/modules', () => {
  it('is mounted: list, get, a missing module is 404 urn:ee:module_not_found, a bad body is 400', async () => {
    const { call } = await start()
    const list = await call('GET', '/v1/modules')
    expect(list.status).toBe(200)
    expect(list.data.modules.map((m: { id: string }) => m.id)).toEqual(['hello'])
    expect((await call('GET', '/v1/modules/hello')).data.module).toMatchObject({ id: 'hello', workload: 'mod-hello', state: 'starting' })
    const missing = await call('GET', '/v1/modules/nope')
    expect([missing.status, missing.data.type]).toEqual([404, 'urn:ee:module_not_found'])
    const bad = await call('POST', '/v1/modules', { id: 'hello' })
    expect([bad.status, bad.data.type]).toEqual([400, 'urn:ee:invalid_input'])
    const stopBad = await call('POST', '/v1/modules/hello/stop', { author: 'x' })
    expect([stopBad.status, stopBad.data.type]).toEqual([400, 'urn:ee:invalid_input'])
  })
})

describe('control API: POST /v1/secrets for a module', () => {
  it('refuses a name the receipted manifest does not declare: 403 urn:ee:secret_undeclared, nothing stored', async () => {
    const { ee, call } = await start()
    const r = await call('POST', '/v1/secrets', { workload: 'mod-hello', name: 'AWS_SECRET_ACCESS_KEY', value: 'shh-very-secret', author: 'user:ada' })
    expect(r.status).toBe(403)
    expect(r.data.type).toBe('urn:ee:secret_undeclared')
    expect(r.data.detail).toContain('does not declare the secret AWS_SECRET_ACCESS_KEY')
    expect(JSON.stringify(r.data)).not.toContain('shh-very-secret')
    expect(ee.secrets.all()['mod-hello']).toBeUndefined()
  })

  it('refuses everything when the stored manifest does not parse (fails closed)', async () => {
    const broken = { ...hello, module: { ...hello.module!, manifest: { permissions: { secrets: ['STRIPE_API_KEY'] } } } }
    const { call } = await start([broken])
    const r = await call('POST', '/v1/secrets', { workload: 'mod-hello', name: 'STRIPE_API_KEY', value: 'sk_test_1', author: 'user:ada' })
    expect(r.status).toBe(403)
  })

  it('stores a declared one', async () => {
    const { ee, call } = await start()
    vi.spyOn(ee, 'reconcile').mockResolvedValue(undefined as never)
    const r = await call('POST', '/v1/secrets', { workload: 'mod-hello', name: 'STRIPE_API_KEY', value: 'sk_test_1', author: 'user:ada' })
    expect(r.status).toBe(200)
    expect(ee.secrets.all()['mod-hello']).toEqual({ STRIPE_API_KEY: 'sk_test_1' })
  })
})
