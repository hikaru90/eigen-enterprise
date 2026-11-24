import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { sha256Hex } from './release-key.ts'
import { compareVersions, newestFrom, pinnedFrom, releaseVersion, type ReleaseSource } from './release-source.ts'
import { planRollback, type RollbackDeps, type RollbackPlan } from './rollback.ts'
import { latestName, releaseOf, signedManifest, type Arch, type UpgradeDeps, type UpgradeOutcome, type UpgradeStep } from './upgrade.ts'

/**
 * Settings → Updates (owner and admins): the app asks ee to update this
 * server to the newest signed release; ee does it, like `ee upgrade` on the
 * CLI. The app cannot replace itself, so the work runs in a transient
 * `ee-upgrade.service` (`ee upgrade-apply --job <id>`) that outlives ee.service
 * and the os workload restarting under it:
 *
 *   GET  /v1/upgrade         what runs now, the release source, managed?, the last update → no network
 *   GET  /v1/upgrade/latest  the newest release: LATEST, the signed SHA256SUMS, its signed NOTES.md
 *   POST /v1/upgrade         { release, author } → 202 { job }   (the release the person approved)
 *   GET  /v1/upgrade/rollback   what `ee rollback` would do now: { from, to, refused }
 *   POST /v1/upgrade/rollback   { author, to?, reason?, automatic? } → { from, to }   (rollback.ts)
 *   POST /v1/upgrade/outcome    { outcome } — `ee upgrade` on the CLI (and the fleet's unit) reports
 *                               how it ended; the daemon journals it (only the daemon writes the journal)
 *
 * The daemon checks the release again (signature, still the newest, newer
 * than what runs), records the job and starts the unit; the unit takes the
 * safety copy, runs the installer (health-gated deploy + migrations) and
 * records every step in one state file, so the page reconnects and reads the
 * outcome once the app is back. The daemon only settles a job whose unit died
 * and journals the end. A managed box is refused: its hosting control plane
 * owns the release (fleet/agent.ts applyRelease).
 */

export const UPGRADE_UNIT = 'ee-upgrade.service'
export const UPGRADE_STEPS = ['handover', 'verifying', 'safety-copy', 'backup', 'installing', 'watching', 'rolling-back', 'done'] as const
export type UpgradeJobStep = (typeof UPGRADE_STEPS)[number]
/** The steps an upgrade can end in (upgrade.ts UpgradeOutcome). */
const OUTCOME_STEPS = ['verifying', 'safety-copy', 'backup', 'installing', 'watching', 'rolling-back', 'done'] as const

const MAX_LOG = 200
const MAX_NOTES = 20_000
const RELEASE_NAME = /^eigenenterprise-\d+\.\d+\.\d+-[0-9a-f]{12}$/

/** An upgrade's end (upgrade.ts UpgradeOutcome), as the job and the journal keep it. */
export const outcomeSchema = z
  .object({
    release: z.string().regex(RELEASE_NAME),
    from: z.string().max(200).nullable(),
    step: z.enum(OUTCOME_STEPS),
    ok: z.boolean(),
    reason: z.string().max(2000).nullable(),
    rolledBack: z.boolean(),
  })
  .strict()

export const upgradeJobSchema = z.object({
  id: z.string(),
  /** The release the person approved (eigenenterprise-<version>-<sha>). */
  release: z.string().regex(RELEASE_NAME),
  /** Where it is installed from: pinned to that release. */
  from: z.string(),
  author: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  step: z.enum(UPGRADE_STEPS),
  startedAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  /** The os release tarball before and after (basename). */
  installedBefore: z.string().nullable(),
  installedAfter: z.string().nullable(),
  /** The safety copy's directory (its ROLLBACK.txt says how to go back), once taken. */
  safetyCopy: z.string().nullable(),
  error: z.string().nullable(),
  log: z.array(z.string()),
  /** The end is in ee's journal (only the daemon writes the journal). */
  announced: z.boolean(),
  /** How the transaction ended (upgrade.ts UpgradeOutcome); null while it runs, and on jobs from before U3. */
  outcome: outcomeSchema.nullable().default(null),
})
export type UpgradeJob = z.infer<typeof upgradeJobSchema>
const stateFileSchema = z.object({ version: z.literal(1), job: upgradeJobSchema })

