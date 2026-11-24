import type { CompanyRepo, DesiredState } from './company-repo.ts'
import type { Journal } from './journal.ts'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { z } from 'zod'
import { ModuleBundleError, readBundle, sha256Hex } from '../../contracts/module-bundle.ts'
import {
  MODULE_MANIFEST_FILE,
  manifestSha256,
  safeParseModuleManifest,
  workloadName,
  type ModuleManifestV1,
} from '../../contracts/module-manifest.ts'
import { verifyReceipt } from '../../contracts/module-receipt.ts'
import {
  MODULE_BUNDLE_HANDOFF_DIR,
  MODULE_BUNDLE_STORE,
  MODULE_PROBLEM_TYPES,
  MODULE_RELEASES_KEPT,
  MODULE_TEST_TIMEOUT_MS,
  MODULE_TOKEN_ENV,
  MODULE_UNIT_ENV,
  deployModuleRequestSchema,
  moduleIdParam,
  moduleLogsQuerySchema,
  moduleRunStateSchema,
  moduleSocketDir,
  moduleUnitUser,
  removeModuleRequestSchema,
  startModuleRequestSchema,
  stopModuleRequestSchema,
  type DeployModuleRequest,
  type ModuleRunState,
  type ModuleView,
} from '../../contracts/module-workload.ts'
import { DeployRun, redact, secretValues } from './deploys.ts'
import { trustedHubKeys } from './hub-key.ts'
import { PATHS } from './paths.ts'
import { emit, prepareRelease, type PreparedRelease, type SecretAccess } from './reconcile.ts'
import { renderEnvFile } from './secrets.ts'
import { appContractSchema, assertInCatalog, CatalogGapError, RESERVED_ENV, workloadSchema, type AppContract, type Workload } from './spec.ts'
import { mustRun, type System } from './system.ts'
import { moduleUnitName, renderModuleUnit, MODULE_INACCESSIBLE } from './units.ts'

/**
 * Module workloads (plan/phase-upgrades-u2.md §5, §6.4): ee runs a vibe-coded
 * module only from bytes a trusted hub receipted — for build, test and run (D8).
 *
 *   POST   /v1/modules              deploy (or dryRun: build + test only)
 *   GET    /v1/modules              { modules: ModuleView[] }
 *   GET    /v1/modules/:id          { module } · 404 urn:ee:module_not_found
 *   POST   /v1/modules/:id/stop     { author, reason, sentence } → { module }
 *   POST   /v1/modules/:id/start    { author } → 202 { module }
 *   GET    /v1/modules/:id/logs     ?lines=200 → { lines } (redacted)
 *   DELETE /v1/modules/:id          { author } → { module } (its data stays in the data repo)
 *
 * How a deploy goes: the kernel writes the bundle into the hand-off dir; ee
 * copies it into its own store (root, 0600), checks the receipt (§6.4), builds
 * it in the sandboxed build unit and runs its tests in a separate unit with no
 * network and no secrets. Only a green test reaches the company repo, as
 * `workloads/mod-<id>.json` (tier module, the `module` field); the reconcile
 * then stops the old unit and starts the new one (one slot, D10) behind the
 * health gate. A failing test leaves the previous release running.
 *
 * The receipt is checked again on every reconcile: a desired state whose
 * receipt, manifest or bundle does not check out stops the module.
 */

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** Where ee keeps a module's bundles (root, 0600), and the path of one. */
export const bundleStoreDir = (id: string): string => `${MODULE_BUNDLE_STORE}/${moduleIdParam.parse(id)}`
export const storedBundlePath = (id: string, bundleSha256: string): string => `${bundleStoreDir(id)}/${bundleSha256}.tar.gz`
/** The module's EnvironmentFile (root, 0600, re-rendered on every reconcile; /run is a tmpfs). */
export const moduleEnvFile = (id: string): string => `${PATHS.envDir}/${workloadName(id)}.env`
/** The sealed-store scope that holds each module's EE_MODULE_TOKEN (internal: no verb can set it). */
export const MODULE_TOKEN_SCOPE = '_module-tokens'
/** The kernel's socket dir for this module (bind-mounted to /run/ee-module). */
export const socketDirOf = (id: string): string => moduleSocketDir(PATHS.osState, id)

/**
 * Env names a module secret can never take: what the module unit sets itself,
 * and what ee gives other workloads (EE_API_URL, DATABASE_URL, ee's own) — a
 * module never gets those, not even under a secret's name.
 */
export const MODULE_RESERVED_ENV: readonly string[] = [
  ...MODULE_UNIT_ENV,
  MODULE_TOKEN_ENV,
  'HOME',
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  ...RESERVED_ENV,
]

/** ee's health gate for a module: active, fewer than 3 restarts, for 10 s (the kernel decides real liveness, §4.6). */
export const MODULE_HEALTH = { stableMs: 10_000, deadlineMs: 60_000, maxRestarts: 3 } as const

// ─── Pure pieces ─────────────────────────────────────────────────────────────

export class ModuleError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export type ModuleCandidate = {
  id: string
  version: string
  commit: string
  manifest: unknown
  receipt: unknown
  /** The sha256 the desired state (or the request) pins. */
  sha256: string
  bytes: Uint8Array
}

export type ModuleVerdict = { ok: true; manifest: ModuleManifestV1 } | { ok: false; problem: string }

/**
 * §6.4, all of it, naming the first failure: the signature under a trusted hub
 * key; the module id, commit and version; the bundle's sha256 and the
 * manifest's; that the manifest parses (licence Apache-2.0); that the tarball
 * holds module.yaml. `installId` is not checked (U7 installs modules built
 * elsewhere). Plus ee's own rule: no secret may take a name the unit sets.
 */
