import { randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { CORE_API_VERSION } from '../../../../contracts/core-api-version'
import {
  kernelModuleId,
  providedEventType,
  type ModuleManifestV1,
  type ModuleProvidedTool,
} from '../../../../contracts/module-manifest'
import {
  EemProtocolError,
  HEARTBEAT_MISS_MS,
  HEARTBEAT_MS,
  moduleTokenHash,
  MODULE_PROTOCOL,
  newModuleToken,
  parseKernelResult,
  parseModuleRequest,
  READY_TIMEOUT_MS,
  type Json,
} from '../../../../contracts/module-protocol'
import {
  MODULE_BUNDLE_HANDOFF_DIR,
  moduleBundleHandoffName,
  moduleSocketDir,
} from '../../../../contracts/module-workload'
import { moduleSource } from '../cloudevents'
import { isKernelErrorCode, KernelError } from '../errors'
import { emitKernelEvent, type EventSink, type KernelEvent } from '../events'
import { moduleSwitchedOff, type ActivationStore, type CompanyModuleSwitch, type ModuleRegistry } from '../modules'
import { moduleOwnerPrincipal, modulePrincipal } from '../principals'
import type { KernelRegistry } from '../registry'
import type { ToolContext, ToolPrincipal } from '../types'
import { CallTimeoutError, EemCallError, EemConnection, type IncomingRequest } from './connection'
import { ModuleData } from './data'
import { kernelManifestOf, proxyTools, schemaOf } from './proxy'
import type {
  CompanyModuleState,
  EventCursor,
  EventCursorStore,
  EventFeed,
  ModuleBundles,
  ModuleDataRepo,
  ModulePeople,
  ModulePrincipalStore,
  ModuleRecord,
  ModuleStore,
  ModuleWorkloadPort,
  PublishedVersion,
  SystemPinPort,
} from './types'

/**
 * The kernel's module host (plan/phase-upgrades-u2.md §4): one Unix socket
 * per company module, the eem/1 session on it, the module's proxy tools in
 * the registry, event delivery, `data.*`, and the §4.6 state machine — a
 * module that fails is switched off loudly (state, sentence, ee stop,
 * `module.failed`, Needs you), and its data is never touched.
 */

export type ModuleHostLimits = {
  /** Told to the module in `hello`; it sends a heartbeat this often. */
  heartbeatMs: number
  /** §4.6 b: no `ready` this long after a deploy or a connect. */
  readyTimeoutMs: number
  /** §4.6 c: no heartbeat for this long. */
  heartbeatMissMs: number
  /** How often the watchdog looks (heartbeats, ready, ee's view). */
  watchdogMs: number
  /** How often each live module's event delivery is pumped. */
  deliveryPollMs: number
  /** The first redelivery waits this long; each further one twice as long, up to `deliveryRetryMaxMs`. */
  deliveryRetryBaseMs: number
  deliveryRetryMaxMs: number
  /** After this, an undeliverable event is dropped with a journal line. */
  deliveryGiveUpMs: number
  /** An `event.deliver` unanswered this long counts as a failed attempt. */
  deliveryAckTimeoutMs: number
  /** §4.6 d: this many restarts … */
  restartLimit: number
  /** … within this window. */
  restartWindowMs: number
  /** §4.6 e: this many protocol violations or invalid outputs … */
  violationLimit: number
  /** … within this window. */
  violationWindowMs: number
}

export const MODULE_HOST_LIMITS: ModuleHostLimits = {
  heartbeatMs: HEARTBEAT_MS,
  readyTimeoutMs: READY_TIMEOUT_MS,
  heartbeatMissMs: HEARTBEAT_MISS_MS,
  watchdogMs: 5_000,
  deliveryPollMs: 1_000,
  deliveryRetryBaseMs: 1_000,
  deliveryRetryMaxMs: 10 * 60_000,
  deliveryGiveUpMs: 24 * 60 * 60_000,
  deliveryAckTimeoutMs: 30_000,
  restartLimit: 3,
  restartWindowMs: 10 * 60_000,
  violationLimit: 5,
  violationWindowMs: 10 * 60_000,
}

export type ModuleHostDeps = {
  registry: KernelRegistry
  modules: ModuleRegistry
  activations: ActivationStore
  eventSink: EventSink
  store: ModuleStore
  principals: ModulePrincipalStore
  cursors: EventCursorStore
  feed: EventFeed
  data: ModuleDataRepo
  workload: ModuleWorkloadPort
  bundles: ModuleBundles
  people: ModulePeople
  /** `$EE_STATE_DIR` (throws when the box has none: modules need the ee server). */
  stateDir: () => string
  /** system.yaml v2 (§3); absent in unit specs that don't look at it. */
  system?: SystemPinPort
  limits?: Partial<ModuleHostLimits>
  now?: () => number
  /** The journal (dropped events, an ee stop that failed): one line each. */
  log?: (line: string) => void
  /**
   * Tells the hub which version of a module runs on this box (§6.2 PUT …/run;
   * PublishPort.reportRun). A failed report is a journal line, never a module failure.
   */
  runReport?: (report: { moduleId: string; bundleSha256: string; state: 'running' | 'stopped' | 'failed' }) => Promise<void>
}

/** The run state the hub hears for each lifecycle event (module.removed and a person's off both stop it). */
const RUN_STATE_OF: Record<string, 'running' | 'stopped' | 'failed'> = {
  'module.deployed': 'running',
  'module.recovered': 'running',
  'module.switched_on': 'running',
  'module.failed': 'failed',
  'module.switched_off': 'stopped',
  'module.removed': 'stopped',
}

/** The kernel principal a module authenticates as and authors its data writes with (§4.2). */
export const modulePrincipalId = (id: string): string => `module:${id}`

/** Who the kernel names to ee when it acts on its own (a failure, a person's switch, a restore). */
export const HOST_AUTHOR = 'kernel'

type Session = {
  conn: EemConnection
  commit: string
  ready: boolean
  connectedAt: number
  lastBeat: number
  /** Live tool.invoke calls: callId → who invoked (tools.call with that callId acts as them). */
  calls: Map<string, ToolPrincipal>
  delivering: boolean
}

type Pending = { conn: EemConnection | null; session: Session | null; moduleId: string }

/** Thrown inside a request handler: answered, then the connection ends. */
class FatalEemError extends Error {
  readonly code = 'module_protocol'
}

/** A module's own error code for a tool call (not a kernel code), passed through as is. */
export class ModuleToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: unknown,
  ) {
    super(message)
    this.name = 'ModuleToolError'
  }
}