type Files = { readFile(path: string): Promise<string | null>; writeFile(path: string, content: string, mode?: number): Promise<void>; stateFile: string }

async function readJob(f: Files): Promise<UpgradeJob | null> {
  const raw = await f.readFile(f.stateFile)
  return raw === null ? null : stateFileSchema.parse(JSON.parse(raw)).job
}
async function writeJob(f: Files, job: UpgradeJob): Promise<void> {
  await f.writeFile(f.stateFile, JSON.stringify({ version: 1, job }, null, 2) + '\n', 0o600)
}
function logLine(job: UpgradeJob, line: string): void {
  job.log = [...job.log, line].slice(-MAX_LOG)
}

export class UpgradeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * newer    a higher version than what runs
 * rebuild  the same version, another build (a re-release, the local box)
 * installed  exactly what runs;  older  a lower version (never offered)
 */
export type LatestState = 'newer' | 'rebuild' | 'installed' | 'older'
export type LatestRelease = { name: string; version: string; notes: string | null; from: string; state: LatestState }

export type UpgradeServiceDeps = Files & {
  now(): Date
  emit(type: string, message: string, data: Record<string, unknown>): Promise<void>
  settings(): Promise<{ managed: boolean; releaseSource: ReleaseSource | null }>
  /** The os release tarball running now (basename), null before the first deploy. */
  installed(): Promise<string | null>
  arch: Arch
  /** GET an https URL, or read a file under a directory source (absolute path). */
  fetchText: UpgradeDeps['fetchText']
  releaseKeyPem: string
  /** Start `ee upgrade-apply --job <id>` as UPGRADE_UNIT; resolves once it runs. */
  launch(jobId: string): Promise<void>
  unitActive(): Promise<boolean>
  /** Why nothing may start now (a restore, a fleet upgrade), or null. */
  otherBusy(): Promise<string | null>
  /** The newest upgrade end in ee's journal (either path: this job, or `ee upgrade` on the CLI). */
  lastOutcome(): Promise<UpgradeOutcome | null>
  /** `ee rollback` (rollback.ts): what is on disk, and the hands to switch os back. */
  rollback: RollbackDeps & {
    /** Why no rollback may run now (a restore), or null. A running update may still roll itself back. */
    restoreBusy(): Promise<string | null>
    /** Commit os's source = this tarball and converge; resolves with the reconcile error, or null. */
    switchOs(tarball: string, sha256: string, author: string, message: string): Promise<string | null>
    /** The release id (sha256 prefix) of the os slot that is live now. */
    liveOsRelease(): Promise<string | null>
  }
}

const startInput = z.object({ release: z.string().regex(RELEASE_NAME, 'release must be a release name (eigenenterprise-<version>-<sha>)'), author: z.string().min(1).max(64) }).strict()
const rollbackInput = z
  .object({
    author: z.string().min(1).max(64),
    /** The release to go back to (eigenenterprise-<version>-<sha>); default: the one the other slot ran. */
    to: z.string().regex(RELEASE_NAME, 'to must be a release name (eigenenterprise-<version>-<sha>)').optional(),
    reason: z.string().min(1).max(1000).optional(),
    /** The update rolling itself back after its watch failed (it holds the update slot itself). */
    automatic: z.boolean().default(false),
  })
  .strict()
const outcomeInput = z.object({ outcome: outcomeSchema }).strict()

const NO_SOURCE =
  'this server does not know where its releases come from (it was installed before Settings → Updates existed); run `ee upgrade` once on the server, then updates work from here'

export class UpgradeService {
  /** start() is between its checks and the hand-over: settle must not call the unit dead. */
  private claimed = false
  private settling: Promise<unknown> = Promise.resolve()

  constructor(private readonly d: UpgradeServiceDeps) {}