export function verifyModule(c: ModuleCandidate, trustedSpki: readonly string[]): ModuleVerdict {
  const fail = (problem: string): ModuleVerdict => ({ ok: false, problem })
  const v = verifyReceipt(c.receipt, trustedSpki)
  if (!v.ok) return fail(v.problem)
  const r = v.receipt
  if (r.moduleId !== c.id) return fail(`the receipt is for module ${r.moduleId}, not ${c.id}`)
  if (r.commit !== c.commit) return fail(`the receipt is for commit ${r.commit}, not ${c.commit}`)
  if (r.version !== c.version) return fail(`the receipt is for version ${r.version}, not ${c.version}`)
  const actual = sha256Hex(c.bytes)
  if (actual !== c.sha256) return fail(`the bundle's sha256 is ${actual}, not ${c.sha256}`)
  if (r.bundleSha256 !== actual) return fail(`the receipt pins bundle ${r.bundleSha256}, not ${actual}`)
  const parsed = safeParseModuleManifest(c.manifest)
  if (!parsed.ok) {
    const p = parsed.problems[0]!
    return fail(`the manifest does not parse: ${p.path ? `${p.path}: ` : ''}${p.message}`)
  }
  const m = parsed.manifest
  if (m.id !== c.id) return fail(`the manifest is module ${m.id}, not ${c.id}`)
  if (m.version !== c.version) return fail(`the manifest is version ${m.version}, not ${c.version}`)
  if (m.license !== 'Apache-2.0') return fail(`the licence is ${String(m.license)}, not Apache-2.0`)
  const manifestSha = manifestSha256(c.manifest)
  if (r.manifestSha256 !== manifestSha) return fail(`the receipt pins manifest ${r.manifestSha256}, not ${manifestSha}`)
  let entries
  try {
    entries = readBundle(c.bytes).entries
  } catch (err) {
    if (err instanceof ModuleBundleError) return fail(err.message)
    throw err
  }
  if (!entries.some((e) => e.type === 'file' && e.path === MODULE_MANIFEST_FILE)) return fail(`the bundle holds no ${MODULE_MANIFEST_FILE}`)
  const taken = m.permissions.secrets.filter((s) => MODULE_RESERVED_ENV.includes(s))
  if (taken.length > 0) return fail(`permissions.secrets may not name ${taken.join(', ')} (ee sets or withholds those itself)`)
  return { ok: true, manifest: m }
}

/** The build contract a module workload runs with, derived from its manifest (it has no ee.json). */
export function moduleContract(m: ModuleManifestV1): AppContract {
  const parsed = appContractSchema.safeParse({
    runtime: 'node',
    node: m.runtime.node,
    build: m.build,
    start: m.start,
    health: '/',
    services: [],
    capabilities: m.permissions.capabilities,
  })
  if (!parsed.success) {
    const i = parsed.error.issues[0]!
    throw new CatalogGapError([`${i.path.join('.') || 'contract'}: ${i.message}`])
  }
  return parsed.data
}

/** `workloads/mod-<id>.json` for a receipted module (desired: running). */
export function moduleWorkload(
  i: Pick<DeployModuleRequest, 'id' | 'version' | 'commit' | 'manifest' | 'receipt' | 'sha256'>,
  m: ModuleManifestV1,
): Workload {
  return workloadSchema.parse({
    name: workloadName(i.id),
    tier: 'module',
    source: { kind: 'release', tarball: storedBundlePath(i.id, i.sha256), sha256: i.sha256 },
    secrets: m.permissions.secrets,
    resources: m.resources,
    contract: moduleContract(m),
    module: { id: i.id, version: i.version, commit: i.commit, manifest: i.manifest, receipt: i.receipt, desired: 'running', stopReason: null, sentence: null },
  })
}

export type ModuleWorkload = Workload & { module: NonNullable<Workload['module']>; source: { kind: 'release'; tarball: string; sha256: string } }

/** A workload ee runs on the module path (the generic reconcile leaves these alone). */
export function isModuleWorkload(w: Workload): w is ModuleWorkload {
  return w.module !== undefined
}

/**
 * POST /v1/secrets for a module (§5): only a name its receipted manifest declares
 * in permissions.secrets. null = allowed; else the 403 problem.
 */
export function moduleSecretRefusal(target: Workload, name: string): { type: string; title: string; detail: string } | null {
  if (!target.module) return null
  const parsed = safeParseModuleManifest(target.module.manifest)
  const declared = parsed.ok ? parsed.manifest.permissions.secrets : []
  if (declared.includes(name)) return null
  const detail = `module ${target.module.id} does not declare the secret ${name} (permissions.secrets: ${declared.join(', ') || 'none'}); a module gets only the secrets its receipted manifest declares`
  return { type: MODULE_PROBLEM_TYPES.secretUndeclared, title: 'secret not declared', detail }
}

/** A sentence a person reads: one line, at most 300 characters. */
function sentence(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= 300 ? line : `${line.slice(0, 299)}…`
}

const short = (commit: string) => commit.slice(0, 12)

// ─── ee's runtime record of each module ─────────────────────────────────────

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/

const releaseRef = z.object({ commit: z.string().regex(HEX40), bundleSha256: z.string().regex(HEX64) }).strict()

const moduleRecordSchema = z
  .object({
    state: moduleRunStateSchema,
    error: z.string().nullable(),
    since: z.string(),
    /** What runs: the release dir id and the fingerprint of release + unit + env. */
    live: z.object({ release: z.string(), fingerprint: z.string() }).strict().nullable(),
    /** A fingerprint (or prepare:<sha>) that failed: not retried until desired state changes or a person starts it. */
    failedFingerprint: z.string().nullable(),
    releases: z.array(releaseRef).max(MODULE_RELEASES_KEPT),
  })
  .strict()
type ModuleRecord = z.infer<typeof moduleRecordSchema>

const moduleStateSchema = z.object({ version: z.literal(1), modules: z.record(z.string(), moduleRecordSchema) }).strict()
type ModuleState = z.infer<typeof moduleStateSchema>

