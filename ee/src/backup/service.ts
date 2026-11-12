import type { SecretMap } from '../secrets.ts'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { S3Client, s3TargetSchema, type S3Target } from './s3.ts'
import { prune, takeSnapshot, type BackupSources } from './snapshot.ts'

/**
 * ee's backup engine as the daemon holds it (plan/phase-backups.md): config +
 * key sealed in the secret store (scope `_backup`), run records in a state
 * file, one run at a time. Configuration is an owner action (D11): the control
 * API takes it from the app's owner-only page or root on the box; the agent
 * only ever reads status.
 */

export const BACKUP_SCOPE = '_backup'
/** A nightly run older than this counts as missing. */
export const MISSING_AFTER_MS = 26 * 3_600_000
const MAX_RUNS = 60

export const scheduleSchema = z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) }).strict()
export const storedConfigSchema = z
  .object({
    target: s3TargetSchema,
    schedule: scheduleSchema,
    retentionDays: z.number().int().min(1).max(3650),
    configuredAt: z.string(),
    configuredBy: z.string(),
    keyCreatedAt: z.string(),
  })
  .strict()
export type BackupConfig = z.infer<typeof storedConfigSchema>

export const runSchema = z.object({
  id: z.string(),
  trigger: z.enum(['scheduled', 'manual']),
  author: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  snapshotId: z.string().nullable(),
  /** Bytes uploaded this run (encrypted). */
  bytesUploaded: z.number().nullable(),
  /** Plaintext size of the snapshot's own files (db + ee state + agent). */
  snapshotSize: z.number().nullable(),
  blobsUploaded: z.number().nullable(),
  blobsTotal: z.number().nullable(),
  pruned: z.object({ snapshots: z.number(), blobs: z.number() }).nullable(),
  error: z.string().nullable(),
})
export type BackupRun = z.infer<typeof runSchema>
const runsFileSchema = z.object({ version: z.literal(1), runs: z.array(runSchema) })

export type Health =
  | { state: 'unconfigured' }
  | { state: 'ok'; lastSuccessAt: string }
  | { state: 'running'; since: string }
  | { state: 'failed'; at: string; error: string }
  | { state: 'missing'; lastSuccessAt: string | null; message: string }

export type BackupDeps = {
  secrets: { all(): SecretMap; set(scope: string, name: string, value: string): Promise<void> }
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string, mode?: number): Promise<void>
  runsFile: string
  sources: BackupSources
  now(): Date
  /** Journal event (kernel-visible through ee status / events). */
  emit(type: string, message: string, data: Record<string, unknown>): Promise<void>
  /** Rewrite the systemd timer for the schedule (no-op in tests). */
  applySchedule(s: { hour: number; minute: number }): Promise<void>
  /** S3 part size override (tests). */
  partSize?: number
  /** Why a run may not start now (a check or restore of a backup is running), or null. */
  busy: () => string | null
}

export class BackupError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export const configureInput = z
  .object({
    target: s3TargetSchema.extend({ secretAccessKey: s3TargetSchema.shape.secretAccessKey.optional() }),
    schedule: z.object({ hour: z.number().int().min(0).max(23) }).strict(),
    retentionDays: z.number().int().min(1).max(3650),
    /**
     * The backup key, base64 (32 bytes): derived by the app from the company
     * root key (gitstore deriveBackupKey), so the ONE company recovery code
     * restores backups too. Required on first setup; when sent later it must
     * match the sealed one (a different key would orphan every snapshot).
     */
    backupKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'backupKey must be 32 bytes, base64').optional(),
    author: z.string().min(1).max(64),
  })
  .strict()

export class BackupService {
  private current: Promise<BackupRun> | null = null
  /** Set synchronously when a run is being started, so a check/restore can't slip in before `current` is. */
  private starting = false
  private runs: BackupRun[] | null = null

  constructor(private readonly d: BackupDeps) {}

  config(): BackupConfig | null {
    const raw = this.d.secrets.all()[BACKUP_SCOPE]?.['CONFIG']
    return raw ? storedConfigSchema.parse(JSON.parse(raw)) : null
  }

  key(): Buffer | null {
    const raw = this.d.secrets.all()[BACKUP_SCOPE]?.['KEY']
    return raw ? Buffer.from(raw, 'base64') : null
  }