  async info(): Promise<{
    installed: { tarball: string; version: string } | null
    managed: boolean
    source: ReleaseSource | null
    job: UpgradeJob | null
    lastOutcome: UpgradeOutcome | null
  }> {
    const [{ managed, releaseSource }, tarball, job] = [await this.d.settings(), await this.d.installed(), await this.job()]
    const lastOutcome = await this.d.lastOutcome()
    return { installed: tarball ? { tarball, version: releaseVersion(tarball) } : null, managed, source: releaseSource, job, lastOutcome }
  }

  /** What `ee rollback` would do now (a read: nothing changes). */
  rollbackPlan(to?: string): Promise<RollbackPlan> {
    return planRollback(this.d.rollback, to)
  }

  /**
   * `ee rollback` and the owner-only kernel.release_rollback, and the update itself when its
   * watch fails (`automatic`): os goes back to the release before, health-gated, no restore.
   */
  async rollback(raw: unknown): Promise<{ from: string; to: string }> {
    const i = rollbackInput.parse(raw)
    const rb = this.d.rollback
    if (!i.automatic) {
      if ((await this.d.settings()).managed) {
        throw new UpgradeError(409, 'this server is updated by its hosting provider (managed mode): it decides which release runs')
      }
      const last = await this.job()
      if (this.claimed || last?.status === 'running') throw new UpgradeError(409, 'an update is running; wait for it to finish (it rolls itself back if its watch fails)')
    }
    const busy = await rb.restoreBusy()
    if (busy) throw new UpgradeError(409, busy)
    const plan = await this.rollbackPlan(i.to)
    if (plan.refused || !plan.to || !plan.from) throw new UpgradeError(409, `rollback refused, nothing changed: ${plan.refused ?? 'nothing to roll back to'}`)
    const { from, to } = plan as { from: string; to: string }
    const sha256 = await rb.sha256Of(to)
    const why = i.reason ?? `by ${i.author}`
    await this.d.emit('upgrade.rollback_started', `rolling os back from ${releaseOf(from)} to ${releaseOf(to)} (${why})`, { from, to, author: i.author, reason: i.reason ?? null })
    const reconcileError = await rb.switchOs(to, sha256, i.author, `rollback: os to ${releaseOf(to)} (${why})`)
    if ((await rb.liveOsRelease()) !== sha256.slice(0, 16)) {
      const message = `the rollback to ${releaseOf(to)} did not bring it live: ${reconcileError ?? 'os is not serving it'}`
      await this.d.emit('upgrade.rollback_failed', message, { from, to, author: i.author })
      throw new UpgradeError(500, message)
    }
    await this.d.emit('upgrade.rolled_back', `os rolled back from ${releaseOf(from)} to ${releaseOf(to)} (${why})`, { from, to, author: i.author, reason: i.reason ?? null })
    return { from, to }
  }

  /** An end `ee upgrade` reported (the CLI path has no job): journalled like a job's end. */
  async recordOutcome(raw: unknown): Promise<{ recorded: true }> {
    const { outcome } = outcomeInput.parse(raw)
    await this.announce(outcome, { via: 'cli' })
    return { recorded: true }
  }

  private async announce(o: UpgradeOutcome, data: Record<string, unknown>): Promise<void> {
    if (o.ok) await this.d.emit('upgrade.succeeded', `updated to ${o.release}`, { ...data, release: o.release, outcome: o })
    else await this.d.emit('upgrade.failed', `update to ${o.release} failed at "${o.step}": ${o.reason}`, { ...data, release: o.release, error: o.reason, outcome: o })
  }

  /** The newest signed release at the source and how it compares to what runs. */
  async latest(): Promise<LatestRelease> {
    const { releaseSource } = await this.d.settings()
    if (!releaseSource) throw new UpgradeError(409, NO_SOURCE)
    try {
      const name = await latestName(this.d, newestFrom(releaseSource))
      const from = pinnedFrom(releaseSource, name)
      const manifest = await signedManifest(this.d, from)
      const pinned = await this.d.fetchText(`${from}/LATEST`)
      manifest.check('LATEST', sha256Hex(pinned))
      if (pinned.trim() !== name) throw new Error(`${from} holds ${pinned.trim().slice(0, 80)}, not ${name}`)
      let notes: string | null = null
      if (manifest.sums.has('NOTES.md')) {
        const raw = await this.d.fetchText(`${from}/NOTES.md`)
        manifest.check('NOTES.md', sha256Hex(raw))
        notes = raw.slice(0, MAX_NOTES)
      }
      const version = releaseVersion(name)
      return { name, version, notes, from, state: compare(name, await this.d.installed()) }
    } catch (err) {
      throw new UpgradeError(502, `could not check for updates: ${(err as Error).message}`)
    }
  }