async function loadModuleState(sys: System): Promise<ModuleState> {
  const raw = await sys.readFile(PATHS.moduleState)
  if (raw === null) return { version: 1, modules: {} }
  return moduleStateSchema.parse(JSON.parse(raw))
}

async function saveModuleState(sys: System, s: ModuleState): Promise<void> {
  await sys.writeFile(PATHS.moduleState, JSON.stringify(s, null, 2) + '\n', 0o600)
}

function freshRecord(sys: System): ModuleRecord {
  return { state: 'starting', error: null, since: sys.now().toISOString(), live: null, failedFingerprint: null, releases: [] }
}

function setState(sys: System, rec: ModuleRecord, state: ModuleRunState, error: string | null): void {
  if (rec.state !== state) rec.since = sys.now().toISOString()
  rec.state = state
  rec.error = error === null ? null : sentence(error)
}

// ─── The module path of the reconcile ───────────────────────────────────────

export type ModuleIo = { readBytes(path: string): Promise<Uint8Array> }
export const defaultModuleIo: ModuleIo = { readBytes: async (p) => new Uint8Array(await readFile(p)) }

export type ModuleReconcileContext = {
  sys: System
  journal: Journal
  secrets: SecretAccess
  /** Health-gate timing (tests shorten nothing: the fake clock moves). */
  health?: Partial<typeof MODULE_HEALTH>
}

/** A failure already journaled for this module (reported by the pass, not journaled again). */
class ModuleFailure extends Error {}

async function unitActive(sys: System, unit: string): Promise<string> {
  return (await sys.run('systemctl', ['is-active', unit])).stdout.trim()
}

async function nRestarts(sys: System, unit: string): Promise<number> {
  return Number((await sys.run('systemctl', ['show', '-p', 'NRestarts', '--value', unit])).stdout.trim()) || 0
}

/** "active, NRestarts < 3, for 10 s": null when healthy, else the sentence why not. */
async function moduleHealthGate(ctx: ModuleReconcileContext, id: string): Promise<string | null> {
  const h = { ...MODULE_HEALTH, ...ctx.health }
  const unit = moduleUnitName(id)
  const started = ctx.sys.now().getTime()
  let activeSince: number | null = null
  for (;;) {
    const now = ctx.sys.now().getTime()
    const state = await unitActive(ctx.sys, unit)
    const restarts = await nRestarts(ctx.sys, unit)
    if (state === 'failed' || restarts >= h.maxRestarts) {
      const status = (await ctx.sys.run('systemctl', ['show', '-p', 'ExecMainStatus', '--value', unit])).stdout.trim()
      return `Module ${id} crashed on start (exit status ${status || 'unknown'}${restarts > 0 ? `, ${restarts} restarts` : ''}); its output is in the module log.`
    }
    if (state === 'active') {
      activeSince ??= now
      if (now - activeSince >= h.stableMs) return null
    } else activeSince = null
    if (now - started >= h.deadlineMs) return `Module ${id} did not stay running for ${Math.round(h.stableMs / 1000)} s within ${Math.round(h.deadlineMs / 1000)} s of its start.`
    await ctx.sys.sleep(1000)
  }
}

/** Remove bundles of this module that are neither among its last releases nor in use. */
async function pruneBundles(sys: System, id: string, keep: Set<string>): Promise<void> {
  const dir = bundleStoreDir(id)
  const listed = await sys.run('ls', ['-1', dir])
  if (listed.code !== 0) return
  for (const name of listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([0-9a-f]{64})\.tar\.gz$/.exec(name)
    if (m && !keep.has(m[1]!)) await sys.remove(`${dir}/${name}`)
  }
}

async function stopUnit(sys: System, id: string): Promise<void> {
  await sys.run('systemctl', ['stop', moduleUnitName(id)])
}

function moduleEnv(secrets: SecretAccess, w: ModuleWorkload, m: ModuleManifestV1): Record<string, string> {
  const all = secrets.all()
  const token = all[MODULE_TOKEN_SCOPE]?.[w.module.id]
  if (!token) throw new Error(`module ${w.module.id} has no ${MODULE_TOKEN_ENV} in ee's store; deploy it again`)
  const stored = all[w.name] ?? {}
  const values: Record<string, string> = { [MODULE_TOKEN_ENV]: token }
  // The declared secrets that have a value (§5); an unset one is simply not there.
  for (const name of m.permissions.secrets) if (stored[name] !== undefined) values[name] = stored[name]
  return values
}

