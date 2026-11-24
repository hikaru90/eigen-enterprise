import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readBundle, sha256Hex } from '../../../../../contracts/module-bundle'
import { parseModuleManifest, type ModuleManifestV1 } from '../../../../../contracts/module-manifest'
import { verifyReceipt } from '../../../../../contracts/module-receipt'
import {
  MODULE_BUNDLE_HANDOFF_DIR,
  moduleSocketDir,
  moduleWorkload,
  type DeployModuleRequest,
  type DryRunAnswer,
  type ModuleRunState,
  type ModuleView,
} from '../../../../../contracts/module-workload'
import type { ModuleWorkloadPort } from '../types'

/**
 * TEST ONLY — a stand-in for ee's module verbs (plan/phase-upgrades-u2.md §5,
 * §9 Stream A): it takes the bundle from the kernel's hand-off directory,
 * checks the receipt against the given trusted keys and the bundle's sha256,
 * unpacks it into a temp dir and runs the manifest's `start` as a child
 * process with the §5 env (EE_MODULE_SOCKET pointing at the kernel's real
 * socket, since there is no bind mount here). A dry run runs `test` instead.
 * No sandbox: the real isolation is ee's (stream B).
 */

type Running = {
  view: ModuleView
  manifest: ModuleManifestV1
  dir: string
  token: string
  child: ChildProcess | null
  lines: string[]
}

export class FakeModuleWorkload implements ModuleWorkloadPort {
  readonly modules = new Map<string, Running>()
  /** Every verb called, in order (for assertions). */
  readonly calls: { verb: string; id: string; body?: unknown }[] = []

  constructor(
    private readonly options: {
      /** `$EE_STATE_DIR` of the kernel under test (hand-off dir and sockets). */
      stateDir: string
      /** Hub keys the receipt must verify under (the fixture test key). */
      trustedKeys: readonly string[]
    },
  ) {}

  async deploy(request: DeployModuleRequest & { dryRun?: false }): Promise<ModuleView> {
    this.calls.push({ verb: 'deploy', id: request.id, body: { commit: request.commit } })
    const { dir, manifest } = await this.unpack(request)
    const previous = this.modules.get(request.id)
    if (previous) await this.kill(previous)
    const now = new Date().toISOString()
    const releases = [
      { commit: request.commit, bundleSha256: request.sha256 },
      ...(previous?.view.releases ?? []).filter((r) => r.commit !== request.commit),
    ].slice(0, 3)
    const running: Running = {
      view: {
        id: request.id,
        workload: moduleWorkload(request.id),
        version: request.version,
        commit: request.commit,
        bundleSha256: request.sha256,
        desired: 'running',
        stopReason: null,
        state: 'starting',
        error: null,
        restarts: 0,
        since: now,
        releases,
      },
      manifest,
      dir,
      token: request.token,
      child: null,
      lines: [],
    }
    this.modules.set(request.id, running)
    this.spawn(running)
    return structuredClone(running.view)
  }

