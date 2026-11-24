import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBundle, sha256Hex } from '../../contracts/module-bundle.ts'
import { manifestSha256, parseModuleManifestYaml, type ModuleManifestV1 } from '../../contracts/module-manifest.ts'
import { signReceipt, type ModuleReceiptV1 } from '../../contracts/module-receipt.ts'
import { MODULE_UNIT_ENV, moduleViewSchema, type ModuleView } from '../../contracts/module-workload.ts'
import type { DesiredState } from './company-repo.ts'
import { emptyJournal, type Journal } from './journal.ts'
import { ModuleBox } from './module-test-box.ts'
import {
  MODULE_TOKEN_SCOPE,
  ModuleError,
  ModuleService,
  isModuleWorkload,
  moduleEnvFile,
  moduleSecretRefusal,
  moduleWorkload,
  reconcileModules,
  socketDirOf,
  storedBundlePath,
  verifyModule,
  type ModuleCandidate,
} from './modules.ts'
import { NO_HUB_KEY_MESSAGE } from './hub-key.ts'
import { PATHS } from './paths.ts'
import type { SecretMap } from './secrets.ts'
import { settingsSchema } from './company-repo.ts'

const HELLO_DIR = join(import.meta.dirname, '../../contracts/fixtures/modules/hello')
const HUB = 'https://hub.test'
const COMMIT_1 = 'c1'.repeat(20)
const COMMIT_2 = 'c2'.repeat(20)
const TOKEN_1 = 'a1'.repeat(32)
const TOKEN_2 = 'a2'.repeat(32)
const UNIT = 'ee-mod-hello.service'

/** A hub key made for this test run (the repo's public test key is refused by ee, hub-key.ts). */
function hubKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}
const KEY = hubKey()
const OTHER_KEY = hubKey()

function helloFiles(extra: Record<string, string> = {}) {
  const names = ['LICENSE', 'index.mjs', 'module.yaml', 'package.json', 'test.mjs']
  const files = names.map((n) => ({ path: n, content: new Uint8Array(readFileSync(join(HELLO_DIR, n))) }))
  for (const [path, text] of Object.entries(extra)) files.push({ path, content: new Uint8Array(Buffer.from(text)) })
  return files
}

const helloManifest = (): ModuleManifestV1 => parseModuleManifestYaml(readFileSync(join(HELLO_DIR, 'module.yaml'), 'utf8'))

/** What the kernel sends: the bundle, its receipt (signed by the hub) and the deploy body. */
function release(opts: { commit?: string; token?: string; key?: typeof KEY; manifest?: ModuleManifestV1; extra?: Record<string, string> } = {}) {
  const commit = opts.commit ?? COMMIT_1
  const manifest = opts.manifest ?? helloManifest()
  const bundle = createBundle(helloFiles(opts.extra), new Date('2026-11-24T09:00:00Z'))
  const receipt = signReceipt(
    {
      hub: HUB,
      installId: 'install-1',
      moduleId: 'hello',
      version: manifest.version,
      commit,
      bundleSha256: bundle.sha256,
      manifestSha256: manifestSha256(manifest),
      coreApi: '1.0.0',
      license: 'Apache-2.0',
      deprecatedUses: [],
      issuedAt: '2026-11-24T09:30:00.000Z',
    },
    (opts.key ?? KEY).pkcs8,
  )
  const body = {
    id: 'hello',
    version: manifest.version,
    commit,
    manifest: manifest as unknown as Record<string, unknown>,
    receipt: receipt as unknown as Record<string, unknown>,
    tarball: `hello-${bundle.sha256.slice(0, 12)}.tar.gz`,
    sha256: bundle.sha256,
    token: opts.token ?? TOKEN_1,
    author: 'user:ada',
  }
  return { bundle, receipt, body }
}