/** Converge one module workload to its desired state. Throws ModuleFailure (journaled) or a plain error. */
async function reconcileModule(
  ctx: ModuleReconcileContext,
  w: ModuleWorkload,
  rec: ModuleRecord,
  trusted: { keys: string[] } | { error: string },
  io: ModuleIo,
): Promise<void> {
  const { sys, journal } = ctx
  const { id, commit } = w.module
  const data = { module: id, commit, bundleSha256: w.source.sha256 }
  const failed = (message: string, extra: Record<string, unknown> = {}): never => {
    const text = sentence(message)
    // Journal a failure once: the same one on the next tick is not a new event.
    if (rec.state !== 'failed' || rec.error !== text) emit(journal, sys, 'module.failed', w.name, text, { ...data, ...extra })
    setState(sys, rec, 'failed', text)
    throw new ModuleFailure(`${w.name}: ${text}`)
  }

  // §6.4 on every reconcile: a desired state that does not check out never runs.
  const bytes: Uint8Array | null = await io.readBytes(w.source.tarball).catch(() => null)
  const verdict: ModuleVerdict =
    'error' in trusted
      ? { ok: false, problem: trusted.error }
      : bytes === null
        ? { ok: false, problem: `its bundle ${w.source.tarball} is missing from ee's store (deploy it again)` }
        : verifyModule({ id, version: w.module.version, commit, manifest: w.module.manifest, receipt: w.module.receipt, sha256: w.source.sha256, bytes }, trusted.keys)
  if (!verdict.ok) {
    await stopUnit(sys, id)
    rec.live = null
    failed(`Module ${id} is stopped because its receipt does not check out: ${verdict.problem}.`, { stage: 'receipt' })
  }
  const manifest = (verdict as { ok: true; manifest: ModuleManifestV1 }).manifest

  if (w.module.desired === 'stopped') {
    if ((await unitActive(sys, moduleUnitName(id))) !== 'inactive' || rec.state !== 'stopped') {
      await stopUnit(sys, id)
      if (rec.state !== 'stopped') emit(journal, sys, 'module.stopped', w.name, `module ${id} stopped (${w.module.stopReason}): ${w.module.sentence}`, { ...data, reason: w.module.stopReason })
    }
    rec.live = null
    setState(sys, rec, 'stopped', w.module.sentence)
    return
  }

  // Build in the sandboxed build unit, once per release (a no-op once built).
  const prepFingerprint = `prepare:${sha(JSON.stringify(w))}`
  if (rec.failedFingerprint === prepFingerprint) {
    throw new ModuleFailure(`${w.name}: ${rec.error ?? 'its last build failed'} (unchanged since; deploy a new commit)`)
  }
  const built: { run: DeployRun | null } = { run: null }
  let rel: PreparedRelease
  try {
    rel = await prepareRelease(sys, w, () => (built.run ??= new DeployRun(sys, journal, w.name, () => secretValues(ctx.secrets.all()))))
  } catch (err) {
    rec.failedFingerprint = prepFingerprint
    rec.live = null
    await stopUnit(sys, id)
    const r = built.run
    if (r) await r.fail((err as Error).message)
    failed(`Module ${id} could not be built: ${(err as Error).message}`, { stage: 'build', ...(r ? { deployId: r.record.id } : {}) })
  }
  if (built.run !== null) {
    await built.run.succeed(rel!.id)
    emit(journal, sys, 'module.built', w.name, `module ${id} ${short(commit)} built (release ${rel!.id})`, { ...data, release: rel!.id })
  }

  const socketDir = socketDirOf(id)
  if (!(await sys.exists(socketDir))) {
    failed(`Module ${id} can't start: eigenEnterprise has not opened its socket directory ${socketDir} yet.`, { stage: 'socket' })
  }
  // The module user only traverses it (the kernel's socket inside is 0666): the os workload's UMask makes it 0700.
  await mustRun(sys, 'chmod', ['711', socketDir])

  const envText = renderEnvFile(moduleEnv(ctx.secrets, w, manifest))
  const unitText = renderModuleUnit({
    id,
    commit,
    start: manifest.start,
    node: manifest.runtime.node,
    resources: manifest.resources,
    releaseDir: rel!.dir,
    socketDir,
    envFile: moduleEnvFile(id),
  })
  const fingerprint = sha(JSON.stringify({ release: rel!.id, unit: unitText, env: sha(envText) }))
  const unit = moduleUnitName(id)
  // /run is a tmpfs: the env file is written on every pass (also the first after a reboot).
  await sys.writeFile(moduleEnvFile(id), envText, 0o600)

  const active = await unitActive(sys, unit)
  if (rec.live?.fingerprint === fingerprint && active === 'active') {
    if (rec.state !== 'running') setState(sys, rec, 'running', null)
    return
  }
  if (rec.failedFingerprint === fingerprint) {
    throw new ModuleFailure(`${w.name}: ${rec.error ?? 'its last start failed'} (unchanged since; deploy a new commit or start it again)`)
  }

  // One slot (D10): stop the old unit, start the new one, behind the health gate.
  await sys.writeFile(`${PATHS.unitDir}/${unit}`, unitText, 0o644)
  await mustRun(sys, 'systemctl', ['daemon-reload'])
  await sys.run('systemctl', ['reset-failed', unit])
  setState(sys, rec, 'starting', null)
  await sys.run('systemctl', ['restart', unit])
  const failure = await moduleHealthGate(ctx, id)
  if (failure) {
    await stopUnit(sys, id)
    rec.live = null
    rec.failedFingerprint = fingerprint
    failed(failure, { stage: 'health' })
  }
  rec.live = { release: rel!.id, fingerprint }
  rec.failedFingerprint = null
  rec.releases = [{ commit, bundleSha256: w.source.sha256 }, ...rec.releases.filter((r) => r.bundleSha256 !== w.source.sha256)].slice(0, MODULE_RELEASES_KEPT)
  setState(sys, rec, 'running', null)
  emit(journal, sys, 'module.running', w.name, `module ${id} ${short(commit)} is running as ${moduleUnitUser(id)}`, { ...data, release: rel!.id })
  await pruneBundles(sys, id, new Set(rec.releases.map((r) => r.bundleSha256)))
}

/** A module no longer desired: stop it and forget ee's copies (its data stays in the data repo). */
async function removeModule(ctx: ModuleReconcileContext, id: string): Promise<void> {
  const { sys } = ctx
  const unit = moduleUnitName(id)
  await sys.run('systemctl', ['stop', unit])
  await sys.run('systemctl', ['reset-failed', unit])
  await sys.remove(`${PATHS.unitDir}/${unit}`)
  await sys.remove(moduleEnvFile(id))
  await sys.remove(`${PATHS.workloads}/${workloadName(id)}`)
  await sys.remove(bundleStoreDir(id))
  await mustRun(sys, 'systemctl', ['daemon-reload'])
  emit(ctx.journal, sys, 'module.removed', workloadName(id), `module ${id} removed: its unit and ee's copies of its code are gone; its data stays in the data repo`, { module: id })
}

/**
 * The module path of the reconcile (reconcile.ts calls it after the other
 * workloads): every module workload converges; modules no longer desired are
 * removed. Returns the errors to report (each already journaled).
 */
