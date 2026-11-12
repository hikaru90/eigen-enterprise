import type { RestoreService } from './restore.ts'
import { z } from 'zod'
import { s3TargetSchema } from './s3.ts'
import { BackupError, type BackupService } from './service.ts'

/**
 * Backup verbs of the control API (owner actions per D11 — the app only offers
 * them on the owner-only Settings → Backups page; the agent reads status).
 *   GET  /v1/backups            status, config (no secrets), last runs, health
 *   POST /v1/backups/test       { target }                      → { ok } | { ok:false, error }
 *   POST /v1/backups/config     { target, schedule, retentionDays, backupKey?, author } → { config }
 *   POST /v1/backups/run        { author, trigger?, wait? }     → { run }
 * Check and restore (restore.ts; refused with 409 while a backup, check or restore runs):
 *   GET  /v1/backups/snapshots  complete snapshots in the bucket, newest first → { snapshots: [{ id, takenAt }] }
 *   GET  /v1/backups/restore    the last check/restore job (progress; survives the restore's restart) → { job | null }
 *   POST /v1/backups/check      { snapshotId, author }                         → 202 { job }   (writes nothing)
 *   POST /v1/backups/restore    { snapshotId, backupKey, author }              → 202 { job }
 *        backupKey: derived by the app from the recovery code the owner typed; must match the sealed
 *        key; held in memory for the verify, never stored or logged. Whole box only.
 */

export type Reply = { status: number; data: unknown }

/** The secret may be left out when editing: the saved one is used. */
const testInput = z.object({ target: s3TargetSchema.extend({ secretAccessKey: s3TargetSchema.shape.secretAccessKey.optional() }) }).strict()
const runInput = z
  .object({ author: z.string().min(1).max(64), trigger: z.enum(['manual', 'scheduled']).default('manual'), wait: z.boolean().default(false) })
  .strict()

export async function backupRoute(svc: BackupService, route: string, readBody: () => Promise<unknown>): Promise<Reply | null> {
  try {
    if (route === 'GET /v1/backups') return { status: 200, data: await svc.status() }
    if (route === 'POST /v1/backups/test') {
      const i = testInput.parse(await readBody())
      const secretAccessKey = i.target.secretAccessKey ?? svc.config()?.target.secretAccessKey
      if (!secretAccessKey) return { status: 400, data: { type: 'urn:ee:invalid_input', title: 'the secret access key is required', detail: 'the secret access key is required' } }
      return { status: 200, data: await svc.testConnection({ ...i.target, secretAccessKey }) }
    }
    if (route === 'POST /v1/backups/config') return { status: 200, data: await svc.configure(await readBody()) }
    if (route === 'POST /v1/backups/run') {
      const i = runInput.parse(await readBody())
      // The timer firing on a box where nobody set backups up is not a failure.
      if (i.trigger === 'scheduled' && !svc.config()) return { status: 200, data: { skipped: 'backups are not set up' } }
      const { run, done } = await svc.start(i.trigger, i.author)
      return { status: 200, data: { run: i.wait ? await done : run } }
    }
    return null
  } catch (err) {
    if (err instanceof BackupError) return { status: err.status, data: { type: 'urn:ee:backup', title: err.message, detail: err.message } }
    throw err
  }
}

export async function restoreRoute(svc: RestoreService, route: string, readBody: () => Promise<unknown>): Promise<Reply | null> {
  try {
    if (route === 'GET /v1/backups/snapshots') return { status: 200, data: await svc.snapshots() }
    if (route === 'GET /v1/backups/restore') return { status: 200, data: { job: await svc.job() } }
    if (route === 'POST /v1/backups/check') return { status: 202, data: { job: (await svc.check(await readBody())).job } }
    if (route === 'POST /v1/backups/restore') return { status: 202, data: { job: (await svc.restore(await readBody())).job } }
    return null
  } catch (err) {
    if (err instanceof BackupError) return { status: err.status, data: { type: 'urn:ee:backup', title: err.message, detail: err.message } }
    throw err
  }
}