  async dryRun(request: DeployModuleRequest & { dryRun: true }): Promise<DryRunAnswer> {
    this.calls.push({ verb: 'dryRun', id: request.id })
    const { dir, manifest } = await this.unpack(request)
    const log: string[] = []
    let passed = true
    for (const argv of manifest.test) {
      const code = await new Promise<number>((resolve) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd: dir, env: { PATH: process.env.PATH ?? '' } })
        child.stdout.on('data', (b: Buffer) => log.push(String(b)))
        child.stderr.on('data', (b: Buffer) => log.push(String(b)))
        child.on('close', (c) => resolve(c ?? 1))
      })
      if (code !== 0) {
        passed = false
        break
      }
    }
    await rm(dir, { recursive: true, force: true })
    return { passed, log: log.join('') }
  }

  async list(): Promise<ModuleView[]> {
    return [...this.modules.values()].map((m) => structuredClone(m.view))
  }

  async get(id: string): Promise<ModuleView | null> {
    const m = this.modules.get(id)
    return m ? structuredClone(m.view) : null
  }

  async stop(id: string, body: { author: string; reason: 'person' | 'failed'; sentence: string }): Promise<ModuleView> {
    this.calls.push({ verb: 'stop', id, body })
    const m = this.require(id)
    await this.kill(m)
    m.view = { ...m.view, desired: 'stopped', stopReason: body.reason, state: 'stopped', error: body.sentence, since: new Date().toISOString() }
    return structuredClone(m.view)
  }

  async start(id: string, body: { author: string }): Promise<ModuleView> {
    this.calls.push({ verb: 'start', id, body })
    const m = this.require(id)
    await this.kill(m)
    m.view = { ...m.view, desired: 'running', stopReason: null, state: 'starting', error: null, restarts: 0 }
    this.spawn(m)
    return structuredClone(m.view)
  }

  async logs(id: string, lines: number): Promise<string[]> {
    return this.require(id).lines.slice(-lines)
  }

  async remove(id: string, body: { author: string }): Promise<ModuleView> {
    this.calls.push({ verb: 'remove', id, body })
    const m = this.require(id)
    await this.kill(m)
    await rm(m.dir, { recursive: true, force: true })
    this.modules.delete(id)
    return structuredClone({ ...m.view, desired: 'stopped' as const, state: 'stopped' as ModuleRunState })
  }

  /** The module's process (specs freeze or kill it to make it fail). */
  child(id: string): ChildProcess {
    const c = this.require(id).child
    if (!c) throw new Error(`module ${id} has no process`)
    return c
  }

  /** Stops every process (spec teardown). */
  async shutdown(): Promise<void> {
    for (const m of this.modules.values()) {
      await this.kill(m)
      await rm(m.dir, { recursive: true, force: true })
    }
    this.modules.clear()
  }

  private require(id: string): Running {
    const m = this.modules.get(id)
    if (!m) throw new Error(`urn:ee:module_not_found: ${id}`)
    return m
  }

  private async unpack(request: DeployModuleRequest): Promise<{ dir: string; manifest: ModuleManifestV1 }> {
    const handOff = join(this.options.stateDir, MODULE_BUNDLE_HANDOFF_DIR, request.tarball)
    const bytes = await readFile(handOff)
    await rm(handOff)
    if (sha256Hex(bytes) !== request.sha256) throw new Error('urn:ee:receipt_invalid: the tarball does not match its sha256')
    const verified = verifyReceipt(request.receipt, this.options.trustedKeys)
    if (!verified.ok) throw new Error(`urn:ee:receipt_invalid: ${verified.problem}`)
    if (verified.receipt.bundleSha256 !== request.sha256 || verified.receipt.commit !== request.commit) {
      throw new Error('urn:ee:receipt_invalid: the receipt pins another bundle')
    }
    const manifest = parseModuleManifest(request.manifest)
    const dir = await mkdtemp(join(tmpdir(), `ee-mod-${request.id}-`))
    for (const entry of readBundle(bytes).entries) {
      if (entry.type !== 'file') continue
      await mkdir(dirname(join(dir, entry.path)), { recursive: true })
      await writeFile(join(dir, entry.path), entry.content, { mode: entry.mode })
    }
    return { dir, manifest }
  }

  private spawn(m: Running): void {
    const [cmd, ...args] = m.manifest.start
    const child = spawn(cmd!, args, {
      cwd: m.dir,
      env: {
        EE_MODULE_ID: m.view.id,
        EE_MODULE_COMMIT: m.view.commit,
        EE_MODULE_SOCKET: join(moduleSocketDir(this.options.stateDir, m.view.id), 'kernel.sock'),
        NODE_ENV: 'production',
        PATH: process.env.PATH ?? '',
        EE_MODULE_TOKEN: m.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (b: Buffer) => m.lines.push(...String(b).split('\n').filter(Boolean)))
    child.stderr?.on('data', (b: Buffer) => m.lines.push(...String(b).split('\n').filter(Boolean)))
    child.on('exit', (code) => {
      if (m.child !== child) return
      m.child = null
      if (m.view.desired === 'running') {
        m.view = { ...m.view, state: 'failed', error: `exited with code ${code}` }
      }
    })
    m.child = child
    m.view = { ...m.view, state: 'running' }
  }

  private async kill(m: Running): Promise<void> {
    const child = m.child
    m.child = null
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill('SIGKILL')
    })
  }
}