export async function reconcileModules(ctx: ModuleReconcileContext, desired: DesiredState, io: ModuleIo = defaultModuleIo): Promise<string[]> {
  const mods = desired.workloads.filter(isModuleWorkload)
  const raw = await ctx.sys.readFile(PATHS.moduleState)
  if (mods.length === 0 && raw === null) return []
  const state = raw === null ? { version: 1 as const, modules: {} } : moduleStateSchema.parse(JSON.parse(raw))
  let trusted: { keys: string[] } | { error: string }
  try {
    trusted = { keys: trustedHubKeys(desired.settings.moduleHub) }
  } catch (err) {
    trusted = { error: (err as Error).message }
  }
  const errors: string[] = []
  for (const w of mods) {
    const rec = (state.modules[w.module.id] ??= freshRecord(ctx.sys))
    try {
      await reconcileModule(ctx, w, rec, trusted, io)
    } catch (err) {
      const message = (err as Error).message
      if (!(err instanceof ModuleFailure)) {
        // Unexpected (ee's own seam failed): journal it once, as for any failure.
        const text = sentence(`Module ${w.module.id} could not be reconciled: ${message}`)
        if (rec.error !== text) emit(ctx.journal, ctx.sys, 'module.failed', w.name, text, { module: w.module.id, commit: w.module.commit })
        setState(ctx.sys, rec, 'failed', text)
      }
      errors.push(message)
    }
  }
  const ids = new Set(mods.map((w) => w.module.id))
  for (const id of Object.keys(state.modules)) {
    if (ids.has(id)) continue
    await removeModule(ctx, id)
    delete state.modules[id]
  }
  await saveModuleState(ctx.sys, state)
  return errors
}

// ─── The verbs ───────────────────────────────────────────────────────────────

