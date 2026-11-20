import type { PreviewRoute } from './caddy.ts'
import { posix } from 'node:path'
import { z } from 'zod'
import { PATHS } from './paths.ts'
import { ensurePreviewNet, FORWARD_PORT, forwarderScript, NETNS_PATH, NS_ADDR, type PreviewNet } from './preview-net.ts'
import { scanTarball, UnsafeTarballError, type TarSummary } from './preview-tar.ts'
import { HOSTNAME } from './spec.ts'
import { mustRun, type System } from './system.ts'

/**
 * Drive app previews (plan/phase-drive-app-preview.md, "Contract between ee and
 * the kernel"): a web-app folder snapshot runs sandboxed and ephemeral as user
 * ee-preview, served at <id>.preview.<console host>. One active preview per box;
 * nothing about a preview is ever written to the company repo, and none survives
 * an ee restart. Its units run in the preview network namespace (preview-net.ts):
 * internet yes, the box and private ranges no; Caddy reaches it through a
 * forwarder unit on NS_ADDR:FORWARD_PORT.
 *
 *   POST   /v1/previews          { id, tarball, sha256, folderName, author } → 202 { preview }
 *                                409 urn:ee:preview_busy { running } · 422 urn:ee:preview_rejected
 *   GET    /v1/previews          → { previews }
 *   GET    /v1/previews/:id      → { preview } · 404 urn:ee:preview_not_found
 *   POST   /v1/previews/:id/seen {} → { preview }
 *   DELETE /v1/previews/:id      { author } → { preview } (stopped; files removed)
 */

export type PreviewState = 'installing' | 'starting' | 'running' | 'failed' | 'stopped'

export type PreviewView = {
  id: string
  folderName: string
  state: PreviewState
  host: string
  url: string
  script: 'dev' | 'start' | null
  startedAt: string
  lastSeenAt: string
  error: string | null
  log: string[]
}

export const PREVIEW_ID = /^pv[0-9a-f]{12}$/
export const PREVIEW_USER = 'ee-preview'
/** Where the kernel hands snapshots over ($EE_STATE_DIR/previews). */
export const HANDOFF_DIR = `${PATHS.osState}/previews`
const NODE_BIN = `${PATHS.runtimes}/node-22/bin`
const MEMORY_MAX = '1024M'
const INSTALL_MAX_SEC = 900
const LOG_LINES = 200
const PORT_RANGE = { min: 41_000, max: 41_999 }
/** Nothing a preview runs may even see these (other apps, company state, secrets, TLS keys). */
const INACCESSIBLE = [
  PATHS.company,
  PATHS.workloads,
  PATHS.releases,
  PATHS.secrets,
  PATHS.journal,
  '/etc/ee',
  '/run/ee',
  PATHS.osState.replace(/\/os$/, ''),
  '/var/lib/postgresql',
  '/var/lib/caddy',
  // Unix sockets ignore network namespaces: hide the box's own.
  '/run/postgresql',
  '/run/caddy',
  '/run/dbus',
  '/run/credentials',
]

export class PreviewError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export type PreviewDeps = {
  sys: System
  /** The box's console host (company repo settings). */
  consoleHost(): Promise<string>
  /** Journal an event (preview.started | running | failed | stopped). */
  emit(type: string, message: string, data: Record<string, unknown>): Promise<void>
  /** The set of preview routes changed: reload the edge. */
  edgeChanged(): Promise<void>
  /** Header scan of ee's own copy of the snapshot (preview-tar.ts). */
  scan(path: string): Promise<TarSummary>
  /** How long the dev server has to open a port. */
  portDeadlineMs: number
  /** Stop after this long without /seen. */
  idleMs: number
  /** Set up (or repair) the preview network namespace (preview-net.ts). */
  net(sys: System): Promise<PreviewNet>
}

const startInput = z
  .object({
    id: z.string().regex(PREVIEW_ID),
    tarball: z.string().min(1).max(512),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    folderName: z.string().min(1).max(255),
    author: z.string().min(1).max(64),
  })
  .strict()
