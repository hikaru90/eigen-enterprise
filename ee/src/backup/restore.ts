import type { S3Client } from './s3.ts'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BackupError, type BackupService } from './service.ts'
import { fetchSnapshot, listSnapshots, resolveSnapshot, snapshotDate, type Manifest } from './snapshot.ts'

/**
 * Check and restore a snapshot through ee's control API (Settings → Backups,
 * owner only per D11). ee does the work, like `ee restore` on the CLI — the
 * console only asks:
 *
 *   check    download + decrypt + hash every file and blob of a snapshot in
 *            the daemon; writes nothing (`ee restore --verify`).
 *   restore  the daemon verifies the snapshot into a root-only staging dir
 *            (with the backup key the owner's recovery code derives — held in
 *            memory only, never written), then hands over to a transient
 *            `ee-restore.service` (`ee restore-apply`), because the apply
 *            stops ee itself and every workload. That unit needs no key: it
 *            only puts the already-verified files in place and starts ee.
 *
 * Progress lives in one state file both sides write (the daemon up to the
 * hand-over, the unit after it), so the page can poll it again once ee and the
 * os workload are back. Whole-box only: there is no partial restore.
 */

export const RESTORE_UNIT = 'ee-restore.service'
export const SNAPSHOT_ID = /^\d{8}T\d{6}Z$/

/**
 * verifying  (daemon) download + check;  handover (daemon) staged, unit starting;
 * the rest   (unit) the box is being replaced;  done.
 */
export const RESTORE_STEPS = ['verifying', 'handover', 'stopping', 'restoring-state', 'restoring-database', 'restoring-files', 'starting', 'done'] as const
export type RestoreStep = (typeof RESTORE_STEPS)[number]

const MAX_LOG = 100

export const restoreJobSchema = z.object({
  id: z.string(),
  kind: z.enum(['check', 'restore']),
  snapshotId: z.string().regex(SNAPSHOT_ID),
  author: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  step: z.enum(RESTORE_STEPS),
  startedAt: z.string(),
  updatedAt: z.string(),
  endedAt: z.string().nullable(),
  /** What the verification read: the snapshot's files and its Drive blobs (plaintext sizes). */
  checked: z
    .object({ files: z.array(z.object({ name: z.string(), size: z.number() })), blobs: z.number(), blobBytes: z.number() })
    .nullable(),
  error: z.string().nullable(),
  log: z.array(z.string()),
  /** The terminal event is in ee's journal (the unit cannot write it: the apply rebuilds the journal). */
  announced: z.boolean(),
})
export type RestoreJob = z.infer<typeof restoreJobSchema>
const stateFileSchema = z.object({ version: z.literal(1), job: restoreJobSchema })

type Files = { readFile(path: string): Promise<string | null>; writeFile(path: string, content: string, mode?: number): Promise<void>; stateFile: string }

async function readJob(f: Files): Promise<RestoreJob | null> {
  const raw = await f.readFile(f.stateFile)
  return raw === null ? null : stateFileSchema.parse(JSON.parse(raw)).job
}
async function writeJob(f: Files, job: RestoreJob): Promise<void> {
  await f.writeFile(f.stateFile, JSON.stringify({ version: 1, job }, null, 2) + '\n', 0o600)
}
function logLine(job: RestoreJob, line: string): void {
  job.log = [...job.log, line].slice(-MAX_LOG)
}

/** Where a restore stages the decrypted, verified snapshot (root-only, under ee's backup scratch). */
export const restoreWorkDir = (stagingDir: string, id: string) => join(stagingDir, `restore-${id}`)

/** Download + verify a whole snapshot into its work dir (files, and Drive blobs under drive/). */
export async function stageSnapshot(s3: S3Client, key: Buffer, id: string, stagingDir: string, log: (l: string) => void): Promise<Manifest> {
  const work = restoreWorkDir(stagingDir, id)
  await rm(work, { recursive: true, force: true })
  const m = await fetchSnapshot(s3, key, id, { dir: work, driveDir: join(work, 'drive') }, log)
  const has = (n: string) => m.files.some((f) => f.name === n)
  if (!has('db.dump') || !has('ee-state.tar.gz')) throw new Error(`snapshot ${id} lacks the database or ee state; refusing a partial restore`)
  return m
}