export type ModuleServiceDeps = {
  sys: System
  repo: Pick<CompanyRepo, 'read'>
  secrets: SecretAccess
  journal(): Journal
  /** Journal an event and save the journal. */
  emit(type: string, workload: string, message: string, data: Record<string, unknown>): Promise<void>
  /** Commit a desired-state change, then converge (Ee.change). */
  change(message: string, author: string, mutate: Parameters<CompanyRepo['commit']>[2]): Promise<{ rev: string; reconcileError: string | null }>
  /** ee's one mutation queue (the reconcile runs in it too). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  io: ModuleIo
}

type Candidate = { version: string; commit: string; bundleSha256: string }
type Job = { state: 'building' | 'testing' | 'starting'; candidate: Candidate; since: string; dryRun: boolean }
/** How the last deploy that never reached the desired state ended (a failed test, a failed build). */
type Outcome = { candidate: Candidate; error: string; since: string }

export class ModuleService {
  private readonly d: ModuleServiceDeps
  private readonly jobs = new Map<string, Job>()
  private readonly outcomes = new Map<string, Outcome>()
  private readonly running = new Set<Promise<void>>()

  constructor(deps: Omit<ModuleServiceDeps, 'io'> & Partial<Pick<ModuleServiceDeps, 'io'>>) {
    this.d = { io: defaultModuleIo, ...deps }
  }

  private get sys(): System {
    return this.d.sys
  }

  /** Every deploy in flight has finished (tests). */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running])
  }

  private async desiredModule(id: string): Promise<ModuleWorkload | null> {
    const desired = await this.d.repo.read()
    return desired.workloads.filter(isModuleWorkload).find((w) => w.module.id === id) ?? null
  }

  private async record(id: string): Promise<ModuleRecord | null> {
    return (await loadModuleState(this.sys)).modules[id] ?? null
  }

  private async view(id: string, w: ModuleWorkload | null): Promise<ModuleView | null> {
    const job = this.jobs.get(id)
    const outcome = this.outcomes.get(id)
    const rec = await this.record(id)
    const base = w ? { version: w.module.version, commit: w.module.commit, bundleSha256: w.source.sha256 } : null
    const releases = rec?.releases ?? []
    if (job && (!job.dryRun || !w)) {
      return {
        id,
        workload: workloadName(id),
        ...job.candidate,
        desired: 'running',
        stopReason: null,
        state: job.state,
        error: null,
        restarts: 0,
        since: job.since,
        releases,
      }
    }
    if (!w || !base) {
      if (!outcome) return null
      return { id, workload: workloadName(id), ...outcome.candidate, desired: 'stopped', stopReason: null, state: 'failed', error: outcome.error, restarts: 0, since: outcome.since, releases }
    }
    const state: ModuleRunState = rec?.state ?? (w.module.desired === 'running' ? 'starting' : 'stopped')
    const restarts = state === 'running' ? await nRestarts(this.sys, moduleUnitName(id)) : 0
    return {
      id,
      workload: w.name,
      ...base,
      desired: w.module.desired,
      stopReason: w.module.stopReason,
      state,
      error: outcome?.error ?? rec?.error ?? null,
      restarts,
      since: rec?.since ?? this.sys.now().toISOString(),
      releases,
    }
  }

  async list(): Promise<ModuleView[]> {
    const desired = await this.d.repo.read()
    const ids = new Set([...desired.workloads.filter(isModuleWorkload).map((w) => w.module.id), ...this.jobs.keys(), ...this.outcomes.keys()])
    const views: ModuleView[] = []
    for (const id of [...ids].sort()) {
      const v = await this.view(id, desired.workloads.filter(isModuleWorkload).find((w) => w.module.id === id) ?? null)
      if (v) views.push(v)
    }
    return views
  }

  async get(id: string): Promise<ModuleView> {
    const v = moduleIdParam.safeParse(id).success ? await this.view(id, await this.desiredModule(id)) : null
    if (!v) throw new ModuleError(404, MODULE_PROBLEM_TYPES.moduleNotFound, `no module ${id}`)
    return v
  }

  /** Copy the kernel's hand-off into ee's store, then check that copy (it cannot change underneath). */
  private async takeBundle(handoff: string, id: string, bundleSha256: string): Promise<string> {
    const kind = await this.sys.run('stat', ['-c', '%F', '--', handoff])
    if (kind.code !== 0) throw new ModuleError(422, MODULE_PROBLEM_TYPES.receiptInvalid, `no bundle at ${handoff}`)
    if (kind.stdout.trim() !== 'regular file') {
      throw new ModuleError(422, MODULE_PROBLEM_TYPES.receiptInvalid, `the bundle ${handoff} is a ${kind.stdout.trim()}, not a regular file`)
    }
    const dir = bundleStoreDir(id)
    await this.sys.mkdirp(MODULE_BUNDLE_STORE, 0o700)
    await this.sys.mkdirp(dir, 0o700)
    const incoming = `${dir}/.incoming-${randomUUID().slice(0, 8)}`
    await mustRun(this.sys, 'cp', ['--no-dereference', '--', handoff, incoming])
    try {
      const copied = await this.sys.run('stat', ['-c', '%F', '--', incoming])
      if (copied.stdout.trim() !== 'regular file') {
        throw new ModuleError(422, MODULE_PROBLEM_TYPES.receiptInvalid, `the bundle ${handoff} changed into a ${copied.stdout.trim()} while it was copied`)
      }
      const actual = await this.sys.sha256File(incoming)
      if (actual !== bundleSha256) {
        throw new ModuleError(422, MODULE_PROBLEM_TYPES.receiptInvalid, `the bundle's sha256 is ${actual}, not ${bundleSha256}`)
      }
      await mustRun(this.sys, 'chown', ['root:root', incoming])
      await mustRun(this.sys, 'chmod', ['600', incoming])
      const stored = storedBundlePath(id, bundleSha256)
      await mustRun(this.sys, 'mv', ['-f', '--', incoming, stored])
      return stored
    } catch (err) {
      await this.sys.remove(incoming)
      throw err
    }
  }

  /** POST /v1/modules: 202 { module } (or, with dryRun, 200 { passed, log }). */
  async deploy(raw: unknown): Promise<{ status: number; data: unknown }> {
    const parsed = deployModuleRequestSchema.safeParse(raw)
    if (!parsed.success) throw new ModuleError(400, 'urn:ee:invalid_input', parsed.error.message)
    const i = parsed.data
    const handoff = `${PATHS.osState}/${MODULE_BUNDLE_HANDOFF_DIR}/${i.tarball}`
    if (posix.normalize(handoff) !== handoff || posix.dirname(handoff) !== PATHS.moduleHandoff) {
      throw new ModuleError(422, MODULE_PROBLEM_TYPES.receiptInvalid, `the bundle must be in ${PATHS.moduleHandoff}, not ${handoff}`)
    }
    // From here on the hand-off is ee's: it is deleted whatever the answer.
    try {
      const busy = this.jobs.get(i.id)
      if (busy) throw new ModuleError(409, MODULE_PROBLEM_TYPES.moduleBusy, `module ${i.id} is ${busy.state} already (${short(busy.candidate.commit)})`)
      const candidate: Candidate = { version: i.version, commit: i.commit, bundleSha256: i.sha256 }
      const job: Job = { state: 'building', candidate, since: this.sys.now().toISOString(), dryRun: i.dryRun === true }
      // Taken before the first await below, so a second deploy of the same id is busy.
      this.jobs.set(i.id, job)
      let w: ModuleWorkload
      let manifest: ModuleManifestV1
      try {
        const desired = await this.d.repo.read()
        let keys: string[]
        try {
          keys = trustedHubKeys(desired.settings.moduleHub)
        } catch (err) {
          throw new ModuleError(422, MODULE_PROBLEM_TYPES.receiptInvalid, (err as Error).message)
        }
        const stored = await this.takeBundle(handoff, i.id, i.sha256)
        const keep = new Set(desired.workloads.filter(isModuleWorkload).filter((x) => x.module.id === i.id).map((x) => x.source.sha256))
        const verdict = verifyModule({ ...i, bytes: await this.d.io.readBytes(stored) }, keys)
        if (!verdict.ok) {
          if (!keep.has(i.sha256)) await this.sys.remove(stored)
          throw new ModuleError(422, MODULE_PROBLEM_TYPES.receiptInvalid, verdict.problem)
        }
        manifest = verdict.manifest
        try {
          w = moduleWorkload(i, manifest) as ModuleWorkload
          assertInCatalog(w.contract!, 'module')
        } catch (err) {
          if (!keep.has(i.sha256)) await this.sys.remove(stored)
          if (err instanceof CatalogGapError) throw new ModuleError(422, MODULE_PROBLEM_TYPES.catalogGap, err.message, { missing: err.missing })
          throw err
        }
      } catch (err) {
        this.jobs.delete(i.id)
        throw err
      }
      if (job.dryRun) {
        try {
          const r = await this.buildAndTest(w, manifest, job, i.author)
          return { status: 200, data: { passed: r.passed, log: r.log.slice(-1024 * 1024) } }
        } finally {
          this.jobs.delete(i.id)
          await this.dropUnusedBundle(i.id, i.sha256)
        }
      }
      this.outcomes.delete(i.id)
      await this.d.emit('module.deploying', w.name, `module ${i.id} ${short(i.commit)} deploying (by ${i.author})`, { module: i.id, commit: i.commit, author: i.author })
      const done = this.pipeline(w, manifest, job, i)
      this.running.add(done)
      void done.finally(() => this.running.delete(done))
      return { status: 202, data: { module: await this.view(i.id, await this.desiredModule(i.id)) } }
    } finally {
      await this.sys.remove(handoff)
    }
  }

  /** A bundle that never reached the desired state goes again (the hub keeps every published version). */
  private async dropUnusedBundle(id: string, bundleSha256: string): Promise<void> {
    const w = await this.desiredModule(id)
    const rec = await this.record(id)
    if (w?.source.sha256 === bundleSha256 || rec?.releases.some((r) => r.bundleSha256 === bundleSha256)) return
    await this.sys.remove(storedBundlePath(id, bundleSha256))
  }

  /** Build (sandboxed build unit) then test (no network, no secrets); the log goes to the deploy record. */
  private async buildAndTest(w: ModuleWorkload, manifest: ModuleManifestV1, job: Job, author: string): Promise<{ passed: boolean; log: string; run: DeployRun; release: PreparedRelease | null }> {
    const run = new DeployRun(this.sys, this.d.journal(), w.name, () => secretValues(this.d.secrets.all()))
    let rel: PreparedRelease
    try {
      rel = await prepareRelease(this.sys, w, () => run)
    } catch (err) {
      const message = `Module ${w.module.id} ${short(w.module.commit)} could not be built: ${(err as Error).message}`
      run.log('build', message)
      await run.fail(message)
      await this.d.emit('module.test_failed', w.name, sentence(message), { module: w.module.id, commit: w.module.commit, stage: 'build', deployId: run.record.id, author })
      return { passed: false, log: run.lines().join('\n'), run, release: null }
    }
    await this.d.emit('module.built', w.name, `module ${w.module.id} ${short(w.module.commit)} built (release ${rel.id})`, { module: w.module.id, commit: w.module.commit, release: rel.id, deployId: run.record.id })
    job.state = 'testing'
    const failure = await this.runTests(w, manifest, rel, run)
    if (failure) {
      await run.fail(failure)
      await this.d.emit('module.test_failed', w.name, sentence(failure), { module: w.module.id, commit: w.module.commit, stage: 'test', deployId: run.record.id, author, logs: run.tail(60) })
      return { passed: false, log: run.lines().join('\n'), run, release: rel }
    }
    return { passed: true, log: run.lines().join('\n'), run, release: rel }
  }

  /**
   * The manifest's test steps, in a transient unit as ee-build on a scratch copy
   * of the release: PrivateNetwork, unix sockets only, no env file, the module's
   * memory, 10 minutes for all steps. null = green, else the sentence why not.
   */
  private async runTests(w: ModuleWorkload, manifest: ModuleManifestV1, rel: PreparedRelease, run: DeployRun): Promise<string | null> {
    const sys = this.sys
    const id = w.module.id
    const scratch = `${PATHS.workloads}/${w.name}/test-${sys.now().getTime()}-${randomUUID().slice(0, 8)}`
    const nodeDir = `${PATHS.runtimes}/node-${manifest.runtime.node}/bin`
    const deadline = sys.now().getTime() + MODULE_TEST_TIMEOUT_MS
    await mustRun(sys, 'cp', ['-a', '--', rel.dir, scratch])
    try {
      await mustRun(sys, 'chown', ['-R', 'ee-build:ee-build', scratch])
      for (const step of manifest.test) {
        const left = Math.floor((deadline - sys.now().getTime()) / 1000)
        if (left <= 0) return `Module ${id} ${short(w.module.commit)} failed its tests: they ran longer than ${MODULE_TEST_TIMEOUT_MS / 60_000} minutes; the previous release keeps running.`
        const [program, ...args] = step
        const resolved = program === 'node' || program === 'npm' || program === 'npx' ? `${nodeDir}/${program}` : program!
        const r = await sys.run(
          'systemd-run',
          [
            '--wait',
            '--pipe',
            '--collect',
            '--quiet',
            `--unit=ee-mod-test-${id}-${sys.now().getTime()}`,
            '-p', 'User=ee-build',
            '-p', 'Group=ee-build',
            '-p', 'PrivateNetwork=yes',
            '-p', 'IPAddressDeny=any',
            '-p', 'RestrictAddressFamilies=AF_UNIX',
            '-p', 'NoNewPrivileges=yes',
            '-p', 'ProtectSystem=strict',
            '-p', 'ProtectHome=yes',
            '-p', 'PrivateTmp=yes',
            '-p', 'PrivateDevices=yes',
            '-p', 'TemporaryFileSystem=/var/lib:ro /run:ro',
            '-p', `BindPaths=${scratch}`,
            '-p', `InaccessiblePaths=${MODULE_INACCESSIBLE.map((p) => `-${p}`).join(' ')}`,
            '-p', `MemoryMax=${Math.min(manifest.resources.memoryMb, 1024)}M`,
            '-p', `RuntimeMaxSec=${left}`,
            `--working-directory=${scratch}`,
            '-E', `PATH=${nodeDir}:/usr/bin:/bin`,
            '-E', 'HOME=/tmp',
            '-E', 'NODE_ENV=test',
            '-E', 'npm_config_cache=/tmp/npm-cache',
            '-E', 'npm_config_update_notifier=false',
            '-E', 'npm_config_offline=true',
            resolved,
            ...args,
          ],
          { timeoutMs: (left + 60) * 1000 },
        )
        run.log('test', `$ ${step.join(' ')}\n${[r.stdout, r.stderr].filter((t) => t.trim()).join('\n').trimEnd()}`)
        if (r.code !== 0) {
          return `Module ${id} ${short(w.module.commit)} failed its tests (\`${step.join(' ')}\` exited ${r.code}); the previous release keeps running.`
        }
      }
      return null
    } finally {
      await sys.remove(scratch)
    }
  }

  /** build → test → (green) the desired state → the reconcile's stop-then-start. */
  private async pipeline(w: ModuleWorkload, manifest: ModuleManifestV1, job: Job, i: DeployModuleRequest): Promise<void> {
    const id = i.id
    try {
      const r = await this.buildAndTest(w, manifest, job, i.author)
      if (!r.passed) {
        const failure = r.run.record.error ?? `Module ${id} ${short(i.commit)} failed its tests; the previous release keeps running.`
        this.outcomes.set(id, { candidate: job.candidate, error: sentence(failure), since: this.sys.now().toISOString() })
        await this.dropUnusedBundle(id, i.sha256)
        return
      }
      job.state = 'starting'
      // The new token goes in with the commit that uses it; until then the running release keeps its own.
      await this.d.exclusive(async () => {
        await this.d.secrets.set(MODULE_TOKEN_SCOPE, id, i.token)
        // An explicit deploy retries a commit that failed to start before.
        const s = await loadModuleState(this.sys)
        const rec = s.modules[id]
        if (rec) {
          rec.failedFingerprint = null
          await saveModuleState(this.sys, s)
        }
      })
      const { reconcileError } = await this.d.change(`module: ${id} @ ${short(i.commit)}`, i.author, (s) => ({
        ...s,
        workloads: [...s.workloads.filter((x) => x.name !== w.name), w],
      }))
      const rec = await this.record(id)
      if (rec?.state === 'running' && rec.live) await r.run.succeed(rec.live.release)
      else await r.run.fail(rec?.error ?? reconcileError ?? `module ${id} did not start`)
    } catch (err) {
      const message = sentence(`Module ${id} ${short(i.commit)} could not be deployed: ${(err as Error).message}`)
      this.outcomes.set(id, { candidate: job.candidate, error: message, since: this.sys.now().toISOString() })
      await this.d.emit('module.failed', workloadName(id), message, { module: id, commit: i.commit })
    } finally {
      this.jobs.delete(id)
    }
  }

  private async mustExist(id: string): Promise<ModuleWorkload> {
    const w = moduleIdParam.safeParse(id).success ? await this.desiredModule(id) : null
    if (!w) throw new ModuleError(404, MODULE_PROBLEM_TYPES.moduleNotFound, `no module ${id}`)
    return w
  }

  /** POST /v1/modules/:id/stop: a person's off, or the kernel switching a failing module off (§4.6). */
  async stop(id: string, raw: unknown): Promise<ModuleView> {
    const i = stopModuleRequestSchema.parse(raw)
    const w = await this.mustExist(id)
    await this.d.change(`module: stop ${id} (${i.reason})`, i.author, (s) => ({
      ...s,
      workloads: s.workloads.map((x) => (x.name === w.name && x.module ? { ...x, module: { ...x.module, desired: 'stopped', stopReason: i.reason, sentence: sentence(i.sentence) } } : x)),
    }))
    return this.get(id)
  }

  /** POST /v1/modules/:id/start: run it again (retries a commit that failed to start). */
  async start(id: string, raw: unknown): Promise<ModuleView> {
    const i = startModuleRequestSchema.parse(raw)
    const w = await this.mustExist(id)
    await this.d.exclusive(async () => {
      const s = await loadModuleState(this.sys)
      const rec = s.modules[id]
      if (rec?.failedFingerprint) {
        rec.failedFingerprint = null
        await saveModuleState(this.sys, s)
      }
    })
    this.outcomes.delete(id)
    await this.d.change(`module: start ${id}`, i.author, (s) => ({
      ...s,
      workloads: s.workloads.map((x) => (x.name === w.name && x.module ? { ...x, module: { ...x.module, desired: 'running', stopReason: null, sentence: null } } : x)),
    }))
    return this.get(id)
  }

  /** DELETE /v1/modules/:id: stop and remove it; its data stays in the data repo. */
  async remove(id: string, raw: unknown): Promise<ModuleView> {
    const i = removeModuleRequestSchema.parse(raw)
    const w = await this.mustExist(id)
    if (this.jobs.has(id)) throw new ModuleError(409, MODULE_PROBLEM_TYPES.moduleBusy, `module ${id} is ${this.jobs.get(id)!.state}; remove it once that finished`)
    const before = (await this.view(id, w))!
    await this.d.change(`module: remove ${id}`, i.author, (s) => ({ ...s, workloads: s.workloads.filter((x) => x.name !== w.name) }))
    this.outcomes.delete(id)
    return { ...before, desired: 'stopped', state: 'stopped', error: null, restarts: 0, since: this.sys.now().toISOString() }
  }

  /** GET /v1/modules/:id/logs: the unit's journal, every stored secret value masked. */
  async logs(id: string, query: Record<string, string>): Promise<{ lines: string[] }> {
    const q = moduleLogsQuerySchema.parse(query)
    await this.mustExist(id)
    const out = await this.sys.run('journalctl', ['-u', moduleUnitName(id), '-n', String(q.lines), '--no-pager', '-o', 'short-iso'])
    const values = secretValues(this.d.secrets.all())
    return { lines: redact(out.stdout, values).split('\n').filter((l) => l !== '') }
  }
}