const stopInput = z.object({ author: z.string().min(1).max(64) }).strict()
const seenInput = z.object({}).strict()

type Install = { label: string; argv: string[] }

type Rec = {
  id: string
  folderName: string
  author: string
  host: string
  state: PreviewState
  script: 'dev' | 'start' | null
  startedAt: Date
  lastSeenAt: Date
  error: string | null
  /** Frozen once the preview is failed or stopped; read live from the journal before. */
  log: string[]
  dir: string
  /** ee's copy of the snapshot until it is unpacked. */
  snapshot: string
  install: Install | null
  installSince: number | null
  runSince: number | null
  upstream: { dial: string; port: number } | null
  net: PreviewNet | null
  cancelled: boolean
}

const ACTIVE: PreviewState[] = ['installing', 'starting', 'running']
const isActive = (r: Rec) => ACTIVE.includes(r.state)
const installUnit = (id: string) => `ee-preview-install-${id}`
const runUnit = (id: string) => `ee-preview-${id}`
const forwardUnit = (id: string) => `ee-preview-fwd-${id}`
/** A command run inside the preview network namespace (ss sees only its sockets there). */
const inNetns = (cmd: string, args: string[]): [string, string[]] => ['nsenter', [`--net=${NETNS_PATH}`, cmd, ...args]]

/** A failure that ends a preview with this message (and its log). */
class PreviewFailure extends Error {}

export class PreviewService {
  private readonly d: PreviewDeps
  private readonly recs = new Map<string, Rec>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly running = new Set<Promise<void>>()
  private lastDirMs = 0

  constructor(deps: Pick<PreviewDeps, 'sys' | 'consoleHost' | 'emit' | 'edgeChanged'> & Partial<PreviewDeps>) {
    this.d = { scan: scanTarball, portDeadlineMs: 5 * 60_000, idleMs: 30 * 60_000, net: ensurePreviewNet, ...deps }
  }

  private get sys(): System {
    return this.d.sys
  }

  /** One mutation at a time (start, stop, sweep, the end of a run). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** The hosts Caddy serves for previews (installing/starting: null upstream = the starting page). */
  routes(): PreviewRoute[] {
    return [...this.recs.values()].filter(isActive).map((r) => ({ host: r.host, upstream: r.state === 'running' ? r.upstream : null }))
  }