const summary = (m: Manifest): NonNullable<RestoreJob['checked']> => ({
  files: m.files.map((f) => ({ name: f.name, size: f.size })),
  blobs: m.blobs.length,
  blobBytes: m.blobs.reduce((n, b) => n + b.size, 0),
})

export type RestoreDeps = Files & {
  backups: BackupService
  /** Root-only scratch: a restore stages into <stagingDir>/restore-<id>. */
  stagingDir: string
  now(): Date
  emit(type: string, message: string, data: Record<string, unknown>): Promise<void>
  /** Start the transient restore unit (`ee restore-apply --snapshot <id>`); resolves once it runs. */
  launchApply(snapshotId: string): Promise<void>
  /** Is the restore unit still running? */
  applyActive(): Promise<boolean>
}

const author = z.string().min(1).max(64)
const snapshotIdSchema = z.string().regex(SNAPSHOT_ID, 'snapshotId must look like 20261103T031700Z')
export const checkInput = z.object({ snapshotId: snapshotIdSchema, author }).strict()
export const restoreInput = z
  .object({
    snapshotId: snapshotIdSchema,
    /** base64 of the 32-byte backup key the app derived from the recovery code the owner typed; never stored. */
    backupKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'backupKey must be 32 bytes, base64'),
    author,
  })
  .strict()

export class RestoreService {
  /** A check or restore the daemon is working on right now (claimed synchronously, so two requests can't both start). */
  private current: { job: RestoreJob; done: Promise<RestoreJob> } | null = null
  private claimed: RestoreJob['kind'] | null = null
  /** The state file as last read: a restore unit running keeps everything else out. */
  private cached: RestoreJob | null = null

  constructor(private readonly d: RestoreDeps) {}

  /** Complete snapshots in the bucket, newest first. */
  async snapshots(): Promise<{ snapshots: Array<{ id: string; takenAt: string }> }> {
    const { s3 } = this.configured()
    let all
    try {
      all = await listSnapshots(s3)
    } catch (err) {
      throw new BackupError(502, `could not list the backups in the bucket: ${(err as Error).message}`)
    }
    return {
      snapshots: all
        .filter((s) => s.complete && SNAPSHOT_ID.test(s.id))
        .reverse()
        .map((s) => ({ id: s.id, takenAt: snapshotDate(s.id)!.toISOString() })),
    }
  }

  private settling: Promise<unknown> = Promise.resolve()

  /** The last check/restore, with stale states settled (ee restarted mid-check, the unit died). */
  job(): Promise<RestoreJob | null> {
    // One at a time: concurrent polls must not settle (or announce) the same job twice.
    const next = this.settling.then(() => this.settle())
    this.settling = next.catch(() => undefined)
    return next
  }

  private async settle(): Promise<RestoreJob | null> {
    let j = await readJob(this.d)
    // A request that is just starting a job (claimed) is about to write its own state: leave it.
    if (this.claimed) return (this.cached = j)
    if (j && j.status === 'running' && j.step === 'verifying' && this.current?.job.id !== j.id) {
      j = this.finish(j, 'failed', `ee stopped while this ${j.kind} was in progress; nothing on this server was changed`)
      await writeJob(this.d, j)
    }
    if (j && j.status === 'running' && j.step !== 'verifying' && this.current?.job.id !== j.id && !(await this.d.applyActive())) {
      // The unit writes its own end before it exits: read again before calling it dead.
      const again = await readJob(this.d)
      if (again && again.id === j.id && again.status === 'running') {
        j = this.finish(
          again,
          'failed',
          again.step === 'handover'
            ? 'the restore process did not start; nothing on this server was changed'
            : `the restore process stopped before it finished (at "${again.step}"); the server may be partly restored — restore again`,
        )
        await writeJob(this.d, j)
      } else j = again
    }
    if (j && j.kind === 'restore' && j.status !== 'running' && !j.announced) {
      if (j.status === 'succeeded') await this.d.emit('restore.succeeded', `restore of backup ${j.snapshotId} done (${j.author})`, { snapshotId: j.snapshotId, jobId: j.id })
      else await this.d.emit('restore.failed', `restore of backup ${j.snapshotId} failed: ${j.error}`, { snapshotId: j.snapshotId, jobId: j.id, error: j.error })
      j = { ...j, announced: true }
      await writeJob(this.d, j)
    }
    this.cached = j
    return j
  }