export type ModuleSessionView = {
  connected: boolean
  ready: boolean
  commit: string | null
  connectedAt: string | null
  lastHeartbeatAt: string | null
}

export class ModuleHost implements CompanyModuleSwitch {
  private readonly limits: ModuleHostLimits
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly servers = new Map<string, Server>()
  private readonly sessions = new Map<string, Session>()
  /** When each module last showed life (a heartbeat, or the host's own start) — survives a reconnect. */
  private readonly lastSeen = new Map<string, number>()
  private readonly connectingSince = new Map<string, number>()
  private readonly restarts = new Map<string, number[]>()
  private readonly lastRestartCount = new Map<string, number>()
  private readonly violations = new Map<string, number[]>()
  private readonly registered = new Map<string, string[]>()
  private watchdog: ReturnType<typeof setInterval> | null = null
  private delivery: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private started = false

  constructor(private readonly deps: ModuleHostDeps) {
    this.limits = { ...MODULE_HOST_LIMITS, ...deps.limits }
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? ((line) => console.warn(`[module-host] ${line}`))
    deps.modules.setCompanyModuleSwitch(this)
  }

  // ─── Lifecycle of the host ─────────────────────────────────────────────────

  /** Registers every deployed module's tools, listens for the live ones and starts the watchdog. */
  async start(): Promise<void> {
    if (this.started) throw new Error('the module host is started already')
    this.started = true
    for (const record of await this.deps.store.list()) {
      if (!record.manifest) continue
      this.registerTools(record.manifest)
      if (isLive(record.state)) {
        await this.listen(record.id)
        // A restarted os: give each module the full windows to reconnect.
        this.lastSeen.set(record.id, this.now())
        this.connectingSince.set(record.id, this.now())
        await this.redeployIfLost(record)
      }
    }
    this.watchdog = setInterval(() => void this.tick(), this.limits.watchdogMs)
    this.delivery = setInterval(() => void this.pumpAll(), this.limits.deliveryPollMs)
  }

  /**
   * After a restore ee may not have the module (or another commit): the
   * kernel re-POSTs the pinned, receipted commit (its bundle rebuilt from the
   * module repo or re-fetched from the hub, ModuleBundles). A failure is
   * loud: the module is switched off with the reason.
   */
  private async redeployIfLost(record: ModuleRecord): Promise<void> {
    try {
      const view = await this.deps.workload.get(record.id)
      if (view && view.commit === record.commit) return
      const version = record.commit ? await this.deps.store.version(record.id, record.commit) : null
      if (!version) throw new Error(`${record.id}@${record.commit ?? 'none'} has no receipt`)
      await this.deps.store.put({ ...record, deployedFrom: record.deployedFrom ?? record.state })
      await this.deployVersion(version, HOST_AUTHOR, true)
    } catch (err) {
      this.log(`could not bring back module ${record.id}: ${err instanceof Error ? err.message : String(err)}`)
      await this.fail(record.id, 'it could not be brought back on this server')
    }
  }