  /** Every run in flight has finished (tests). */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running])
  }

  start(raw: unknown): Promise<{ preview: PreviewView; done: Promise<void> }> {
    const parsed = startInput.safeParse(raw)
    if (!parsed.success) return Promise.reject(new PreviewError(400, 'urn:ee:invalid_input', parsed.error.message))
    const i = parsed.data
    if (
      posix.normalize(i.tarball) !== i.tarball ||
      posix.dirname(i.tarball) !== HANDOFF_DIR ||
      !new RegExp(`^${i.id}-\\d+\\.tar\\.gz$`).test(posix.basename(i.tarball))
    ) {
      return Promise.reject(
        new PreviewError(422, 'urn:ee:preview_rejected', `the snapshot must be ${HANDOFF_DIR}/${i.id}-<unix ms>.tar.gz, not ${i.tarball}`),
      )
    }
    return this.exclusive(async () => {
      // From here on the hand-off is ee's: it is deleted whatever the answer.
      let own: string | null = null
      try {
        const consoleHost = await this.d.consoleHost()
        const host = `${i.id}.preview.${consoleHost}`
        if (!HOSTNAME.test(consoleHost) || !HOSTNAME.test(host)) {
          throw new PreviewError(409, 'urn:ee:preview_unavailable', `this server has no console host yet ("${consoleHost}"), so a preview has no address`)
        }
        const busy = [...this.recs.values()].find((r) => isActive(r) && r.id !== i.id)
        if (busy) {
          throw new PreviewError(409, 'urn:ee:preview_busy', `another preview is running: ${busy.folderName}`, { running: await this.view(busy) })
        }
        own = await this.takeSnapshot(i.tarball, i.sha256)
        const previous = this.recs.get(i.id)
        if (previous && isActive(previous)) await this.halt(previous, 'stopped', null, { author: i.author, why: 'restarting with a new snapshot' })
        const now = this.sys.now()
        const dirMs = Math.max(now.getTime(), this.lastDirMs + 1)
        this.lastDirMs = dirMs
        const rec: Rec = {
          id: i.id,
          folderName: i.folderName,
          author: i.author,
          host,
          state: 'installing',
          script: null,
          startedAt: now,
          lastSeenAt: now,
          error: null,
          log: [],
          dir: `${PATHS.previews}/${i.id}-${dirMs}`,
          snapshot: own,
          install: null,
          installSince: null,
          runSince: null,
          upstream: null,
          net: null,
          cancelled: false,
        }
        own = null
        // Re-inserted so the map stays newest-last.
        this.recs.delete(i.id)
        this.recs.set(i.id, rec)
        await this.d.emit('preview.started', `preview ${i.id} (${i.folderName}) started by ${i.author}`, { id: i.id, folderName: i.folderName, host, author: i.author })
        const done = this.pipeline(rec)
        this.running.add(done)
        void done.finally(() => this.running.delete(done))
        return { preview: await this.view(rec), done }
      } finally {
        await this.sys.remove(i.tarball)
        if (own) await this.sys.remove(own)
      }
    })
  }

  /** Copy the kernel's hand-off into ee's root-only dir, then check that copy (it cannot change underneath). */
  private async takeSnapshot(handoff: string, sha256: string): Promise<string> {
    const kind = await this.sys.run('stat', ['-c', '%F', '--', handoff])
    if (kind.code !== 0) throw new PreviewError(422, 'urn:ee:preview_rejected', `no snapshot at ${handoff}`)
    if (kind.stdout.trim() !== 'regular file') {
      throw new PreviewError(422, 'urn:ee:preview_rejected', `the snapshot ${handoff} is a ${kind.stdout.trim()}, not a regular file`)
    }
    const incoming = `${PATHS.previews}/incoming`
    await this.sys.mkdirp(incoming, 0o700)
    const own = `${incoming}/${posix.basename(handoff)}`
    await mustRun(this.sys, 'cp', ['--no-dereference', '--', handoff, own])
    try {
      const copied = await this.sys.run('stat', ['-c', '%F', '--', own])
      if (copied.stdout.trim() !== 'regular file') {
        throw new PreviewError(422, 'urn:ee:preview_rejected', `the snapshot ${handoff} changed into a ${copied.stdout.trim()} while it was copied`)
      }
      const actual = await this.sys.sha256File(own)
      if (actual !== sha256) throw new PreviewError(422, 'urn:ee:preview_rejected', `snapshot checksum mismatch (expected ${sha256}, got ${actual})`)
      try {
        await this.d.scan(own)
      } catch (err) {
        if (err instanceof UnsafeTarballError) throw new PreviewError(422, 'urn:ee:preview_rejected', `unsafe snapshot: ${err.message}`)
        throw err
      }
      return own
    } catch (err) {
      await this.sys.remove(own)
      throw err
    }
  }

  /** installing → starting → running; any failure ends in failed with the log. */
  private async pipeline(rec: Rec): Promise<void> {
    try {
      await this.d.edgeChanged()
      await this.unpack(rec)
      if (rec.cancelled) return
      const install = await this.plan(rec)
      if (rec.cancelled) return
      try {
        rec.net = await this.d.net(this.sys)
      } catch (err) {
        throw new PreviewFailure(`the preview network could not be set up: ${(err as Error).message}`)
      }
      if (rec.cancelled) return
      await this.installDeps(rec, install)
      if (rec.cancelled) return
      rec.state = 'starting'
      const upstream = await this.startDev(rec)
      if (!upstream) return
      await this.exclusive(async () => {
        if (rec.cancelled) return
        rec.upstream = upstream
        rec.state = 'running'
        try {
          await this.d.edgeChanged()
        } catch (err) {
          throw new PreviewFailure(`the edge (Caddy) refused the preview route: ${(err as Error).message}`)
        }
        await this.d.emit('preview.running', `preview ${rec.id} (${rec.folderName}) is running at https://${rec.host}/`, {
          id: rec.id,
          host: rec.host,
          port: upstream.port,
          author: rec.author,
        })
      })
    } catch (err) {
      const message = err instanceof PreviewFailure ? err.message : `the preview could not be started: ${(err as Error).message}`
      await this.exclusive(async () => {
        if (rec.cancelled) return
        try {
          await this.halt(rec, 'failed', message, { author: rec.author })
        } catch (haltErr) {
          rec.state = 'failed'
          rec.error = `${message} (and stopping it failed: ${(haltErr as Error).message})`
        }
      })
    }
  }

  private async unpack(rec: Rec): Promise<void> {
    // ee-preview must traverse (never list) the previews dir to reach its own run dir.
    await mustRun(this.sys, 'chmod', ['711', PATHS.previews])
    await this.sys.mkdirp(rec.dir, 0o700)
    try {
      await mustRun(this.sys, 'tar', ['-xzf', rec.snapshot, '-C', rec.dir, '--no-same-owner', '--no-same-permissions'])
    } finally {
      await this.sys.remove(rec.snapshot)
    }
    await mustRun(this.sys, 'chown', ['-R', `${PREVIEW_USER}:${PREVIEW_USER}`, rec.dir])
    await mustRun(this.sys, 'chmod', ['700', rec.dir])
  }

  /** The folder's own package.json and lockfile decide (file facts, contract). */
  private async plan(rec: Rec): Promise<Install> {
    const raw = await this.sys.readFile(`${rec.dir}/package.json`)
    if (raw === null) throw new PreviewFailure('the folder has no package.json at its top level')
    let pkg: unknown
    try {
      pkg = JSON.parse(raw)
    } catch {
      throw new PreviewFailure('package.json is not valid JSON')
    }
    const scripts = (pkg as { scripts?: Record<string, unknown> } | null)?.scripts
    const script = typeof scripts?.['dev'] === 'string' ? 'dev' : typeof scripts?.['start'] === 'string' ? 'start' : null
    if (!script) throw new PreviewFailure('package.json has no dev or start script')
    rec.script = script
    const has = (f: string) => this.sys.exists(`${rec.dir}/${f}`)
    if ((await has('package-lock.json')) || (await has('npm-shrinkwrap.json'))) return { label: 'npm ci', argv: [`${NODE_BIN}/npm`, 'ci'] }
    if (await has('pnpm-lock.yaml')) {
      return { label: 'corepack pnpm install --frozen-lockfile', argv: [`${NODE_BIN}/corepack`, 'pnpm', 'install', '--frozen-lockfile'] }
    }
    if (await has('yarn.lock')) return { label: 'corepack yarn install --immutable', argv: [`${NODE_BIN}/corepack`, 'yarn', 'install', '--immutable'] }
    throw new PreviewFailure('add a lockfile (package-lock.json, pnpm-lock.yaml or yarn.lock)')
  }

  private sandbox(rec: Rec, writable: string[]): string[] {
    if (!rec.net) throw new Error(`preview ${rec.id}: no network set up before its units`)
    return [
      '-p', `NetworkNamespacePath=${NETNS_PATH}`,
      '-p', `BindReadOnlyPaths=${rec.net.resolvConf}:${rec.net.resolvTarget}`,
      '-p', `User=${PREVIEW_USER}`,
      '-p', `Group=${PREVIEW_USER}`,
      '-p', 'NoNewPrivileges=yes',
      '-p', 'ProtectSystem=strict',
      '-p', 'ProtectHome=yes',
      '-p', 'PrivateTmp=yes',
      '-p', 'PrivateDevices=yes',
      '-p', `ReadWritePaths=${writable.join(' ')}`,
      '-p', `InaccessiblePaths=${INACCESSIBLE.map((p) => `-${p}`).join(' ')}`,
      '-p', `MemoryMax=${MEMORY_MAX}`,
      `--working-directory=${rec.dir}`,
    ]
  }

  private async installDeps(rec: Rec, install: Install): Promise<void> {
    rec.install = install
    const cache = PATHS.previewCache
    await this.sys.mkdirp(cache, 0o700)
    await mustRun(this.sys, 'chown', [`${PREVIEW_USER}:${PREVIEW_USER}`, cache])
    const unit = installUnit(rec.id)
    await this.sys.run('systemctl', ['reset-failed', `${unit}.service`])
    if (rec.cancelled) return
    rec.installSince = this.sys.now().getTime()
    // A Stop that lands between this check and the unit starting removed its dir: the unit cannot start.
    const r = await this.sys.run(
      'systemd-run',
      [
        '--wait',
        '--collect',
        '--quiet',
        `--unit=${unit}`,
        ...this.sandbox(rec, [rec.dir, cache]),
        '-p', `RuntimeMaxSec=${INSTALL_MAX_SEC}`,
        '-E', `PATH=${NODE_BIN}:/usr/bin:/bin`,
        '-E', 'HOME=/tmp',
        '-E', `npm_config_cache=${cache}/npm`,
        '-E', 'npm_config_update_notifier=false',
        '-E', 'npm_config_fund=false',
        '-E', 'npm_config_audit=false',
        '-E', `COREPACK_HOME=${cache}/corepack`,
        '-E', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
        '-E', `npm_config_store_dir=${cache}/pnpm-store`,
        '-E', `YARN_CACHE_FOLDER=${cache}/yarn`,
        ...install.argv,
      ],
      { timeoutMs: (INSTALL_MAX_SEC + 60) * 1000 },
    )
    if (rec.cancelled) return
    if (r.code !== 0) throw new PreviewFailure(`installing dependencies failed (exit ${r.code}); see the log`)
  }

  private async startDev(rec: Rec): Promise<{ dial: string; port: number } | null> {
    const port = await this.freePort()
    const unit = runUnit(rec.id)
    await this.sys.run('systemctl', ['reset-failed', `${unit}.service`])
    // Launched under the lock, so a Stop either sees the unit (and stops it) or keeps it from starting.
    const launched = await this.exclusive(async () => {
      if (rec.cancelled) return false
      rec.runSince = this.sys.now().getTime()
      await mustRun(this.sys, 'systemd-run', [
        '--collect',
        '--quiet',
        `--unit=${unit}`,
        ...this.sandbox(rec, [rec.dir]),
        // Only these: no company env, secrets, database or kernel socket.
        '-E', `PATH=${NODE_BIN}:/usr/bin:/bin`,
        '-E', 'HOME=/tmp',
        '-E', `PORT=${port}`,
        '-E', 'HOST=127.0.0.1',
        '-E', 'NODE_ENV=development',
        `${NODE_BIN}/npm`,
        'run',
        rec.script ?? 'dev',
      ])
      return true
    })
    if (!launched) return null
    const deadline = this.sys.now().getTime() + this.d.portDeadlineMs
    for (;;) {
      if (rec.cancelled) return null
      const state = (await this.sys.run('systemctl', ['is-active', `${unit}.service`])).stdout.trim()
      if (state !== 'active' && state !== 'activating' && state !== 'reloading') {
        throw new PreviewFailure('the dev server exited before it listened on a port')
      }
      const found = await this.listening(unit, port)
      if (found) return await this.expose(rec, found)
      if (this.sys.now().getTime() >= deadline) {
        throw new PreviewFailure(`the dev server did not listen on a port within ${Math.round(this.d.portDeadlineMs / 60_000)} minutes`)
      }
      await this.sys.sleep(1000)
    }
  }

  /**
   * Make the dev server reachable from the box: a listener on all addresses
   * (or on NS_ADDR) is dialed directly; one on the namespace's loopback only
   * gets a forwarder unit on NS_ADDR:FORWARD_PORT.
   */
  private async expose(rec: Rec, found: { dial: string; port: number }): Promise<{ dial: string; port: number } | null> {
    if (!found.dial.startsWith('127.') && !found.dial.startsWith('[')) return { dial: `${NS_ADDR}:${found.port}`, port: found.port }
    const unit = forwardUnit(rec.id)
    await this.sys.run('systemctl', ['reset-failed', `${unit}.service`])
    const launched = await this.exclusive(async () => {
      if (rec.cancelled) return false
      await mustRun(this.sys, 'systemd-run', [
        '--collect',
        '--quiet',
        `--unit=${unit}`,
        ...this.sandbox(rec, [rec.dir]),
        '-p', 'MemoryMax=64M',
        `${NODE_BIN}/node`,
        '-e',
        forwarderScript({ host: found.dial.slice(0, found.dial.lastIndexOf(':')), port: found.port }),
      ])
      return true
    })
    if (!launched) return null
    const deadline = this.sys.now().getTime() + 15_000
    for (;;) {
      if (rec.cancelled) return null
      const up = parseListeners(await mustRun(this.sys, ...inNetns('ss', ['-ltnH']))).some((l) => l.address === NS_ADDR && l.port === FORWARD_PORT)
      if (up) return { dial: `${NS_ADDR}:${FORWARD_PORT}`, port: found.port }
      const state = (await this.sys.run('systemctl', ['is-active', `${unit}.service`])).stdout.trim()
      if (state !== 'active' && state !== 'activating') throw new PreviewFailure(`the preview forwarder exited (${state}); is port ${FORWARD_PORT} taken inside the app?`)
      if (this.sys.now().getTime() >= deadline) throw new PreviewFailure(`the preview forwarder did not listen on ${NS_ADDR}:${FORWARD_PORT} within 15 seconds`)
      await this.sys.sleep(500)
    }
  }

  /** A free TCP port for PORT inside the namespace (the app may ignore it: the port watch finds the real one). */
  private async freePort(): Promise<number> {
    const used = new Set(parseListeners(await mustRun(this.sys, ...inNetns('ss', ['-ltnH']))).map((l) => l.port))
    for (let p = PORT_RANGE.min; p <= PORT_RANGE.max; p++) if (!used.has(p)) return p
    throw new PreviewFailure(`no free port in ${PORT_RANGE.min}–${PORT_RANGE.max}`)
  }

  /** The unit's cgroup processes ∩ listening TCP sockets; loopback IPv4 first, then the PORT we gave it. */
  private async listening(unit: string, port: number): Promise<{ dial: string; port: number } | null> {
    const cgroup = (await this.sys.run('systemctl', ['show', '-p', 'ControlGroup', '--value', `${unit}.service`])).stdout.trim()
    if (!cgroup) return null
    const procs = await this.sys.readFile(`/sys/fs/cgroup${cgroup}/cgroup.procs`)
    if (!procs) return null
    const pids = new Set(procs.split('\n').map((l) => l.trim()).filter(Boolean).map(Number))
    const mine = parseListeners(await mustRun(this.sys, ...inNetns('ss', ['-ltnpH'])))
      .filter((l) => l.pids.some((p) => pids.has(p)))
      .map((l) => ({ ...l, rank: dialRank(l.address) }))
      .filter((l): l is typeof l & { rank: { rank: number; dial: string } } => l.rank !== null)
      .sort((a, b) => a.rank.rank - b.rank.rank || Number(a.port !== port) - Number(b.port !== port))
    const best = mine[0]
    return best ? { dial: `${best.rank.dial}:${best.port}`, port: best.port } : null
  }

  /** End a preview: stop its units, keep its log, remove its files and its route. */
  private async halt(rec: Rec, state: 'failed' | 'stopped', error: string | null, meta: { author?: string; why: string } | { author?: string }): Promise<void> {
    rec.cancelled = true
    const units = [`${installUnit(rec.id)}.service`, `${runUnit(rec.id)}.service`, `${forwardUnit(rec.id)}.service`]
    await this.sys.run('systemctl', ['stop', ...units])
    for (const u of units) {
      const s = (await this.sys.run('systemctl', ['is-active', u])).stdout.trim()
      if (s === 'active' || s === 'activating' || s === 'deactivating') throw new Error(`${u} is still ${s} after systemctl stop`)
    }
    rec.log = await this.liveLog(rec)
    await this.sys.remove(rec.dir)
    await this.sys.remove(rec.snapshot)
    rec.state = state
    rec.error = error
    rec.upstream = null
    const why = error ?? ('why' in meta ? meta.why : meta.author ? `stopped by ${meta.author}` : 'stopped')
    const data: Record<string, unknown> = { id: rec.id, folderName: rec.folderName, host: rec.host, ...(meta.author ? { author: meta.author } : {}) }
    if (state === 'failed') await this.d.emit('preview.failed', `preview ${rec.id} (${rec.folderName}) failed: ${why}`, { ...data, error, logs: rec.log.slice(-40) })
    else await this.d.emit('preview.stopped', `preview ${rec.id} (${rec.folderName}) stopped: ${why}`, data)
    await this.d.edgeChanged()
  }

  private async journalLines(unit: string, sinceMs: number): Promise<string[]> {
    const out = await this.sys.run('journalctl', ['-u', `${unit}.service`, '--since', `@${Math.floor(sinceMs / 1000)}`, '-n', String(LOG_LINES), '--no-pager', '-o', 'cat'])
    return out.stdout.split('\n').filter((l) => l !== '')
  }

  private async liveLog(rec: Rec): Promise<string[]> {
    const lines: string[] = []
    if (rec.install && rec.installSince !== null) lines.push(`$ ${rec.install.label}`, ...(await this.journalLines(installUnit(rec.id), rec.installSince)))
    if (rec.runSince !== null) lines.push(`$ npm run ${rec.script}`, ...(await this.journalLines(runUnit(rec.id), rec.runSince)))
    return lines.slice(-LOG_LINES)
  }

  private async view(rec: Rec): Promise<PreviewView> {
    return {
      id: rec.id,
      folderName: rec.folderName,
      state: rec.state,
      host: rec.host,
      url: `https://${rec.host}/`,
      script: rec.script,
      startedAt: rec.startedAt.toISOString(),
      lastSeenAt: rec.lastSeenAt.toISOString(),
      error: rec.error,
      log: isActive(rec) ? await this.liveLog(rec) : rec.log,
    }
  }

  private find(id: string): Rec {
    const rec = PREVIEW_ID.test(id) ? this.recs.get(id) : undefined
    if (!rec) throw new PreviewError(404, 'urn:ee:preview_not_found', `no preview ${id}`)
    return rec
  }

  async list(): Promise<PreviewView[]> {
    return Promise.all([...this.recs.values()].reverse().map((r) => this.view(r)))
  }

  async get(id: string): Promise<PreviewView> {
    return this.view(this.find(id))
  }

  /** Someone has it open: reset the idle clock. */
  async seen(id: string, raw: unknown = {}): Promise<PreviewView> {
    const parsed = seenInput.safeParse(raw)
    if (!parsed.success) throw new PreviewError(400, 'urn:ee:invalid_input', parsed.error.message)
    const rec = this.find(id)
    rec.lastSeenAt = this.sys.now()
    return this.view(rec)
  }

  stop(id: string, raw: unknown): Promise<PreviewView> {
    const parsed = stopInput.safeParse(raw)
    if (!parsed.success) return Promise.reject(new PreviewError(400, 'urn:ee:invalid_input', parsed.error.message))
    return this.exclusive(async () => {
      const rec = this.find(id)
      if (isActive(rec)) await this.halt(rec, 'stopped', null, { author: parsed.data.author })
      else {
        // Failed or stopped already: the files are gone; it now reads as stopped.
        rec.state = 'stopped'
        rec.error = null
      }
      return this.view(rec)
    })
  }

  /** Every minute: stop previews nobody has looked at for idleMs. */
  sweep(): Promise<void> {
    return this.exclusive(async () => {
      const now = this.sys.now().getTime()
      for (const rec of this.recs.values()) {
        if (!isActive(rec) || now - rec.lastSeenAt.getTime() < this.d.idleMs) continue
        await this.halt(rec, 'stopped', `idle for ${Math.round(this.d.idleMs / 60_000)} minutes`, {})
      }
    })
  }

  /** ee start: previews are never restored. Stop every leftover unit and wipe the preview dirs. */
  wipe(): Promise<void> {
    return this.exclusive(async () => {
      const listed = await mustRun(this.sys, 'systemctl', ['list-units', '--all', '--plain', '--no-legend', '--type=service', 'ee-preview-*'])
      const units = listed
        .split('\n')
        .map((l) => l.trim().split(/\s+/)[0] ?? '')
        .filter((u) => /^ee-preview-(install-|fwd-)?pv[0-9a-f]{12}\.service$/.test(u))
      if (units.length > 0) {
        await mustRun(this.sys, 'systemctl', ['stop', ...units])
        await this.sys.run('systemctl', ['reset-failed', ...units])
        for (const u of units.filter((x) => !x.startsWith('ee-preview-install-') && !x.startsWith('ee-preview-fwd-'))) {
          const id = u.slice('ee-preview-'.length, -'.service'.length)
          await this.d.emit('preview.stopped', `preview ${id} stopped: ee restarted (previews are never restored)`, { id })
        }
      }
      await this.sys.remove(PATHS.previews)
      await this.sys.mkdirp(PATHS.previews, 0o711)
      this.recs.clear()
    })
  }
}

