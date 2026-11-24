import type { SecretMap } from '../src/secrets.ts'
/**
 * The module workload checks on a real systemd box (plan/phase-upgrades-u2.md §9
 * Stream B "Done when"). Bundled by `ee/e2e/box.sh module-check` and run as root
 * INSIDE a throwaway box container — never on a real server. It drives ee's own
 * code (modules.ts, units.ts, RealSystem) against systemd, with an in-process
 * stand-in for the kernel's module socket and a hub key made for this run.
 *
 * Prints one line per check and exits 1 if any failed.
 */
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { createBundle, type BundleFile } from '../../contracts/module-bundle.ts'
import { manifestSha256, parseModuleManifestYaml, type ModuleManifestV1 } from '../../contracts/module-manifest.ts'
import { signReceipt, type ModuleReceiptV1 } from '../../contracts/module-receipt.ts'
import { MODULE_TOKEN_ENV, MODULE_UNIT_ENV } from '../../contracts/module-workload.ts'
import { settingsSchema, type DesiredState } from '../src/company-repo.ts'
import { emptyJournal } from '../src/journal.ts'
import { ModuleError, ModuleService, moduleEnvFile, reconcileModules, socketDirOf } from '../src/modules.ts'
import { PATHS } from '../src/paths.ts'
import { workloadSchema } from '../src/spec.ts'
import { RealSystem } from '../src/system.ts'
import { renderUnit } from '../src/units.ts'

const HELLO = process.argv[2] ?? '/check/hello'
const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail })
  console.info(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sh = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim()
  } catch (err) {
    return `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`.trim()
  }
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const KEY = { spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }
const hex = (c: string, n = 64) => c.repeat(n)
const rev = (c: string) => hex(c, 40)

const helloManifest = parseModuleManifestYaml(readFileSync(join(HELLO, 'module.yaml'), 'utf8'))
const helloFiles = (): BundleFile[] =>
  ['LICENSE', 'index.mjs', 'module.yaml', 'package.json', 'test.mjs'].map((n) => ({ path: n, content: new Uint8Array(readFileSync(join(HELLO, n))) }))

/** A probe module: reports what it can reach from inside its unit, then stays up. */
const PROBE = `
import { connect } from 'node:net'
import { readdirSync, readFileSync } from 'node:fs'
const tryTcp = (host, port) => new Promise((resolve) => {
  try {
    const s = connect({ host, port })
    s.on('connect', () => { s.destroy(); resolve('connected') })
    s.on('error', (e) => resolve(e.code ?? e.message))
    setTimeout(() => { s.destroy(); resolve('timeout') }, 3000)
  } catch (e) { resolve(e.code ?? e.message) }
})
const tryRead = (p) => { try { return readdirSync(p) } catch (e) { return e.code } }
const tryFile = (p) => { try { readFileSync(p); return 'read' } catch (e) { return e.code } }
const out = {
  tcpOut: await tryTcp('1.1.1.1', 80),
  tcpLoopback: await tryTcp('127.0.0.1', 22),
  osState: tryRead('/var/lib/ee-state/os'),
  eeState: tryRead('/var/lib/ee-state'),
  company: tryRead('/var/lib/ee/company'),
  secrets: tryFile('/var/lib/ee/secrets.enc'),
  masterKey: tryFile('/etc/ee/master.key'),
  run: tryRead('/run'),
  runSystemd: tryRead('/run/systemd'),
  runIncoming: tryRead('/run/systemd/incoming'),
  varLib: tryRead('/var/lib'),
  env: Object.keys(process.env).sort(),
  uid: process.getuid(),
}
console.info('PROBE ' + JSON.stringify(out))
setInterval(() => {}, 60000)
`
/** The probe's test: passes only when it has no network (the test unit's PrivateNetwork + AF_UNIX). */
const PROBE_TEST = `
import { connect } from 'node:net'
const r = await new Promise((resolve) => { try { const s = connect({ host: '1.1.1.1', port: 80 }); s.on('connect', () => resolve('connected')); s.on('error', (e) => resolve(e.code)); setTimeout(() => resolve('timeout'), 3000) } catch (e) { resolve(e.code) } })
console.info('test network: ' + r)
process.exit(r === 'connected' ? 1 : 0)
`