  client(target: S3Target): S3Client {
    return new S3Client(target, { ...(this.d.partSize ? { partSize: this.d.partSize } : {}), now: () => this.d.now() })
  }

  private async loadRuns(): Promise<BackupRun[]> {
    if (this.runs) return this.runs
    const raw = await this.d.readFile(this.d.runsFile)
    this.runs = raw === null ? [] : runsFileSchema.parse(JSON.parse(raw)).runs
    // A run "running" in the file belongs to a process that died mid-run.
    for (const r of this.runs) {
      if (r.status === 'running') Object.assign(r, { status: 'failed', error: 'ee stopped while this run was in progress', endedAt: r.startedAt })
    }
    return this.runs
  }

  private async saveRuns(): Promise<void> {
    const runs = (this.runs ?? []).slice(-MAX_RUNS)
    this.runs = runs
    await this.d.writeFile(this.d.runsFile, JSON.stringify({ version: 1, runs }, null, 2) + '\n', 0o600)
  }

  health(cfg: BackupConfig | null, runs: BackupRun[]): Health {
    if (!cfg) return { state: 'unconfigured' }
    const running = runs.find((r) => r.status === 'running')
    if (running) return { state: 'running', since: running.startedAt }
    const last = runs.at(-1)
    const lastOk = [...runs].reverse().find((r) => r.status === 'succeeded')
    if (last?.status === 'failed') return { state: 'failed', at: last.endedAt ?? last.startedAt, error: last.error ?? 'unknown error' }
    const now = this.d.now().getTime()
    const since = Math.max(new Date(cfg.configuredAt).getTime(), lastOk ? new Date(lastOk.startedAt).getTime() : 0)
    if (now - since > MISSING_AFTER_MS) {
      return {
        state: 'missing',
        lastSuccessAt: lastOk?.endedAt ?? null,
        message: lastOk ? `no backup has run since ${lastOk.endedAt}` : 'backups are set up but no backup has run yet',
      }
    }
    return lastOk ? { state: 'ok', lastSuccessAt: lastOk.endedAt ?? lastOk.startedAt } : { state: 'ok', lastSuccessAt: cfg.configuredAt }
  }

  /** Read-only status: never a secret, never the key. */
  async status() {
    const cfg = this.config()
    const runs = await this.loadRuns()
    return {
      configured: cfg !== null,
      target: cfg ? { ...cfg.target, secretAccessKey: undefined, hasSecret: true } : null,
      schedule: cfg?.schedule ?? null,
      retentionDays: cfg?.retentionDays ?? null,
      configuredAt: cfg?.configuredAt ?? null,
      keyCreatedAt: cfg?.keyCreatedAt ?? null,
      health: this.health(cfg, runs),
      runs: [...runs].reverse().slice(0, 20),
    }
  }