const MODULE_PATH = /^(GET|POST|DELETE) \/v1\/modules(?:\/([^/]+)(?:\/(stop|start|logs))?)?$/

/** The module verbs of the control API (daemon.ts). */
export async function moduleRoute(
  svc: ModuleService,
  route: string,
  query: URLSearchParams,
  readBody: () => Promise<unknown>,
): Promise<{ status: number; data: unknown } | null> {
  const m = MODULE_PATH.exec(route)
  if (!m) return null
  const [, method, id, verb] = m
  try {
    if (!id && method === 'POST') return await svc.deploy(await readBody())
    if (!id && method === 'GET') return { status: 200, data: { modules: await svc.list() } }
    if (id && !verb && method === 'GET') return { status: 200, data: { module: await svc.get(id) } }
    if (id && verb === 'stop' && method === 'POST') return { status: 200, data: { module: await svc.stop(id, await readBody()) } }
    if (id && verb === 'start' && method === 'POST') return { status: 202, data: { module: await svc.start(id, await readBody()) } }
    if (id && verb === 'logs' && method === 'GET') return { status: 200, data: await svc.logs(id, Object.fromEntries(query)) }
    if (id && !verb && method === 'DELETE') return { status: 200, data: { module: await svc.remove(id, await readBody()) } }
    return null
  } catch (err) {
    if (err instanceof ModuleError) return { status: err.status, data: { type: err.type, title: err.message, detail: err.message, ...err.extra } }
    if (err instanceof z.ZodError) return { status: 400, data: { type: 'urn:ee:invalid_input', title: 'invalid input', detail: err.message } }
    throw err
  }
}