  /** The last update, with a dead unit settled and the end journalled (once). */
  job(): Promise<UpgradeJob | null> {
    const next = this.settling.then(() => this.settle())
    this.settling = next.catch(() => undefined)
    return next
  }

  private async settle(): Promise<UpgradeJob | null> {
    let j = await readJob(this.d)
    if (this.claimed) return j
    if (j && j.status === 'running' && !(await this.d.unitActive())) {
      // The unit writes its own end before it exits: read again before calling it dead.
      const again = await readJob(this.d)
      if (again && again.id === j.id && again.status === 'running') {
        const at = this.d.now().toISOString()
        const error =
          again.step === 'handover'
            ? 'the update process did not start; nothing on this server was changed'
            : `the update process stopped before it finished (at "${again.step}")` +
              (again.safetyCopy ? `; the safety copy and rollback steps are in ${again.safetyCopy}/ROLLBACK.txt` : '; nothing on this server was changed')
        j = { ...again, status: 'failed', error, endedAt: at, updatedAt: at }
        await writeJob(this.d, j)
      } else j = again
    }
    if (j && j.status !== 'running' && !j.announced) {
      // A unit that died before it reported an end gets one from what the job shows.
      const outcome: UpgradeOutcome = j.outcome ?? {
        release: j.release,
        from: j.installedBefore,
        step: j.step === 'handover' ? 'verifying' : j.step,
        ok: j.status === 'succeeded',
        reason: j.error,
        rolledBack: false,
      }
      await this.announce(outcome, { jobId: j.id, author: j.author, safetyCopy: j.safetyCopy })
      j = { ...j, outcome, announced: true }
      await writeJob(this.d, j)
    }
    return j
  }

  async start(raw: unknown): Promise<{ job: UpgradeJob }> {
    const i = startInput.parse(raw)
    // Settle first, then claim the one slot synchronously (no await between the check and the claim).
    const last = await this.job()
    if (this.claimed || last?.status === 'running') throw new UpgradeError(409, 'an update is running; wait for it to finish')
    this.claimed = true
    try {
      if ((await this.d.settings()).managed) {
        throw new UpgradeError(409, 'this server is updated by its hosting provider (managed mode): it installs new releases itself')
      }
      if (await this.d.unitActive()) throw new UpgradeError(409, 'an update is running; wait for it to finish')
      const busy = await this.d.otherBusy()
      if (busy) throw new UpgradeError(409, busy)
      const latest = await this.latest()
      if (latest.name !== i.release) throw new UpgradeError(409, `the newest release is now ${latest.version} (${latest.name}); check again`)
      if (latest.state === 'installed') throw new UpgradeError(409, `this server already runs ${latest.name}`)
      if (latest.state === 'older') throw new UpgradeError(409, `${latest.name} is older than what this server runs`)
      const now = this.d.now().toISOString()
      const job: UpgradeJob = {
        id: randomUUID(),
        release: latest.name,
        from: latest.from,
        author: i.author,
        status: 'running',
        step: 'handover',
        startedAt: now,
        updatedAt: now,
        endedAt: null,
        installedBefore: await this.d.installed(),
        installedAfter: null,
        safetyCopy: null,
        error: null,
        log: [`→ ${latest.name} checked (signed by the release key); starting the update process`],
        announced: false,
        outcome: null,
      }
      await writeJob(this.d, job)
      try {
        await this.d.launch(job.id)
      } catch (err) {
        const at = this.d.now().toISOString()
        const failed: UpgradeJob = { ...job, status: 'failed', error: `could not start the update process: ${(err as Error).message} — nothing on this server was changed`, endedAt: at, updatedAt: at }
        await writeJob(this.d, failed)
        throw new UpgradeError(500, failed.error!)
      }
      await this.d.emit('upgrade.started', `update to ${latest.name} started by ${i.author}`, { jobId: job.id, release: latest.name })
      return { job }
    } finally {
      this.claimed = false
    }
  }
}