  /** Write, read back and delete one object under the prefix. Never saves anything. */
  async testConnection(target: S3Target): Promise<{ ok: true } | { ok: false; error: string }> {
    const s3 = this.client(target)
    const k = s3.key(`.ee-connection-test-${randomUUID()}`)
    const probe = randomBytes(32)
    try {
      await s3.putObject(k, probe)
      const back = await s3.getBuffer(k)
      if (!back.equals(probe)) return { ok: false, error: 'the bucket returned different bytes than ee wrote' }
      await s3.deleteObject(k)
      await s3.list(s3.key('snapshots/'))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Save the target (after a passing connection test), schedule and retention.
   * The first save seals the backup key the app derived from the company root
   * key; ee never sees the root key or a recovery code.
   */
  async configure(raw: unknown): Promise<{ config: Awaited<ReturnType<BackupService['status']>> }> {
    const i = configureInput.parse(raw)
    const prev = this.config()
    const secretAccessKey = i.target.secretAccessKey ?? prev?.target.secretAccessKey
    if (!secretAccessKey) throw new BackupError(400, 'the secret access key is required the first time')
    const target: S3Target = { ...i.target, secretAccessKey }
    const test = await this.testConnection(target)
    if (!test.ok) throw new BackupError(422, `connection test failed, nothing saved: ${test.error}`)
    const now = this.d.now().toISOString()
    let keyCreatedAt = prev?.keyCreatedAt ?? now
    const sealed = this.key()
    if (sealed && i.backupKey && !sealed.equals(Buffer.from(i.backupKey, 'base64'))) {
      throw new BackupError(409, 'a different backup key is already sealed on this server; replacing it would make every existing backup unreadable')
    }
    if (!sealed) {
      if (!i.backupKey) throw new BackupError(400, 'the backup key (derived from the company recovery code) is required the first time')
      await this.d.secrets.set(BACKUP_SCOPE, 'KEY', i.backupKey)
      keyCreatedAt = now
    }
    // A randomized minute, kept across edits, so companies don't all hit their bucket at :00.
    const minute = prev?.schedule.minute ?? Math.floor(Math.random() * 60)
    const cfg: BackupConfig = {
      target,
      schedule: { hour: i.schedule.hour, minute },
      retentionDays: i.retentionDays,
      configuredAt: prev?.configuredAt ?? now,
      configuredBy: i.author,
      keyCreatedAt,
    }
    await this.d.secrets.set(BACKUP_SCOPE, 'CONFIG', JSON.stringify(cfg))
    await this.d.applySchedule(cfg.schedule)
    await this.d.emit('backup.configured', `backups ${prev ? 'updated' : 'set up'} by ${i.author}: s3 ${target.bucket}${target.prefix ? `/${target.prefix}` : ''}, daily at ${pad(cfg.schedule.hour)}:${pad(minute)} UTC, keep ${cfg.retentionDays} days`, { bucket: target.bucket, endpoint: target.endpoint })
    return { config: await this.status() }
  }

  isRunning(): boolean {
    return this.starting || this.current !== null
  }

  /** Start a run; resolves with its record once started (wait for `.done` to get the result). */
  async start(trigger: BackupRun['trigger'], author: string): Promise<{ run: BackupRun; done: Promise<BackupRun> }> {
    const cfg = this.config()
    const key = this.key()
    if (!cfg || !key) throw new BackupError(409, 'backups are not set up (Settings → Backups)')
    if (this.isRunning()) throw new BackupError(409, 'a backup is already running')
    const blocked = this.d.busy()
    if (blocked) throw new BackupError(409, blocked)
    this.starting = true
    try {
      return await this.begin(trigger, author, cfg, key)
    } finally {
      this.starting = false
    }
  }

  private async begin(trigger: BackupRun['trigger'], author: string, cfg: BackupConfig, key: Buffer): Promise<{ run: BackupRun; done: Promise<BackupRun> }> {
    const runs = await this.loadRuns()
    const t0 = this.d.now()
    const run: BackupRun = {
      id: randomUUID(),
      trigger,
      author,
      status: 'running',
      startedAt: t0.toISOString(),
      endedAt: null,
      durationMs: null,
      snapshotId: null,
      bytesUploaded: null,
      snapshotSize: null,
      blobsUploaded: null,
      blobsTotal: null,
      pruned: null,
      error: null,
    }
    runs.push(run)
    await this.saveRuns()
    await this.d.emit('backup.started', `backup started (${trigger}, ${author})`, { runId: run.id })
    const done = (async () => {
      try {
        const s3 = this.client(cfg.target)
        const stats = await takeSnapshot(s3, key, this.d.sources, () => this.d.now())
        Object.assign(run, {
          snapshotId: stats.snapshotId,
          bytesUploaded: stats.bytesUploaded,
          snapshotSize: stats.filesSize,
          blobsUploaded: stats.blobsUploaded,
          blobsTotal: stats.blobsTotal,
        })
        const p = await prune(s3, key, cfg.retentionDays, this.d.now())
        run.pruned = { snapshots: p.snapshotsDeleted.length, blobs: p.blobsDeleted }
        run.status = 'succeeded'
      } catch (err) {
        run.status = 'failed'
        run.error = (err as Error).message
      }
      const t1 = this.d.now()
      run.endedAt = t1.toISOString()
      run.durationMs = t1.getTime() - t0.getTime()
      await this.saveRuns()
      if (run.status === 'succeeded') {
        await this.d.emit('backup.succeeded', `backup ${run.snapshotId} done: ${run.bytesUploaded} bytes uploaded in ${Math.round(run.durationMs / 1000)}s`, { runId: run.id, snapshotId: run.snapshotId, bytesUploaded: run.bytesUploaded, durationMs: run.durationMs })
      } else {
        await this.d.emit('backup.failed', `backup failed: ${run.error}`, { runId: run.id, error: run.error })
      }
      this.current = null
      return run
    })()
    this.current = done
    return { run: { ...run }, done }
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