  /** Closes every socket and session (the modules keep running under ee and reconnect to the next os). */
  async stop(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog)
    if (this.delivery) clearInterval(this.delivery)
    this.watchdog = this.delivery = null
    for (const s of this.sessions.values()) s.conn.close()
    this.sessions.clear()
    await Promise.all([...this.servers.values()].map((s) => new Promise<void>((r) => s.close(() => r()))))
    this.servers.clear()
    this.started = false
  }

  // ─── Deploy, switch, remove (driven by the modules.* tools and kernel.module_*) ─

  /**
   * Deploys a receipted commit (§4.6, §5). While a person has it switched off
   * the commit is recorded and nothing starts. Otherwise: a new token, the
   * bundle handed to ee, ee's stop-then-start; the module counts as running
   * once it sends `ready`.
   */
  async deploy(version: PublishedVersion, by: string): Promise<ModuleRecord> {
    return this.deployVersion(version, by, false)
  }

  private async deployVersion(version: PublishedVersion, by: string, switchingOn: boolean): Promise<ModuleRecord> {
    const before = await this.requireRecord(version.moduleId)
    const id = before.id
    const kernelId = kernelModuleId(id)
    const at = new Date(this.now()).toISOString()
    const pinned: ModuleRecord = {
      ...before,
      manifest: version.manifest,
      receipt: version.receipt,
      commit: version.commit,
      bundleSha256: version.bundleSha256,
      pendingDeploy: null,
    }
    if (!switchingOn && (await moduleSwitchedOff(this.deps.activations, kernelId))) {
      // A person's off stays off: the commit waits for their switch-on.
      await this.deps.store.put(pinned)
      this.registerTools(version.manifest)
      return pinned
    }
    const token = await this.handOff(version)
    const firstDeployedAt = before.firstDeployedAt ?? at
    await this.deps.store.put({
      ...pinned,
      state: 'deploying',
      reason: null,
      stateSince: at,
      firstDeployedAt,
      deployedFrom: before.deployedFrom ?? before.state,
      deployedBy: by,
    })
    if (!(await this.deps.cursors.get(id))) await this.deps.cursors.put(newCursor(id, firstDeployedAt))
    this.dropSession(id)
    this.resetCounters(id)
    this.registerTools(version.manifest)
    await this.listen(id)
    try {
      await this.deps.workload.deploy({
        id,
        version: version.version,
        commit: version.commit,
        manifest: version.manifest as unknown as Record<string, unknown>,
        receipt: version.receipt as unknown as Record<string, unknown>,
        tarball: moduleBundleHandoffName(id, version.bundleSha256),
        sha256: version.bundleSha256,
        token,
        author: by,
      })
    } catch (err) {
      // ee refused (or is not there): nothing changed on the box; the record goes back as it was.
      await this.deps.store.put(before)
      if (before.manifest) this.registerTools(before.manifest)
      else this.unregisterTools(id)
      throw err
    }
    // The module may have sent `ready` already (ee answers 202 while it starts).
    const current = await this.requireRecord(id)
    const record: ModuleRecord =
      current.state === 'deploying'
        ? { ...current, state: 'connecting', stateSince: new Date(this.now()).toISOString() }
        : current
    if (record !== current) {
      await this.deps.store.put(record)
      this.connectingSince.set(id, this.now())
    }
    // A first deploy switches the module on (it had no activation record yet).
    if (!(await this.deps.activations.list()).has(kernelId)) await this.deps.activations.set(kernelId, true)
    return record
  }

  /** modules.test: ee builds and tests the receipted bundle without running it (a throwaway token). */
  async dryRun(version: PublishedVersion, by: string): Promise<{ passed: boolean; log: string }> {
    const bytes = await this.deps.bundles.bytes(version.moduleId, version.commit)
    await this.writeHandOff(version, bytes)
    return this.deps.workload.dryRun({
      id: version.moduleId,
      version: version.version,
      commit: version.commit,
      manifest: version.manifest as unknown as Record<string, unknown>,
      receipt: version.receipt as unknown as Record<string, unknown>,
      tarball: moduleBundleHandoffName(version.moduleId, version.bundleSha256),
      sha256: version.bundleSha256,
      token: newModuleToken(),
      author: by,
      dryRun: true,
    })
  }

  /** kernel.module_activate (§4.6): a failed module retries its commit; a person's off ends. */
  async switchedOn(kernelId: string): Promise<void> {
    const record = await this.requireRecord(localId(kernelId))
    if (record.state === 'running' || record.state === 'connecting' || record.state === 'deploying') return
    if (!record.commit || !record.manifest) {
      throw new KernelError('module_not_running', `${nameOf(record)} has never been deployed: deploy a commit first`, {
        module: record.id,
        state: record.state,
      })
    }
    const view = await this.deps.workload.get(record.id)
    if (view && view.commit === record.commit) {
      await this.deps.store.put({
        ...record,
        state: 'connecting',
        reason: null,
        stateSince: new Date(this.now()).toISOString(),
        deployedFrom: record.state,
        deployedBy: HOST_AUTHOR,
      })
      await this.listen(record.id)
      await this.deps.workload.start(record.id, { author: HOST_AUTHOR })
      this.connectingSince.set(record.id, this.now())
      this.resetCounters(record.id)
      return
    }
    // A commit recorded while it was off (or ee lost it): deploy that commit.
    const version = await this.deps.store.version(record.id, record.commit)
    if (!version) {
      throw new KernelError('module_unreceipted', `${nameOf(record)}@${record.commit.slice(0, 12)} has no receipt`, {
        module: record.id,
      })
    }
    await this.deps.store.put({ ...record, deployedFrom: record.state })
    await this.deployVersion(version, HOST_AUTHOR, true)
  }

  /** kernel.module_deactivate (§4.6): a person's off — ee stops it, `module.switched_off`. */
  async switchedOff(kernelId: string): Promise<void> {
    const record = await this.requireRecord(localId(kernelId))
    const sentence = `${nameOf(record)} is switched off by a person. Its data is kept.`
    await this.deps.store.put({
      ...record,
      state: 'off',
      reason: sentence,
      stateSince: new Date(this.now()).toISOString(),
      deployedFrom: null,
    })
    this.dropSession(record.id)
    if (record.commit) {
      await this.deps.workload.stop(record.id, { author: HOST_AUTHOR, reason: 'person', sentence })
    }
    await this.emit('module.switched_off', record, { sentence })
  }

  /** modules.remove: tools and manifest out, ee removes the unit; the code and the data stay. */
  async remove(id: string, by: string): Promise<void> {
    const record = await this.requireRecord(id)
    this.unregisterTools(id)
    this.dropSession(id)
    const server = this.servers.get(id)
    if (server) await new Promise<void>((r) => server.close(() => r()))
    this.servers.delete(id)
    if (record.commit && (await this.deps.workload.get(id))) await this.deps.workload.remove(id, { author: by })
    await this.deps.cursors.remove(id)
    await this.deps.store.remove(id)
    await this.deps.system?.pin(id, null, by)
    await this.emit('module.removed', record, {}, by)
  }

  /** The kernel side of `modules.status`: the session as the host sees it. */
  session(id: string): ModuleSessionView {
    const s = this.sessions.get(id)
    return {
      connected: s !== undefined && !s.conn.isClosed,
      ready: s?.ready === true,
      commit: s?.commit ?? null,
      connectedAt: s ? new Date(s.connectedAt).toISOString() : null,
      lastHeartbeatAt: s ? new Date(s.lastBeat).toISOString() : null,
    }
  }

  // ─── Proxy tools (§4.5) ────────────────────────────────────────────────────

  private registerTools(manifest: ModuleManifestV1): void {
    this.unregisterTools(manifest.id)
    this.deps.modules.registerCompanyModule(kernelManifestOf(manifest), manifest.id)
    const tools = proxyTools(manifest, (tool, ctx, input) => this.invoke(manifest.id, tool, ctx, input))
    for (const t of tools) this.deps.registry.register(t.descriptor, { gated: t.gated })
    this.registered.set(
      manifest.id,
      tools.map((t) => t.descriptor.name),
    )
  }

  private unregisterTools(id: string): void {
    for (const name of this.registered.get(id) ?? []) this.deps.registry.unregister(name)
    this.registered.delete(id)
    if (this.deps.modules.isCompanyModule(kernelModuleId(id))) {
      this.deps.modules.unregisterCompanyModule(kernelModuleId(id))
    }
  }

  private async invoke(id: string, tool: ModuleProvidedTool, ctx: ToolContext, input: unknown): Promise<unknown> {
    const session = this.sessions.get(id)
    if (!session || !session.ready || session.conn.isClosed) {
      const record = await this.deps.store.get(id)
      const state = record?.state ?? 'unpublished'
      const sentence = record?.reason ?? `${record ? nameOf(record) : id} is not running right now (${state}).`
      throw new KernelError('module_not_running', sentence, { module: id, state, sentence })
    }
    const callId = randomUUID()
    session.calls.set(callId, ctx.principal)
    let output: unknown
    try {
      output = await session.conn.call(
        'tool.invoke',
        {
          callId,
          tool: tool.name,
          input,
          principal: { id: ctx.principal.id, kind: ctx.principal.kind, roles: [...ctx.principal.roles] },
          deadlineMs: tool.timeoutMs,
        },
        tool.timeoutMs,
      )
    } catch (err) {
      if (err instanceof CallTimeoutError) {
        // A plain timeout is not a failure (§4.6).
        throw new KernelError('module_timeout', `${tool.name} of module ${id} did not answer within ${tool.timeoutMs} ms`, {
          module: id,
          tool: tool.name,
        })
      }
      if (err instanceof EemCallError) {
        const detail = { module: id, tool: tool.name, detail: err.detail }
        if (isKernelErrorCode(err.code)) throw new KernelError(err.code, err.message, detail)
        throw new ModuleToolError(err.code, err.message, err.detail)
      }
      throw err
    } finally {
      session.calls.delete(callId)
    }
    const checked = schemaOf(tool.output).safeParse(output)
    if (!checked.success) {
      await this.violation(id, `${tool.name} answered with output its manifest does not allow`)
      throw new KernelError('invalid_output', `module ${id} answered ${tool.name} with output its manifest does not allow`, {
        module: id,
        tool: tool.name,
      })
    }
    return checked.data
  }

  // ─── The socket and the session (§4.1–§4.3) ────────────────────────────────

  private async listen(id: string): Promise<void> {
    if (this.servers.has(id)) return
    const dir = moduleSocketDir(this.deps.stateDir(), id)
    await mkdir(dir, { recursive: true, mode: 0o755 })
    const path = join(dir, 'kernel.sock')
    // The previous os (blue/green) or a crash left the file: this process owns the socket now.
    await rm(path, { force: true })
    const server = createServer((socket) => this.accept(id, socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', (err) => this.log(`socket of module ${id} failed: ${err.message}`))
    await chmod(path, 0o666)
    this.servers.set(id, server)
  }

  private accept(id: string, socket: Socket): void {
    const pending: Pending = { conn: null, session: null, moduleId: id }
    pending.conn = new EemConnection(socket, {
      onRequest: (req) => this.onRequest(pending, req),
      onViolation: (err) => void this.violation(id, err.message),
      onClose: () => {
        if (pending.session && this.sessions.get(id) === pending.session) this.sessions.delete(id)
      },
    })
  }

  private async onRequest(pending: Pending, req: IncomingRequest): Promise<unknown> {
    try {
      return await this.handle(pending, req)
    } catch (err) {
      if (err instanceof EemProtocolError) await this.violation(pending.moduleId, err.message)
      if (err instanceof FatalEemError || (err instanceof EemProtocolError && !pending.session)) {
        // Answered first, then the connection ends.
        setImmediate(() => pending.conn?.close())
      }
      throw err
    }
  }

  private async handle(pending: Pending, req: IncomingRequest): Promise<unknown> {
    const id = pending.moduleId
    if (!pending.session) {
      if (req.method !== 'hello') throw new FatalEemError('the first message must be hello')
      return this.hello(pending, parseModuleRequest('hello', req.params))
    }
    const session = pending.session
    if (this.sessions.get(id) !== session) throw new FatalEemError('a newer connection replaced this one')
    switch (req.method) {
      case 'hello':
        throw new FatalEemError('hello was sent twice')
      case 'ready':
        parseModuleRequest('ready', req.params)
        await this.ready(id, session)
        return {}
      case 'heartbeat':
        parseModuleRequest('heartbeat', req.params)
        session.lastBeat = this.now()
        this.lastSeen.set(id, session.lastBeat)
        return {}
      case 'tools.call':
        return this.toolsCall(id, session, parseModuleRequest('tools.call', req.params))
      case 'events.emit':
        return this.eventsEmit(id, parseModuleRequest('events.emit', req.params))
      case 'data.get': {
        const p = parseModuleRequest('data.get', req.params)
        return this.data(id).get(p.path)
      }
      case 'data.put': {
        const p = parseModuleRequest('data.put', req.params)
        return this.data(id).put(p.path, p.content, p.ifMatch)
      }
      case 'data.list': {
        const p = parseModuleRequest('data.list', req.params)
        return this.data(id).list(p.prefix, p.cursor)
      }
      case 'data.delete': {
        const p = parseModuleRequest('data.delete', req.params)
        return this.data(id).delete(p.path, p.ifMatch)
      }
      default:
        throw new EemProtocolError(`the kernel has no method "${req.method}"`)
    }
  }

  private async hello(
    pending: Pending,
    params: { protocol: typeof MODULE_PROTOCOL; moduleId: string; commit: string; token: string },
  ): Promise<unknown> {
    const id = pending.moduleId
    const record = await this.deps.store.get(id)
    const expected = await this.deps.principals.tokenHash(id)
    if (
      params.moduleId !== id ||
      !record ||
      !record.manifest ||
      record.commit !== params.commit ||
      !isLive(record.state) ||
      expected === null ||
      !sameHex(moduleTokenHash(params.token), expected)
    ) {
      throw new FatalEemError('hello refused: the socket, the token and the commit must all match a deployed module')
    }
    const old = this.sessions.get(id)
    const session: Session = {
      conn: pending.conn!,
      commit: params.commit,
      ready: false,
      connectedAt: this.now(),
      lastBeat: this.now(),
      calls: new Map(),
      delivering: false,
    }
    pending.session = session
    this.sessions.set(id, session)
    // A newer hello replaces the older connection (§4.1).
    if (old && old.conn !== session.conn) old.conn.close()
    if (record.state === 'running') this.lastSeen.set(id, this.now())
    else this.connectingSince.set(id, this.now())
    return {
      coreApi: CORE_API_VERSION,
      heartbeatMs: this.limits.heartbeatMs,
      grants: {
        background: record.manifest.permissions.background,
        secrets: [...record.manifest.permissions.secrets],
      },
    }
  }

  private async ready(id: string, session: Session): Promise<void> {
    session.ready = true
    session.lastBeat = this.now()
    this.lastSeen.set(id, session.lastBeat)
    const record = await this.requireRecord(id)
    if (record.state === 'running' && record.deployedFrom === null) return
    const from = record.deployedFrom
    const running: ModuleRecord = {
      ...record,
      state: 'running',
      reason: null,
      stateSince: new Date(this.now()).toISOString(),
      deployedFrom: null,
    }
    await this.deps.store.put(running)
    this.connectingSince.delete(id)
    if (from !== null && record.manifest && record.commit && record.bundleSha256) {
      const by = record.deployedBy ?? HOST_AUTHOR
      await this.deps.system?.pin(
        id,
        { id, version: record.manifest.version, commit: record.commit, bundleSha256: record.bundleSha256 },
        by,
      )
      if (from === 'off') await this.emit('module.switched_on', running, {}, by)
      else await this.emit('module.deployed', running, { version: record.manifest.version }, by)
      if (from === 'failed') await this.emit('module.recovered', running, {}, by)
    }
  }

  /** §4.3: only `uses.tools`; as the invoking person (callId) or, with permissions.background, the owner. */
  private async toolsCall(
    id: string,
    session: Session,
    params: { name: string; input: Json; callId?: string },
  ): Promise<unknown> {
    const record = await this.requireRecord(id)
    const manifest = record.manifest!
    if (!manifest.uses.tools.includes(params.name)) {
      throw new KernelError('module_use_undeclared', `${manifest.name} does not declare ${params.name} in uses.tools`, {
        module: id,
        tool: params.name,
      })
    }
    let principal: ToolPrincipal
    if (params.callId !== undefined) {
      const invoker = session.calls.get(params.callId)
      if (!invoker) {
        throw new KernelError('module_no_person', `callId ${params.callId} names no call in progress`, { module: id })
      }
      principal = modulePrincipal(invoker, id)
    } else {
      if (!manifest.permissions.background) {
        throw new KernelError(
          'module_no_person',
          `${manifest.name} acts only as a person: a call without callId needs permissions.background`,
          { module: id },
        )
      }
      const owner = await this.deps.people.personById(record.ownerUserId)
      if (!owner) {
        throw new KernelError('module_no_person', `${manifest.name}'s owner is no longer a member`, { module: id })
      }
      principal = moduleOwnerPrincipal(owner, id)
    }
    const out = await this.deps.registry.execute(params.name, params.input, { principal, requestId: randomUUID() })
    return out === undefined ? null : (JSON.parse(JSON.stringify(out)) as unknown)
  }

  private async eventsEmit(id: string, params: { name: string; payload: Json }): Promise<{ id: string }> {
    const record = await this.requireRecord(id)
    const declared = record.manifest!.provides.events.find((e) => e.name === params.name)
    if (!declared) {
      throw new KernelError('module_use_undeclared', `${nameOf(record)} does not declare event ${params.name} in provides.events`, {
        module: id,
        event: params.name,
      })
    }
    if (declared.payload) {
      const checked = schemaOf(declared.payload as Record<string, unknown>).safeParse(params.payload)
      if (!checked.success) {
        throw new KernelError('invalid_input', `the payload of ${params.name} does not match its schema`, {
          module: id,
          event: params.name,
        })
      }
    }
    const event: KernelEvent = {
      id: randomUUID(),
      ts: new Date(this.now()).toISOString(),
      type: providedEventType(id, params.name),
      principalId: modulePrincipalId(id),
      source: moduleSource(kernelModuleId(id)),
      payload: params.payload,
    }
    await this.deps.eventSink.emit(event)
    return { id: event.id }
  }

  private data(id: string): ModuleData {
    return new ModuleData(this.deps.data, id, modulePrincipalId(id))
  }

  // ─── Event delivery (§4.4) ─────────────────────────────────────────────────

  private async pumpAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.pump(id).catch((err: unknown) => this.log(`event delivery to ${id} failed: ${String(err)}`))
    }
  }

  /** Delivers due events to one live module, in order; at-least-once, the cursor moves on an ack. */
  async pump(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session || !session.ready || session.delivering) return
    session.delivering = true
    try {
      const record = await this.deps.store.get(id)
      const types = record?.manifest?.uses.events ?? []
      if (types.length === 0) return
      for (let n = 0; n < 50; n++) {
        if (session.conn.isClosed || this.sessions.get(id) !== session) return
        const cursor = (await this.deps.cursors.get(id)) ?? newCursor(id, record!.firstDeployedAt ?? record!.stateSince)
        if (cursor.nextAttemptAt && Date.parse(cursor.nextAttemptAt) > this.now()) return
        const [event] = await this.deps.feed.after(cursor, types, 1)
        if (!event) return
        try {
          const answer = await session.conn.call(
            'event.deliver',
            { deliveryId: `${event.id}:${cursor.attempts + 1}`, event: delivered(event) },
            this.limits.deliveryAckTimeoutMs,
          )
          parseKernelResult('event.deliver', answer)
          await this.deps.cursors.put(advanced(cursor, event))
        } catch (err) {
          await this.deps.cursors.put(this.retried(cursor, event, err))
          return
        }
      }
    } finally {
      session.delivering = false
    }
  }

  private retried(cursor: EventCursor, event: KernelEvent, err: unknown): EventCursor {
    const now = this.now()
    const failingSince = cursor.failingSince ? Date.parse(cursor.failingSince) : now
    if (now - failingSince >= this.limits.deliveryGiveUpMs) {
      this.log(
        `dropped event ${event.id} (${event.type}) for module ${cursor.moduleId} after ${cursor.attempts + 1} attempts: ${err instanceof Error ? err.message : String(err)}`,
      )
      return advanced(cursor, event)
    }
    const attempts = cursor.attempts + 1
    const wait = Math.min(this.limits.deliveryRetryBaseMs * 2 ** (attempts - 1), this.limits.deliveryRetryMaxMs)
    return {
      ...cursor,
      attempts,
      failingSince: new Date(failingSince).toISOString(),
      nextAttemptAt: new Date(now + wait).toISOString(),
    }
  }

  // ─── Failure detection and switching off loudly (§4.6) ─────────────────────

  /** One watchdog pass (also callable from specs): ready, heartbeats, ee's view. */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      for (const record of await this.deps.store.list()) {
        if (record.state === 'connecting') {
          const since = this.connectingSince.get(record.id) ?? Date.parse(record.stateSince)
          if (now - since > this.limits.readyTimeoutMs) {
            await this.fail(record.id, 'it did not start within a minute')
            continue
          }
        }
        if (record.state === 'running') {
          const seen = this.sessions.get(record.id)?.lastBeat ?? this.lastSeen.get(record.id) ?? Date.parse(record.stateSince)
          if (now - seen > this.limits.heartbeatMissMs) {
            await this.fail(record.id, 'it stopped answering')
            continue
          }
        }
        if (record.state === 'running' || record.state === 'connecting') await this.watchEe(record)
      }
    } catch (err) {
      this.log(`watchdog pass failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.ticking = false
    }
  }

  private async watchEe(record: ModuleRecord): Promise<void> {
    const view = await this.deps.workload.get(record.id)
    if (!view || view.commit !== record.commit) return
    if (view.state === 'failed') {
      await this.fail(record.id, 'it stopped running')
      return
    }
    const last = this.lastRestartCount.get(record.id)
    this.lastRestartCount.set(record.id, view.restarts)
    if (last === undefined || view.restarts <= last) return
    const now = this.now()
    const recent = (this.restarts.get(record.id) ?? []).filter((t) => now - t < this.limits.restartWindowMs)
    for (let i = last; i < view.restarts; i++) recent.push(now)
    this.restarts.set(record.id, recent)
    if (recent.length >= this.limits.restartLimit) await this.fail(record.id, 'it kept restarting')
  }

  private async violation(id: string, what: string): Promise<void> {
    const now = this.now()
    const recent = (this.violations.get(id) ?? []).filter((t) => now - t < this.limits.violationWindowMs)
    recent.push(now)
    this.violations.set(id, recent)
    this.log(`module ${id} broke the protocol: ${what}`)
    if (recent.length >= this.limits.violationLimit) {
      await this.fail(id, 'it kept breaking its contract').catch((err: unknown) =>
        this.log(`switching off ${id} failed: ${String(err)}`),
      )
    }
  }

  /**
   * Switches a failing module off loudly: state `failed` with a sentence, ee
   * stops it (reason failed), `module.failed`; the Needs you entry and the
   * module page read the sentence from the record. Data is never touched.
   */
  async fail(id: string, because: string): Promise<void> {
    const record = await this.deps.store.get(id)
    if (!record || !isLive(record.state)) return
    const sentence = `${nameOf(record)} is switched off because ${because}. Its data is kept.`
    await this.deps.store.put({
      ...record,
      state: 'failed',
      reason: sentence,
      stateSince: new Date(this.now()).toISOString(),
      deployedFrom: null,
    })
    this.dropSession(id)
    this.connectingSince.delete(id)
    try {
      await this.deps.workload.stop(id, { author: HOST_AUTHOR, reason: 'failed', sentence })
    } catch (err) {
      this.log(`ee could not stop failed module ${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
    await this.emit('module.failed', record, { sentence })
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async writeHandOff(version: PublishedVersion, bytes: Uint8Array): Promise<void> {
    const dir = join(this.deps.stateDir(), MODULE_BUNDLE_HANDOFF_DIR)
    await mkdir(dir, { recursive: true, mode: 0o755 })
    await writeFile(join(dir, moduleBundleHandoffName(version.moduleId, version.bundleSha256)), bytes, {
      mode: 0o644,
    })
  }

  private async handOff(version: PublishedVersion): Promise<string> {
    await this.writeHandOff(version, await this.deps.bundles.bytes(version.moduleId, version.commit))
    const token = newModuleToken()
    await this.deps.principals.setTokenHash(version.moduleId, moduleTokenHash(token))
    return token
  }

  private dropSession(id: string): void {
    const s = this.sessions.get(id)
    this.sessions.delete(id)
    s?.conn.close()
  }

  private resetCounters(id: string): void {
    this.violations.delete(id)
    this.restarts.delete(id)
    this.lastRestartCount.delete(id)
  }

  private async requireRecord(id: string): Promise<ModuleRecord> {
    const record = await this.deps.store.get(id)
    if (!record) throw new KernelError('unknown_module', `there is no company module ${id}`, { module: id })
    return record
  }

  private async emit(
    type:
      | 'module.deployed'
      | 'module.failed'
      | 'module.recovered'
      | 'module.removed'
      | 'module.switched_off'
      | 'module.switched_on',
    record: ModuleRecord,
    extra: Record<string, unknown>,
    principalId = HOST_AUTHOR,
  ): Promise<void> {
    await emitKernelEvent(this.deps.eventSink, {
      type,
      principalId,
      source: moduleSource(kernelModuleId(record.id)),
      payload: { module: record.id, name: nameOf(record), commit: record.commit, ...extra },
    })
    await this.reportRun(type, record)
  }

  private async reportRun(type: string, record: ModuleRecord): Promise<void> {
    const state = RUN_STATE_OF[type]
    // module.recovered follows module.deployed for the same start: one report is enough.
    if (!this.deps.runReport || !state || !record.bundleSha256 || type === 'module.recovered') return
    try {
      await this.deps.runReport({ moduleId: record.id, bundleSha256: record.bundleSha256, state })
    } catch (err) {
      this.log(`could not tell the hub that module ${record.id} is ${state}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

const LIVE: readonly CompanyModuleState[] = ['deploying', 'connecting', 'running']
const isLive = (state: CompanyModuleState): boolean => LIVE.includes(state)

const localId = (kernelId: string): string => {
  if (!kernelId.startsWith('x-')) throw new Error(`${kernelId} is not a company module id`)
  return kernelId.slice(2)
}

export const nameOf = (record: ModuleRecord): string => record.manifest?.name ?? record.id

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.byteLength === y.byteLength && x.byteLength > 0 && timingSafeEqual(x, y)
}

export function newCursor(moduleId: string, startedAt: string): EventCursor {
  return { moduleId, lastTs: null, lastId: null, startedAt, attempts: 0, failingSince: null, nextAttemptAt: null }
}

function advanced(cursor: EventCursor, event: KernelEvent): EventCursor {
  return { ...cursor, lastTs: event.ts, lastId: event.id, attempts: 0, failingSince: null, nextAttemptAt: null }
}

function delivered(event: KernelEvent): Record<string, unknown> {
  return {
    id: event.id,
    ts: event.ts,
    type: event.type,
    ...(event.principalId === undefined || event.principalId === null ? {} : { principalId: event.principalId }),
    ...(event.source === undefined || event.source === null ? {} : { source: event.source }),
    payload: JSON.parse(JSON.stringify(event.payload ?? null)) as unknown,
  }
}