function probeRelease(commit: string) {
  const manifest: ModuleManifestV1 = { ...helloManifest, id: 'probe', name: 'Probe', start: ['node', 'probe.mjs'], test: [['node', 'probe-test.mjs']] }
  const files: BundleFile[] = [
    { path: 'LICENSE', content: new Uint8Array(readFileSync(join(HELLO, 'LICENSE'))) },
    { path: 'module.yaml', content: new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2))) },
    { path: 'package.json', content: new Uint8Array(Buffer.from('{"name":"probe","private":true,"type":"module"}')) },
    { path: 'probe.mjs', content: new Uint8Array(Buffer.from(PROBE)) },
    { path: 'probe-test.mjs', content: new Uint8Array(Buffer.from(PROBE_TEST)) },
  ]
  return release('probe', manifest, files, commit, hex('d'))
}

function release(id: string, manifest: ModuleManifestV1, files: BundleFile[], commit: string, token: string) {
  const bundle = createBundle(files, new Date('2026-11-24T09:00:00Z'))
  const receipt = signReceipt(
    { hub: 'https://hub.test', installId: 'box-check', moduleId: id, version: manifest.version, commit, bundleSha256: bundle.sha256, manifestSha256: manifestSha256(manifest), coreApi: '1.0.0', license: 'Apache-2.0', deprecatedUses: [], issuedAt: '2026-11-24T09:30:00.000Z' },
    KEY.pkcs8,
  )
  const body = { id, version: manifest.version, commit, manifest: manifest as unknown as Record<string, unknown>, receipt: receipt as unknown as Record<string, unknown>, tarball: `${id}-${bundle.sha256.slice(0, 12)}.tar.gz`, sha256: bundle.sha256, token, author: 'box-check' }
  return { bundle, body }
}

/** Stand-in for the kernel's listener on $EE_STATE_DIR/modules/<id>/run/kernel.sock (0666 in a 0700 dir, as the os workload's UMask makes it). */
const hellos: Record<string, unknown>[] = []
function kernelStub(id: string): Server {
  const dir = socketDirOf(id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const sock = join(dir, 'kernel.sock')
  rmSync(sock, { force: true })
  const server = createServer((conn) => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.on('data', (chunk) => {
      buf += chunk
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        if (msg.method === 'hello') hellos.push(msg.params)
        const result = msg.method === 'hello' ? { coreApi: '1.0.0', heartbeatMs: 10000, grants: { background: false, secrets: [] } } : {}
        if (msg.method) conn.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n')
      }
    })
    conn.on('error', () => {})
  })
  server.listen(sock, () => chmodSync(sock, 0o666))
  return server
}