function settings(moduleHub = { origin: HUB, publicKeys: [KEY.spki] }) {
  return settingsSchema.parse({ consoleHost: 'os.example.com', contributeHub: 'off', moduleHub })
}

class Secrets {
  data: SecretMap = {}
  all() {
    return this.data
  }
  async set(w: string, n: string, v: string) {
    this.data = { ...this.data, [w]: { ...(this.data[w] ?? {}), [n]: v } }
  }
}

function setup(opts: { moduleHub?: { origin: string; publicKeys: string[] } } = {}) {
  const box = new ModuleBox()
  const journal: Journal = emptyJournal()
  const secrets = new Secrets()
  let desired: DesiredState = { rev: 'r0', workloads: [], routes: [], settings: settings(opts.moduleHub) }
  let revs = 0
  const ctx = { sys: box, journal, secrets }
  // The kernel has opened the module's socket directory.
  box.files.set(`${socketDirOf('hello')}/kernel.sock`, '')
  const reconcile = () => reconcileModules(ctx, desired, box)
  const svc = new ModuleService({
    sys: box,
    repo: { read: async () => desired },
    secrets,
    journal: () => journal,
    emit: async (type, workload, message, data) => void journal.events.push({ id: String(journal.events.length), time: box.now().toISOString(), type, workload, message, data }),
    change: async (_message, _author, mutate) => {
      const next = mutate({ workloads: desired.workloads, routes: desired.routes, settings: desired.settings })
      desired = { rev: `r${++revs}`, ...next }
      const errors = await reconcile()
      return { rev: desired.rev, reconcileError: errors.length ? errors.join('\n') : null }
    },
    exclusive: (fn) => fn(),
    io: box,
  })
  /** The kernel writes the bundle into its hand-off dir. */
  const handOff = (r: ReturnType<typeof release>) => {
    box.bytes.set(`${PATHS.moduleHandoff}/${r.body.tarball}`, r.bundle.bytes)
    return r.body
  }
  const deploy = async (r: ReturnType<typeof release>) => {
    const answer = await svc.deploy(handOff(r))
    await svc.settled()
    return answer
  }
  return {
    box,
    journal,
    secrets,
    svc,
    reconcile,
    handOff,
    deploy,
    desired: () => desired,
    setDesired: (d: DesiredState) => void (desired = d),
    events: (type?: string) => journal.events.filter((e) => !type || e.type === type),
  }
}

const prop = (cmd: string[], name: string) => cmd.filter((a, i) => cmd[i - 1] === '-p' && a.startsWith(`${name}=`)).map((a) => a.slice(name.length + 1))
const view = (v: unknown): ModuleView => moduleViewSchema.parse(v)

async function problem(p: Promise<unknown>): Promise<ModuleError> {
  try {
    await p
  } catch (err) {
    if (err instanceof ModuleError) return err
    throw err
  }
  throw new Error('expected a ModuleError')
}