type Listener = { address: string; port: number; pids: number[] }

/** `ss -ltn[p]H` lines: State Recv-Q Send-Q Local:Port Peer:Port [users:(("x",pid=N,fd=M),…)]. */
export function parseListeners(out: string): Listener[] {
  const res: Listener[] = []
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/)
    const local = cols[3]
    if (!local) continue
    const colon = local.lastIndexOf(':')
    const port = Number(local.slice(colon + 1))
    if (colon === -1 || !Number.isInteger(port)) continue
    const address = local.slice(0, colon).replace(/%.*$/, '')
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))
    res.push({ address, port, pids })
  }
  return res
}

/**
 * How a listener inside the preview namespace is reached: on all addresses or
 * on NS_ADDR, directly (dial 0.0.0.0 → NS_ADDR in expose); on loopback only,
 * through the forwarder. null: not reachable.
 */
function dialRank(address: string): { rank: number; dial: string } | null {
  if (address === '0.0.0.0' || address === '*' || address === NS_ADDR) return { rank: 0, dial: NS_ADDR }
  if (address.startsWith('127.')) return { rank: 1, dial: '127.0.0.1' }
  if (address === '[::1]') return { rank: 2, dial: '[::1]' }
  if (address === '[::]' || address === '[::ffff:127.0.0.1]') return { rank: 3, dial: '[::1]' }
  return null
}

export type Reply = { status: number; data: unknown }

const PREVIEW_PATH = /^(GET|POST|DELETE) \/v1\/previews(?:\/([^/]+)(\/seen)?)?$/

/** The preview verbs of the control API (daemon.ts). */
export async function previewRoute(svc: PreviewService, route: string, readBody: () => Promise<unknown>): Promise<Reply | null> {
  const m = PREVIEW_PATH.exec(route)
  if (!m) return null
  const [, method, id, seen] = m
  try {
    if (!id && method === 'POST') return { status: 202, data: { preview: (await svc.start(await readBody())).preview } }
    if (!id && method === 'GET') return { status: 200, data: { previews: await svc.list() } }
    if (id && !seen && method === 'GET') return { status: 200, data: { preview: await svc.get(id) } }
    if (id && seen && method === 'POST') return { status: 200, data: { preview: await svc.seen(id, await readBody()) } }
    if (id && !seen && method === 'DELETE') return { status: 200, data: { preview: await svc.stop(id, await readBody()) } }
    return null
  } catch (err) {
    if (err instanceof PreviewError) return { status: err.status, data: { type: err.type, title: err.message, detail: err.message, ...err.extra } }
    throw err
  }
}