  /** Why nothing else may start now (a backup asks before every run), or null. */
  busyNow(): string | null {
    const k = this.claimed ?? this.current?.job.kind
    if (k) return `a ${k === 'check' ? 'check of a backup' : 'restore'} is running; wait for it to finish`
    if (this.cached?.status === 'running' && this.cached.kind === 'restore') return 'a restore is running; wait for it to finish'
    return null
  }

  async busy(): Promise<string | null> {
    await this.job()
    return this.busyNow()
  }

  /** Resolves once the daemon's current check/restore step is over (tests, shutdown). */
  async idle(): Promise<void> {
    await this.current?.done
  }

  private configured(): { s3: S3Client; key: Buffer } {
    const cfg = this.d.backups.config()
    const key = this.d.backups.key()
    if (!cfg || !key) throw new BackupError(409, 'backups are not set up (Settings → Backups)')
    return { s3: this.d.backups.client(cfg.target), key }
  }

  private finish(job: RestoreJob, status: 'succeeded' | 'failed', error: string | null = null): RestoreJob {
    const at = this.d.now().toISOString()
    return { ...job, status, error, endedAt: at, updatedAt: at, ...(status === 'succeeded' && job.kind === 'check' ? { step: 'done' as const } : {}) }
  }

  /** Claim the one job slot, synchronously, before anything awaits. */
  private claim(kind: RestoreJob['kind']): void {
    if (this.d.backups.isRunning()) throw new BackupError(409, 'a backup is running; wait for it to finish')
    const busy = this.busyNow()
    if (busy) throw new BackupError(409, busy)
    this.claimed = kind
  }

  private async begin(
    kind: RestoreJob['kind'],
    snapshotId: string,
    who: string,
    s3: S3Client,
    work: (job: RestoreJob, s3: S3Client, save: () => Promise<void>) => Promise<void>,
  ): Promise<{ job: RestoreJob; done: Promise<RestoreJob> }> {
    const now = this.d.now().toISOString()
    const job: RestoreJob = {
      id: randomUUID(),
      kind,
      snapshotId,
      author: who,
      status: 'running',
      step: 'verifying',
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      checked: null,
      error: null,
      log: [],
      announced: false,
    }
    const save = async () => {
      job.updatedAt = this.d.now().toISOString()
      await writeJob(this.d, job)
    }
    await save()
    const snapshot = { ...job }
    const done = (async () => {
      try {
        await work(job, s3, save)
      } catch (err) {
        Object.assign(job, this.finish(job, 'failed', (err as Error).message))
        await save()
      }
      this.current = null
      this.cached = { ...job }
      return { ...job }
    })()
    this.current = { job, done }
    this.claimed = null
    return { job: snapshot, done }
  }

  /** Download + decrypt + hash a whole snapshot; writes nothing. */
  async check(raw: unknown): Promise<{ job: RestoreJob; done: Promise<RestoreJob> }> {
    const i = checkInput.parse(raw)
    await this.job()
    this.claim('check')
    try {
      const { s3, key } = this.configured()
      return await this.begin(
        'check',
        i.snapshotId,
        i.author,
        s3,
        async (job, s3c, save) => {
          try {
            const id = await resolveSnapshot(s3c, i.snapshotId)
            const m = await fetchSnapshot(s3c, key, id, null, (l) => logLine(job, l.trim()))
            Object.assign(job, this.finish({ ...job, checked: summary(m) }, 'succeeded'))
            await save()
            await this.d.emit('backup.checked', `backup ${id} checked by ${i.author}: ${m.files.length} file(s) and ${m.blobs.length} Drive blob(s) decrypt and match`, { snapshotId: id, jobId: job.id })
          } catch (err) {
            await this.d.emit('backup.check_failed', `check of backup ${i.snapshotId} failed: ${(err as Error).message}`, { snapshotId: i.snapshotId, jobId: job.id })
            throw err
          }
        },
      )
    } finally {
      this.claimed = null
    }
  }

