import { z } from 'zod'
import { s3TargetSchema } from './s3.ts'
import { BackupError, type BackupService } from './service.ts'

/**
 * Backup verbs of the control API (owner actions per D11 — the app only offers
 * them on the owner-only Settings → Backups page; the agent reads status).
 *   GET  /v1/backups            status, config (no secrets), last runs, health
 *   POST /v1/backups/test       { target }                      → { ok } | { ok:false, error }
 *   POST /v1/backups/config     { target, schedule, retentionDays, author } → { recoveryCode|null, config }
 *   POST /v1/backups/run        { author, trigger?, wait? }     → { run }
 */

export type Reply = { status: number; data: unknown }

const testInput = z.object({ target: s3TargetSchema }).strict()
const runInput = z
  .object({ author: z.string().min(1).max(64), trigger: z.enum(['manual', 'scheduled']).default('manual'), wait: z.boolean().default(false) })
  .strict()

export async function backupRoute(svc: BackupService, route: string, readBody: () => Promise<unknown>): Promise<Reply | null> {
  try {
    if (route === 'GET /v1/backups') return { status: 200, data: await svc.status() }
    if (route === 'POST /v1/backups/test') {
      const i = testInput.parse(await readBody())
      return { status: 200, data: await svc.testConnection(i.target) }
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