function compare(name: string, installed: string | null): LatestState {
  if (!installed) return 'newer'
  if (installed.startsWith(`${name}-linux-`)) return 'installed'
  const c = compareVersions(releaseVersion(name), releaseVersion(installed))
  return c > 0 ? 'newer' : c === 0 ? 'rebuild' : 'older'
}

export type Reply = { status: number; data: unknown }

export async function upgradeRoute(svc: UpgradeService, route: string, readBody: () => Promise<unknown>): Promise<Reply | null> {
  try {
    if (route === 'GET /v1/upgrade') return { status: 200, data: await svc.info() }
    if (route === 'GET /v1/upgrade/latest') return { status: 200, data: { latest: await svc.latest() } }
    if (route === 'POST /v1/upgrade') return { status: 202, data: await svc.start(await readBody()) }
    if (route === 'GET /v1/upgrade/rollback') return { status: 200, data: await svc.rollbackPlan() }
    if (route === 'POST /v1/upgrade/rollback') return { status: 200, data: await svc.rollback(await readBody()) }
    if (route === 'POST /v1/upgrade/outcome') return { status: 200, data: await svc.recordOutcome(await readBody()) }
    return null
  } catch (err) {
    if (err instanceof UpgradeError) return { status: err.status, data: { type: 'urn:ee:upgrade', title: err.message, detail: err.message } }
    if (err instanceof z.ZodError) return { status: 400, data: { type: 'urn:ee:invalid_input', title: 'invalid input', detail: err.message } }
    throw err
  }
}

export type ApplyHooks = {
  /** A step starts (`safety-copy` passes the copy's directory). */
  step(step: UpgradeStep, safetyCopy?: string): Promise<void>
  /** A line of output (the installer's). */
  line(line: string): Promise<void>
  /** How the transaction ended (the daemon journals it when it settles the job). */
  outcome(o: UpgradeOutcome): Promise<void>
}

/**
 * The update unit's side (`ee upgrade-apply --job <id>`): only an update ee
 * checked and handed over runs. `run` does the upgrade and returns the os
 * release that runs afterwards; every step and line is recorded.
 */
export async function runUpgradeApply(
  d: Files & { now(): Date },
  jobId: string,
  run: (hooks: ApplyHooks, job: Readonly<UpgradeJob>) => Promise<string>,
  out: (line: string) => void,
): Promise<UpgradeJob> {
  const job = await readJob(d)
  if (!job || job.id !== jobId || job.status !== 'running' || job.step !== 'handover') {
    throw new Error(`no update ${jobId} is waiting to be applied (start it from Settings → Updates, or use \`ee upgrade\`)`)
  }
  // One write at a time: steps and output lines arrive together, and the box writes via temp file + rename.
  let saving: Promise<void> = Promise.resolve()
  const save = () => {
    const next = saving.then(async () => {
      job.updatedAt = d.now().toISOString()
      await writeJob(d, job)
    })
    saving = next.catch(() => undefined)
    return next
  }
  const hooks: ApplyHooks = {
    step: async (step, safetyCopy) => {
      job.step = step
      if (safetyCopy) job.safetyCopy = safetyCopy
      await save()
    },
    line: async (line) => {
      out(line)
      logLine(job, line)
      await save()
    },
    outcome: async (o) => {
      job.outcome = outcomeSchema.parse({ ...o, reason: o.reason === null ? null : o.reason.slice(0, 2000) })
      await save()
    },
  }
  try {
    job.installedAfter = await run(hooks, { ...job })
    job.status = 'succeeded'
    job.step = 'done'
    job.endedAt = d.now().toISOString()
    logLine(job, `✓ updated to ${job.release}`)
    await save()
    return job
  } catch (err) {
    job.status = 'failed'
    job.error = (err as Error).message
    job.endedAt = d.now().toISOString()
    logLine(job, `✗ ${job.error}`)
    await save()
    throw err
  }
}