  /**
   * Verify the snapshot with the key from the owner's recovery code, stage it,
   * hand over to the restore unit. The returned `done` resolves at the
   * hand-over (or the failure): from then on the unit owns the job.
   */
  async restore(raw: unknown): Promise<{ job: RestoreJob; done: Promise<RestoreJob> }> {
    const i = restoreInput.parse(raw)
    await this.job()
    this.claim('restore')
    try {
      const { s3, key: sealed } = this.configured()
      const given = Buffer.from(i.backupKey, 'base64')
      if (given.length !== sealed.length || !timingSafeEqual(given, sealed)) {
        throw new BackupError(422, "this recovery code does not open this company's backups; enter the company recovery code (EE1-…) that was shown when backups were set up")
      }
      return await this.begin(
        'restore',
        i.snapshotId,
        i.author,
        s3,
        async (job, s3c, save) => {
          await this.d.emit('restore.started', `restore of backup ${i.snapshotId} started by ${i.author}`, { snapshotId: i.snapshotId, jobId: job.id })
          try {
            logLine(job, `→ downloading and verifying backup ${i.snapshotId}`)
            await save()
            const id = await resolveSnapshot(s3c, i.snapshotId)
            const m = await stageSnapshot(s3c, given, id, this.d.stagingDir, (l) => logLine(job, l.trim()))
            job.checked = summary(m)
            job.step = 'handover'
            logLine(job, '→ every file checked; handing over to the restore process (ee and the company stop now)')
            await save()
          } catch (err) {
            await rm(restoreWorkDir(this.d.stagingDir, i.snapshotId), { recursive: true, force: true })
            throw new Error(`${(err as Error).message} — nothing on this server was changed`, { cause: err })
          }
          try {
            await this.d.launchApply(i.snapshotId)
          } catch (err) {
            await rm(restoreWorkDir(this.d.stagingDir, i.snapshotId), { recursive: true, force: true })
            throw new Error(`could not start the restore process: ${(err as Error).message} — nothing on this server was changed`, { cause: err })
          }
          // From here the unit writes the job; the daemon must not.
        },
      )
    } finally {
      this.claimed = null
    }
  }
}

export type ApplyProgress = (step: Exclude<RestoreStep, 'verifying' | 'handover' | 'done'>, line: string) => Promise<void>

/**
 * The restore unit's side (`ee restore-apply`): only a restore ee verified and
 * handed over is applied. Every step is recorded; on failure the error is
 * recorded and ee is started again, so the page can show what happened.
 */
export async function runApply(
  d: Files & { now(): Date; startEe(): Promise<void> },
  snapshotId: string,
  apply: (progress: ApplyProgress) => Promise<void>,
  out: (line: string) => void,
): Promise<void> {
  const job = await readJob(d)
  if (!job || job.kind !== 'restore' || job.snapshotId !== snapshotId || job.status !== 'running' || job.step !== 'handover') {
    throw new Error(`no restore of ${snapshotId} is waiting to be applied (start it from Settings → Backups, or use \`ee restore --snapshot\`)`)
  }
  const save = async () => {
    job.updatedAt = d.now().toISOString()
    await writeJob(d, job)
  }
  try {
    await apply(async (step, line) => {
      out(line)
      job.step = step
      logLine(job, line)
      await save()
    })
    job.status = 'succeeded'
    job.step = 'done'
    job.endedAt = d.now().toISOString()
    logLine(job, `✓ restored backup ${snapshotId}`)
    await save()
  } catch (err) {
    job.status = 'failed'
    job.error = (err as Error).message
    job.endedAt = d.now().toISOString()
    logLine(job, `✗ ${job.error}`)
    try {
      await d.startEe()
      logLine(job, '→ ee was started again so this can be seen in Settings → Backups')
    } catch (e2) {
      logLine(job, `✗ starting ee again failed too: ${(e2 as Error).message}`)
    }
    await save()
    throw err
  }
}