describe('verifyModule: §6.4, all of it, naming the first failure', () => {
  const candidate = (r = release()): ModuleCandidate => ({ ...r.body, bytes: r.bundle.bytes })

  it('a receipted hello checks out', () => {
    const v = verifyModule(candidate(), [KEY.spki])
    expect(v.ok).toBe(true)
  })

  it('a tampered tarball: its sha256 is not the pinned one', () => {
    const c = candidate()
    const bytes = Buffer.from(c.bytes)
    bytes[bytes.length - 20]! ^= 0xff
    expect(verifyModule({ ...c, bytes }, [KEY.spki])).toEqual({ ok: false, problem: expect.stringMatching(/^the bundle's sha256 is [0-9a-f]{64}, not /) })
  })

  it('a swapped tarball with its own sha256: the receipt pins another bundle', () => {
    const c = candidate()
    const other = createBundle(helloFiles({ 'extra.txt': 'more' }), new Date('2026-11-24T09:00:00Z'))
    expect(verifyModule({ ...c, bytes: other.bytes, sha256: other.sha256 }, [KEY.spki])).toEqual({ ok: false, problem: `the receipt pins bundle ${c.sha256}, not ${other.sha256}` })
  })

  it('a tampered receipt: the signature does not verify', () => {
    const c = candidate()
    const receipt = { ...(c.receipt as ModuleReceiptV1), deprecatedUses: ['contacts.get'] }
    expect(verifyModule({ ...c, receipt }, [KEY.spki])).toEqual({ ok: false, problem: 'receipt signature does not verify under its hub key' })
  })

  it('a tampered manifest: the receipt pins another manifest', () => {
    const c = candidate()
    const manifest = { ...(c.manifest as ModuleManifestV1), description: 'Now also reads every contact.' }
    expect(verifyModule({ ...c, manifest }, [KEY.spki]).ok).toBe(false)
    expect((verifyModule({ ...c, manifest }, [KEY.spki]) as { problem: string }).problem).toMatch(/^the receipt pins manifest [0-9a-f]{64}, not [0-9a-f]{64}$/)
  })

  it('a manifest that does not parse, or that is another licence', () => {
    const c = candidate()
    const v = verifyModule({ ...c, manifest: { ...(c.manifest as object), license: 'MIT' } }, [KEY.spki])
    expect(v).toEqual({ ok: false, problem: expect.stringMatching(/^the manifest does not parse: license: /) })
  })

  it('a receipt signed by a key ee does not trust', () => {
    const r = release({ key: OTHER_KEY })
    expect(verifyModule({ ...r.body, bytes: r.bundle.bytes }, [KEY.spki])).toEqual({ ok: false, problem: expect.stringMatching(/^receipt key [0-9a-f]{16} is not a trusted hub key$/) })
  })

  it('a receipt for another id, commit or version', () => {
    const c = candidate()
    expect(verifyModule({ ...c, commit: COMMIT_2 }, [KEY.spki])).toEqual({ ok: false, problem: `the receipt is for commit ${COMMIT_1}, not ${COMMIT_2}` })
    expect(verifyModule({ ...c, id: 'howdy' }, [KEY.spki])).toEqual({ ok: false, problem: 'the receipt is for module hello, not howdy' })
    expect(verifyModule({ ...c, version: '0.2.0' }, [KEY.spki])).toEqual({ ok: false, problem: 'the receipt is for version 0.1.0, not 0.2.0' })
  })

  it('bytes that are not a bundle, even when sha256 and receipt match them', () => {
    const bytes = Buffer.from('not a tarball')
    const r = release()
    const manifest = r.body.manifest
    const receipt = signReceipt({ ...(({ v: _v, kind: _k, keyId: _id, signature: _s, ...f }) => f)(r.receipt), bundleSha256: sha256Hex(bytes) }, KEY.pkcs8)
    const v = verifyModule({ ...r.body, manifest, receipt, sha256: sha256Hex(bytes), bytes }, [KEY.spki])
    expect(v).toEqual({ ok: false, problem: expect.stringMatching(/^module bundle is not valid: not a readable gzip/) })
  })

  it('a secret may not take a name the unit sets (EE_MODULE_TOKEN, PATH, DATABASE_URL …)', () => {
    const manifest = { ...helloManifest(), permissions: { ...helloManifest().permissions, secrets: ['DATABASE_URL'] } }
    const r = release({ manifest })
    expect(verifyModule({ ...r.body, bytes: r.bundle.bytes }, [KEY.spki])).toEqual({
      ok: false,
      problem: 'permissions.secrets may not name DATABASE_URL (ee sets or withholds those itself)',
    })
  })
})

describe('POST /v1/modules: deploy hello', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('answers 202 building, then builds, tests and runs it as ee-mod-hello', async () => {
    const r = release()
    const answer = await t.svc.deploy(t.handOff(r))
    expect(answer.status).toBe(202)
    expect(view((answer.data as { module: unknown }).module)).toMatchObject({ id: 'hello', workload: 'mod-hello', state: 'building', commit: COMMIT_1, desired: 'running' })
    await t.svc.settled()
    const v = view(await t.svc.get('hello'))
    expect(v).toMatchObject({ state: 'running', error: null, version: '0.1.0', commit: COMMIT_1, bundleSha256: r.bundle.sha256, releases: [{ commit: COMMIT_1, bundleSha256: r.bundle.sha256 }] })
    expect(t.box.units.get(UNIT)).toBe('active')
    expect(t.events().map((e) => e.type)).toEqual(['module.deploying', 'module.built', 'module.running'])
  })

  it('takes the bundle from the hand-off dir into its own store (root, 0600) and deletes the hand-off', async () => {
    const r = release()
    await t.deploy(r)
    const handoff = `${PATHS.moduleHandoff}/${r.body.tarball}`
    const stored = storedBundlePath('hello', r.bundle.sha256)
    expect(stored).toBe(`/var/lib/ee/modules/hello/${r.bundle.sha256}.tar.gz`)
    expect(t.box.bytes.has(handoff)).toBe(false)
    expect(t.box.bytes.get(stored)).toEqual(r.bundle.bytes)
    const incoming = t.box.ran('cp')[0]!
    expect(incoming.slice(0, 4)).toEqual(['cp', '--no-dereference', '--', handoff])
    expect(t.box.ran('chmod')).toContainEqual(['chmod', '600', incoming[4]!])
    expect(t.box.ran('chown')).toContainEqual(['chown', 'root:root', incoming[4]!])
  })

  it('writes workloads/mod-hello.json: tier module, a release source, the derived contract and the module field', async () => {
    const r = release()
    await t.deploy(r)
    const w = t.desired().workloads.find((x) => x.name === 'mod-hello')!
    expect(isModuleWorkload(w)).toBe(true)
    expect(w).toMatchObject({
      tier: 'module',
      source: { kind: 'release', tarball: storedBundlePath('hello', r.bundle.sha256), sha256: r.bundle.sha256 },
      env: {},
      secrets: [],
      resources: { memoryMb: 64, cpuPercent: 10 },
      contract: { runtime: 'node', node: '22', build: [], start: ['node', 'index.mjs'], services: [], capabilities: [] },
      module: { id: 'hello', version: '0.1.0', commit: COMMIT_1, desired: 'running', stopReason: null, sentence: null, receipt: r.body.receipt, manifest: r.body.manifest },
    })
  })

  it('runs the tests in a second unit as ee-build: no network, no env file, the module memory, 10 minutes at most', async () => {
    await t.deploy(release())
    const test = t.box.ran('systemd-run').find((c) => c.some((a) => a.startsWith('--unit=ee-mod-test-hello-')))!
    expect(test).toContain('--wait')
    expect(prop(test, 'User')).toEqual(['ee-build'])
    expect(prop(test, 'PrivateNetwork')).toEqual(['yes'])
    expect(prop(test, 'IPAddressDeny')).toEqual(['any'])
    expect(prop(test, 'RestrictAddressFamilies')).toEqual(['AF_UNIX'])
    expect(prop(test, 'EnvironmentFile')).toEqual([])
    expect(prop(test, 'MemoryMax')).toEqual(['64M'])
    expect(Number(prop(test, 'RuntimeMaxSec')[0])).toBeLessThanOrEqual(600)
    expect(test.filter((a, i) => test[i - 1] === '-E').some((e) => e.startsWith('EE_MODULE_TOKEN'))).toBe(false)
    expect(test.slice(-2)).toEqual(['/opt/ee/runtimes/node-22/bin/node', 'test.mjs'])
    // On a scratch copy owned by ee-build, removed after.
    const scratch = prop(test, 'BindPaths')[0]!
    expect(scratch).toMatch(/^\/var\/lib\/ee\/workloads\/mod-hello\/test-/)
    expect(t.box.ran('chown')).toContainEqual(['chown', '-R', 'ee-build:ee-build', scratch])
    expect(await t.box.exists(scratch)).toBe(false)
  })

  it('renders the run unit and an env file with exactly the token (and declared secrets that have a value)', async () => {
    await t.deploy(release())
    const unit = t.box.files.get(`/etc/systemd/system/${UNIT}`)!
    expect(unit).toContain('User=ee-mod-hello')
    expect(unit).toContain(`BindPaths=${socketDirOf('hello')}:/run/ee-module`)
    expect(t.box.files.get(moduleEnvFile('hello'))).toBe(`EE_MODULE_TOKEN="${TOKEN_1}"\n`)
    expect(t.secrets.data[MODULE_TOKEN_SCOPE]).toEqual({ hello: TOKEN_1 })
    // The module only traverses the kernel's socket dir.
    expect(t.box.ran('chmod')).toContainEqual(['chmod', '711', socketDirOf('hello')])
  })

  it.each([
    ['a tampered tarball', (r: ReturnType<typeof release>) => ({ ...r, bundle: { ...r.bundle, bytes: Buffer.concat([r.bundle.bytes, Buffer.from('x')]) } }), /^the bundle's sha256 is/],
    ['a tampered receipt', (r: ReturnType<typeof release>) => ({ ...r, body: { ...r.body, receipt: { ...r.body.receipt, installId: 'someone-else' } } }), /^receipt signature does not verify/],
    ['a tampered manifest', (r: ReturnType<typeof release>) => ({ ...r, body: { ...r.body, manifest: { ...r.body.manifest, name: 'Hijack' } } }), /^the receipt pins manifest/],
    ['an untrusted key', () => release({ key: OTHER_KEY }), /is not a trusted hub key$/],
  ])('%s: 422 urn:ee:receipt_invalid, no unit, nothing desired, nothing kept', async (_what, tamper, detail) => {
    const r = tamper(release())
    const err = await problem(t.svc.deploy(t.handOff(r)))
    expect(err.status).toBe(422)
    expect(err.type).toBe('urn:ee:receipt_invalid')
    expect(err.message).toMatch(detail)
    await t.svc.settled()
    expect(t.box.files.has(`/etc/systemd/system/${UNIT}`)).toBe(false)
    expect(t.box.ran('systemd-run')).toEqual([])
    expect(t.desired().workloads).toEqual([])
    expect([...t.box.bytes.keys()]).toEqual([])
  })

  it('no hub key at all (the official hub, none embedded yet): 422, saying so', async () => {
    t = setup({ moduleHub: { origin: 'https://os.cerberusblue.com', publicKeys: [] } })
    const err = await problem(t.svc.deploy(t.handOff(release())))
    expect([err.status, err.type, err.message]).toEqual([422, 'urn:ee:receipt_invalid', NO_HUB_KEY_MESSAGE])
  })

  it('a capability the catalog lacks: 422 urn:ee:catalog_gap naming it', async () => {
    const manifest = { ...helloManifest(), permissions: { ...helloManifest().permissions, capabilities: ['teleport'] } }
    const err = await problem(t.svc.deploy(t.handOff(release({ manifest }))))
    expect(err.status).toBe(422)
    expect(err.type).toBe('urn:ee:catalog_gap')
    expect(err.extra).toEqual({ missing: ['capability teleport'] })
  })

  it('a second deploy while one builds or tests: 409 urn:ee:module_busy', async () => {
    let release1!: () => void
    t.box.duringTest = () => new Promise<void>((r) => (release1 = r))
    await t.svc.deploy(t.handOff(release()))
    await new Promise((r) => setTimeout(r, 0))
    expect(view(await t.svc.get('hello')).state).toBe('testing')
    const err = await problem(t.svc.deploy(t.handOff(release({ commit: COMMIT_2 }))))
    expect([err.status, err.type]).toEqual([409, 'urn:ee:module_busy'])
    release1()
    await t.svc.settled()
    expect(view(await t.svc.get('hello')).state).toBe('running')
  })

  it('a failing test leaves the previous release live (no restart, desired state unchanged)', async () => {
    await t.deploy(release())
    const restarts = t.box.ran('systemctl').filter((c) => c[1] === 'restart').length
    t.box.testExit = 1
    t.box.testOutput = 'AssertionError: expected Hello, Ada!'
    const r2 = release({ commit: COMMIT_2, token: TOKEN_2, extra: { 'NOTES.md': 'v2' } })
    await t.deploy(r2)
    const v = view(await t.svc.get('hello'))
    expect(v).toMatchObject({ state: 'running', commit: COMMIT_1 })
    expect(v.error).toBe(`Module hello ${COMMIT_2.slice(0, 12)} failed its tests (\`node test.mjs\` exited 1); the previous release keeps running.`)
    expect(t.box.ran('systemctl').filter((c) => c[1] === 'restart').length).toBe(restarts)
    expect(t.box.units.get(UNIT)).toBe('active')
    expect(t.desired().workloads[0]!.module!.commit).toBe(COMMIT_1)
    expect(t.secrets.data[MODULE_TOKEN_SCOPE]).toEqual({ hello: TOKEN_1 })
    expect(t.events('module.test_failed')).toHaveLength(1)
    expect(t.box.bytes.has(storedBundlePath('hello', r2.bundle.sha256))).toBe(false)
    // The test output is in the deploy record's log.
    expect(t.events('module.test_failed')[0]!.data['logs']).toContain('AssertionError')
  })

  it('a new commit that tests green replaces the running one, stop-then-start, and keeps the last releases', async () => {
    const r1 = release()
    await t.deploy(r1)
    const r2 = release({ commit: COMMIT_2, token: TOKEN_2, extra: { 'NOTES.md': 'v2' } })
    await t.deploy(r2)
    const v = view(await t.svc.get('hello'))
    expect(v).toMatchObject({ state: 'running', commit: COMMIT_2 })
    expect(v.releases).toEqual([
      { commit: COMMIT_2, bundleSha256: r2.bundle.sha256 },
      { commit: COMMIT_1, bundleSha256: r1.bundle.sha256 },
    ])
    expect(t.box.files.get(moduleEnvFile('hello'))).toBe(`EE_MODULE_TOKEN="${TOKEN_2}"\n`)
    expect(t.box.files.get(`/etc/systemd/system/${UNIT}`)).toContain(`EE_MODULE_COMMIT=${COMMIT_2}`)
  })

  it('dryRun builds and tests only: 200 { passed, log }, nothing deployed', async () => {
    const r = release()
    const answer = await t.svc.deploy({ ...t.handOff(r), dryRun: true })
    expect(answer.status).toBe(200)
    expect(answer.data).toEqual({ passed: true, log: expect.stringContaining('$ node test.mjs\nok hello') })
    expect(t.desired().workloads).toEqual([])
    expect(t.box.files.has(`/etc/systemd/system/${UNIT}`)).toBe(false)
    t.box.testExit = 1
    const failed = await t.svc.deploy({ ...t.handOff(r), dryRun: true })
    expect(failed.data).toMatchObject({ passed: false })
  })
})

describe('the module path of every reconcile', () => {
  it('checks the receipt again: a tampered desired state stops the module, journaled once', async () => {
    const t = setup()
    await t.deploy(release())
    const d = t.desired()
    const w = d.workloads[0]!
    t.setDesired({ ...d, workloads: [{ ...w, module: { ...w.module!, manifest: { ...w.module!.manifest, description: 'tampered in the company repo' } } }] })
    const errors = await t.reconcile()
    expect(errors[0]).toMatch(/receipt does not check out: the receipt pins manifest/)
    expect(t.box.units.get(UNIT)).toBe('inactive')
    expect(view(await t.svc.get('hello'))).toMatchObject({ state: 'failed', error: expect.stringMatching(/^Module hello is stopped because its receipt does not check out/) })
    await t.reconcile()
    expect(t.events('module.failed')).toHaveLength(1)
  })

  it('a bundle missing from the store (a restore without it) is a loud failure, not a silent skip', async () => {
    const t = setup()
    const r = release()
    await t.deploy(r)
    t.box.bytes.delete(storedBundlePath('hello', r.bundle.sha256))
    const errors = await t.reconcile()
    expect(errors[0]).toMatch(/its bundle .* is missing from ee's store/)
    expect(t.box.units.get(UNIT)).toBe('inactive')
  })

  it('comes back after a reboot: the env file is written again and the module started behind the gate', async () => {
    const t = setup()
    await t.deploy(release())
    // Reboot: /run is empty, nothing runs (module units are not enabled; ee starts them).
    t.box.units.clear()
    t.box.files.delete(moduleEnvFile('hello'))
    expect(await t.reconcile()).toEqual([])
    expect(t.box.units.get(UNIT)).toBe('active')
    expect(t.box.files.get(moduleEnvFile('hello'))).toBe(`EE_MODULE_TOKEN="${TOKEN_1}"\n`)
    expect(t.events('module.running')).toHaveLength(2)
    expect(t.box.ran('systemctl').some((c) => c[1] === 'enable')).toBe(false)
  })

  it('a running module with nothing changed is left alone', async () => {
    const t = setup()
    await t.deploy(release())
    const before = t.box.commands.length
    await t.reconcile()
    expect(t.box.commands.slice(before).filter((c) => c[0] === 'systemctl' && ['restart', 'stop', 'start'].includes(c[1]!))).toEqual([])
  })

  it('a module that crashes on start fails the gate: stopped, failed, journaled, and not retried every tick', async () => {
    const t = setup()
    t.box.crash = true
    await t.deploy(release())
    expect(view(await t.svc.get('hello'))).toMatchObject({ state: 'failed', error: expect.stringMatching(/^Module hello crashed on start/) })
    expect(t.events('module.failed')).toHaveLength(1)
    const restarts = () => t.box.ran('systemctl').filter((c) => c[1] === 'restart').length
    const n = restarts()
    await t.reconcile()
    expect(restarts()).toBe(n)
    // A start (an admin's activate) retries the same commit.
    t.box.crash = false
    const started = await t.svc.start('hello', { author: 'user:admin' })
    expect(view(started).state).toBe('running')
  })

  it('a module whose kernel socket dir does not exist yet fails loud', async () => {
    const t = setup()
    t.box.files.delete(`${socketDirOf('hello')}/kernel.sock`)
    await t.deploy(release())
    expect(view(await t.svc.get('hello')).error).toMatch(/has not opened its socket directory/)
  })
})

describe('stop, start, logs, remove', () => {
  it("stop (a person's off): the unit stops, the view says why; start brings it back", async () => {
    const t = setup()
    await t.deploy(release())
    const stopped = view(await t.svc.stop('hello', { author: 'user:ada', reason: 'person', sentence: 'Ada switched Hello off.' }))
    expect(stopped).toMatchObject({ desired: 'stopped', stopReason: 'person', state: 'stopped', error: 'Ada switched Hello off.' })
    expect(t.box.units.get(UNIT)).toBe('inactive')
    expect(t.events('module.stopped')).toHaveLength(1)
    // Stays off across reconciles (and reboots: desired state is in the company repo).
    t.box.units.clear()
    await t.reconcile()
    expect(t.box.units.get(UNIT) ?? 'inactive').toBe('inactive')
    const started = view(await t.svc.start('hello', { author: 'user:ada' }))
    expect(started).toMatchObject({ desired: 'running', stopReason: null, state: 'running', error: null })
  })

  it('logs: the unit journal, with secret values masked', async () => {
    const t = setup()
    await t.deploy(release())
    t.box.journals.set(UNIT, [`2026-11-24T10:00:00Z hello: token ${TOKEN_1}`, '2026-11-24T10:00:01Z hello: ready'])
    const { lines } = await t.svc.logs('hello', { lines: '50' })
    expect(lines).toEqual(['2026-11-24T10:00:00Z hello: token ••••••', '2026-11-24T10:00:01Z hello: ready'])
    expect(t.box.ran('journalctl').at(-1)).toEqual(['journalctl', '-u', UNIT, '-n', '50', '--no-pager', '-o', 'short-iso'])
  })

  it('remove: stopped, unit and ee copies gone, journaled; then 404', async () => {
    const t = setup()
    const r = release()
    await t.deploy(r)
    const removed = view(await t.svc.remove('hello', { author: 'user:ada' }))
    expect(removed).toMatchObject({ state: 'stopped', desired: 'stopped' })
    expect(t.desired().workloads).toEqual([])
    expect(t.box.files.has(`/etc/systemd/system/${UNIT}`)).toBe(false)
    expect(t.box.bytes.has(storedBundlePath('hello', r.bundle.sha256))).toBe(false)
    expect(t.events('module.removed')).toHaveLength(1)
    const err = await problem(t.svc.get('hello'))
    expect([err.status, err.type]).toEqual([404, 'urn:ee:module_not_found'])
  })

  it('every answer is a ModuleView of the contract', async () => {
    const t = setup()
    await t.deploy(release())
    for (const v of await t.svc.list()) view(v)
    expect((await t.svc.list()).map((v) => v.id)).toEqual(['hello'])
  })
})

describe('POST /v1/secrets for a module: only declared names', () => {
  it('refuses an undeclared name with 403 urn:ee:secret_undeclared, allows a declared one', () => {
    const r = release({ manifest: { ...helloManifest(), permissions: { ...helloManifest().permissions, secrets: ['STRIPE_API_KEY'] } } })
    const w = moduleWorkload(r.body, parseModuleManifestYaml(readFileSync(join(HELLO_DIR, 'module.yaml'), 'utf8').replace('secrets: []', 'secrets: [STRIPE_API_KEY]')))
    expect(moduleSecretRefusal(w, 'STRIPE_API_KEY')).toBeNull()
    expect(moduleSecretRefusal(w, 'AWS_SECRET')).toEqual({
      type: 'urn:ee:secret_undeclared',
      title: 'secret not declared',
      detail: expect.stringContaining('module hello does not declare the secret AWS_SECRET (permissions.secrets: STRIPE_API_KEY)'),
    })
  })

  it('a declared secret that has a value reaches the env file; an unset one is simply absent', async () => {
    const t = setup()
    const manifest = { ...helloManifest(), permissions: { ...helloManifest().permissions, secrets: ['STRIPE_API_KEY', 'OTHER_KEY'] } }
    await t.deploy(release({ manifest }))
    await t.secrets.set('mod-hello', 'STRIPE_API_KEY', 'sk_live_xyz')
    await t.reconcile()
    expect(t.box.files.get(moduleEnvFile('hello'))).toBe(`EE_MODULE_TOKEN="${TOKEN_1}"\nSTRIPE_API_KEY="sk_live_xyz"\n`)
  })
})

describe('the module env is exactly the contract', () => {
  it('MODULE_UNIT_ENV plus HOME, nothing else', async () => {
    const t = setup()
    await t.deploy(release())
    const unit = t.box.files.get(`/etc/systemd/system/${UNIT}`)!
    const names = [...unit.matchAll(/^Environment="([A-Z_]+)=/gm)].map((m) => m[1])
    expect(names.sort()).toEqual([...MODULE_UNIT_ENV, 'HOME'].sort())
  })
})