async function main() {
  const sys = new RealSystem()
  const journal = emptyJournal()
  let data: SecretMap = {}
  const secrets = { all: () => data, set: async (w: string, n: string, v: string) => void (data = { ...data, [w]: { ...(data[w] ?? {}), [n]: v } }) }
  let desired: DesiredState = { rev: 'r0', workloads: [], routes: [], settings: settingsSchema.parse({ consoleHost: 'os.ee.test', moduleHub: { origin: 'https://hub.test', publicKeys: [KEY.spki] } }) }
  const ctx = { sys, journal, secrets }
  const svc = new ModuleService({
    sys,
    repo: { read: async () => desired },
    secrets,
    journal: () => journal,
    emit: async (type, workload, message, d) => void journal.events.push({ id: String(journal.events.length), time: new Date().toISOString(), type, workload, message, data: d }),
    change: async (_m, _a, mutate) => {
      desired = { rev: `r${Date.now()}`, ...mutate({ workloads: desired.workloads, routes: desired.routes, settings: desired.settings }) }
      const errors = await reconcileModules(ctx, desired)
      return { rev: desired.rev, reconcileError: errors.length ? errors.join('\n') : null }
    },
    exclusive: (fn) => fn(),
  })
  const handOff = (r: ReturnType<typeof release>) => {
    mkdirSync(PATHS.moduleHandoff, { recursive: true })
    execFileSync('sh', ['-c', `cat > ${PATHS.moduleHandoff}/${r.body.tarball}`], { input: r.bundle.bytes })
    return r.body
  }
  const deploy = async (r: ReturnType<typeof release>) => {
    const answer = await svc.deploy(handOff(r))
    await svc.settled()
    return answer
  }
  const servers = [kernelStub('hello'), kernelStub('probe')]

  // 1. hello runs as ee-mod-hello and reaches the kernel's socket with its token.
  const c1 = rev('1')
  await deploy(release('hello', helloManifest, helloFiles(), c1, hex('a')))
  const v1 = await svc.get('hello')
  check('hello deploys: built, tested (no network), running', v1.state === 'running', `${v1.state}${v1.error ? `: ${v1.error}` : ''}`)
  const pid = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'ee-mod-hello.service'])
  const user = sh('ps', ['-o', 'user=', '-p', pid])
  check('runs as ee-mod-hello', user === 'ee-mod-hello', `ps user: ${user} (pid ${pid})`)
  await new Promise((r) => setTimeout(r, 1500))
  const hello = hellos.find((h) => h['moduleId'] === 'hello')
  check('hello reaches the kernel socket through /run/ee-module with its token and commit', hello?.['token'] === hex('a') && hello?.['commit'] === c1, JSON.stringify(hello ?? null))

  // 2. systemd-analyze security: the module unit vs. an app unit (the existing template).
  const appWorkload = workloadSchema.parse({ name: 'shop', tier: 'app', source: { kind: 'release', tarball: '/r.tgz', sha256: hex('e') } })
  mkdirSync('/var/lib/ee/workloads/shop/r', { recursive: true })
  await sys.writeFile(
    `${PATHS.unitDir}/ee-shop-a.service`,
    renderUnit({ workload: appWorkload, contract: { runtime: 'node', node: '22', start: ['node', 'x.js'], build: [], preStart: [], health: '/', services: [], capabilities: [] }, slot: 'a', port: 4100, releaseDir: '/var/lib/ee/workloads/shop/r' }),
  )
  sh('systemctl', ['daemon-reload'])
  const score = (unit: string) => Number(/Overall exposure level for \S+: ([\d.]+)/.exec(sh('systemd-analyze', ['security', '--no-pager', unit]))?.[1] ?? NaN)
  const mod = score('ee-mod-hello.service')
  const app = score('ee-shop-a.service')
  check('systemd-analyze security: the module unit is at or under the app unit threshold', mod <= app, `module ${mod}, app ${app}`)

  // 3. From inside a module unit: no TCP, no ee state, only /run/ee-module.
  await deploy(probeRelease(rev('2')))
  const vp = await svc.get('probe')
  check('probe deploys (its test passes only without network)', vp.state === 'running', `${vp.state}${vp.error ? `: ${vp.error}` : ''}`)
  await new Promise((r) => setTimeout(r, 4000))
  const line = sh('journalctl', ['-u', 'ee-mod-probe.service', '-o', 'cat', '--no-pager']).split('\n').find((l) => l.startsWith('PROBE '))
  const p = line ? (JSON.parse(line.slice(6)) as Record<string, unknown>) : null
  check('inside the unit, TCP out fails', p !== null && p['tcpOut'] !== 'connected', String(p?.['tcpOut']))
  check('inside the unit, TCP to the box fails', p !== null && p['tcpLoopback'] !== 'connected', String(p?.['tcpLoopback']))
  check('inside the unit, /var/lib/ee-state/os is unreadable', p !== null && typeof p['osState'] === 'string', JSON.stringify(p?.['osState']))
  check('inside the unit, ee state and keys are unreadable', p !== null && [p['company'], p['secrets'], p['masterKey'], p['eeState']].every((x) => typeof x === 'string'), JSON.stringify([p?.['company'], p?.['secrets'], p?.['masterKey'], p?.['eeState']]))
  // systemd always adds its own empty, read-only propagation dir (/run/systemd/incoming) to a unit with a mount namespace.
  const run = JSON.stringify([p?.['run'], p?.['runSystemd'], p?.['runIncoming']])
  const incoming = p?.['runIncoming']
  check(
    "inside the unit, only /run/ee-module is visible under /run (besides systemd's empty or unreadable propagation dir)",
    JSON.stringify([p?.['run'], p?.['runSystemd']]) === '[["ee-module","systemd"],["incoming"]]' && (typeof incoming === 'string' || JSON.stringify(incoming) === '[]'),
    run,
  )
  const SYSTEMD_OWN = ['INVOCATION_ID', 'JOURNAL_STREAM', 'LANG', 'LOGNAME', 'MEMORY_PRESSURE_WATCH', 'MEMORY_PRESSURE_WRITE', 'SYSTEMD_EXEC_PID', 'USER']
  const env = ((p?.['env'] as string[] | undefined) ?? []).filter((k) => !SYSTEMD_OWN.includes(k))
  const want = [...MODULE_UNIT_ENV, MODULE_TOKEN_ENV, 'HOME'].sort()
  check("inside the unit, the env is exactly the module env (+HOME; systemd's own per-service names aside)", JSON.stringify(env) === JSON.stringify(want), JSON.stringify(p?.['env']))

  // 4. Tampered tarball / receipt / manifest / key: 422 and no unit.
  const tampers: [string, (r: ReturnType<typeof release>) => ReturnType<typeof release>][] = [
    ['tarball', (r) => ({ ...r, bundle: { ...r.bundle, bytes: Buffer.concat([r.bundle.bytes, Buffer.from('x')]) } })],
    ['receipt', (r) => ({ ...r, body: { ...r.body, receipt: { ...r.body.receipt, installId: 'other' } } })],
    ['manifest', (r) => ({ ...r, body: { ...r.body, manifest: { ...r.body.manifest, name: 'Ghost!' } } })],
  ]
  for (const [what, tamper] of tampers) {
    const r = tamper(release('ghost', { ...helloManifest, id: 'ghost' }, helloFiles(), rev('3'), hex('b')))
    let status = 0
    try {
      await svc.deploy(handOff(r))
    } catch (err) {
      status = err instanceof ModuleError ? err.status : -1
    }
    await svc.settled()
    const unit = await sys.exists(`${PATHS.unitDir}/ee-mod-ghost.service`)
    check(`a tampered ${what}: 422 and no unit`, status === 422 && !unit, `status ${status}, unit file ${unit}`)
  }
  {
    const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
    const r = release('ghost', { ...helloManifest, id: 'ghost' }, helloFiles(), rev('3'), hex('b'))
    const { v: _v, kind: _k, keyId: _i, signature: _s, ...fields } = r.body.receipt as unknown as ModuleReceiptV1
    const forged = signReceipt(fields, other)
    let status = 0
    try {
      await svc.deploy(handOff({ ...r, body: { ...r.body, receipt: forged as unknown as Record<string, unknown> } }))
    } catch (err) {
      status = err instanceof ModuleError ? err.status : -1
    }
    check('a receipt under an untrusted key: 422 and no unit', status === 422 && !(await sys.exists(`${PATHS.unitDir}/ee-mod-ghost.service`)), `status ${status}`)
  }

  // 5. A failing test leaves the previous release live.
  const pidBefore = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'ee-mod-hello.service'])
  const failing = helloFiles().map((f) => (f.path === 'test.mjs' ? { ...f, content: new Uint8Array(Buffer.from('console.error("deliberately red"); process.exit(1)\n')) } : f))
  await deploy(release('hello', helloManifest, failing, rev('4'), hex('c')))
  const v5 = await svc.get('hello')
  const pidAfter = sh('systemctl', ['show', '-p', 'MainPID', '--value', 'ee-mod-hello.service'])
  check('a failing test leaves the previous release live', v5.state === 'running' && v5.commit === c1 && pidAfter === pidBefore && /failed its tests/.test(v5.error ?? ''), `${v5.state} ${v5.commit.slice(0, 8)} pid ${pidBefore}→${pidAfter}: ${v5.error}`)

  // 6. stop, start, logs.
  await svc.stop('hello', { author: 'box-check', reason: 'person', sentence: 'Stopped by the box check.' })
  const stopped = sh('systemctl', ['is-active', 'ee-mod-hello.service'])
  await svc.start('hello', { author: 'box-check' })
  const started = sh('systemctl', ['is-active', 'ee-mod-hello.service'])
  check('stop and start work', stopped !== 'active' && started === 'active', `after stop: ${stopped}, after start: ${started}`)
  const { lines } = await svc.logs('hello', { lines: '50' })
  check('logs work, with secret values masked', lines.length > 0 && !lines.join('\n').includes(hex('a')), `${lines.length} lines`)

  // 7. Back after a reboot: /run emptied, nothing runs; ee's start-up reconcile brings it back.
  sh('systemctl', ['stop', 'ee-mod-hello.service', 'ee-mod-probe.service'])
  rmSync(moduleEnvFile('hello'), { force: true })
  const errors = await reconcileModules(ctx, desired)
  check('back after a reboot (env file rewritten, started behind the gate)', sh('systemctl', ['is-active', 'ee-mod-hello.service']) === 'active' && errors.length === 0, errors.join('; '))

  // 8. The receipt is checked again on every reconcile.
  desired = { ...desired, workloads: desired.workloads.map((w) => (w.module?.id === 'hello' ? { ...w, module: { ...w.module, manifest: { ...w.module.manifest, description: 'edited in the company repo' } } } : w)) }
  await reconcileModules(ctx, desired)
  check('a tampered desired state stops the module on the next reconcile', sh('systemctl', ['is-active', 'ee-mod-hello.service']) !== 'active', (await svc.get('hello')).error ?? '')

  for (const s of servers) s.close()
  const failed = results.filter((r) => !r.ok)
  console.info(`\n${results.length - failed.length}/${results.length} module checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
