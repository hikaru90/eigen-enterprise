import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq, inArray, lt } from 'drizzle-orm'
import { KernelError } from '$lib/kernel/errors'
import type { CompanyExportView, ExportPort } from '$lib/kernel/export-tools'
import { getUserRole } from '$lib/server/auth/user-role'
import { companyDb } from '$lib/server/db'
import { companyExport, type CompanyExportSummary } from '$lib/server/db/kernel.schema'
import type { UserJobQueue } from '$lib/server/db/schema'
import { env } from '$lib/server/env/private-env'
import { createAdminSql } from '$lib/server/job-queue/admin-db'
import { COMPANY_EXPORT_JOB } from '$lib/server/job-queue/constants'
import { enqueueUserJob } from '$lib/server/job-queue/enqueue'
import { version as appVersion } from '../../../../../package.json'
import { cursorRows, readCatalog } from './catalog'
import { concatFiles, extensionExportFiles } from './extensions'
import { companyExportFiles } from './files'
import { COMPANY_EXPORT_EXCLUDED_SCHEMAS, COMPANY_EXPORT_RULES } from './rules'
import { buildCompanyExport } from './run'

/**
 * Live wiring of the company export (plan/phase-export.md X1). The job queue
 * only *triggers* a build: the export row is claimed once (pending → running)
 * and the build runs detached in the app, so the queue's 5-minute stale-job
 * recovery can never start a second build of the same export. A build that a
 * restart cut off is marked failed at boot, loudly, never silently re-run.
 */

/** How long a finished archive stays on the server. */
export const EXPORT_KEEP_MS = 7 * 24 * 60 * 60 * 1000

export function exportDir(): string {
  const explicit = env.EE_EXPORT_DIR?.trim()
  if (explicit) return explicit
  const state = env.EE_STATE_DIR?.trim()
  if (state) return join(state, 'exports')
  throw new Error(
    'company export storage is not configured: set EE_EXPORT_DIR, or run under the ee substrate which injects EE_STATE_DIR (exports then live at $EE_STATE_DIR/exports).',
  )
}

export function exportFile(id: string): string {
  return join(exportDir(), `${id}.zip`)
}

type Row = typeof companyExport.$inferSelect

/** The company data repo's extensions/ (the modules' data), read from the live working tree. */
async function* liveExtensionFiles() {
  const { companyData } = await import('$lib/server/gitstore/live')
  const engine = (await companyData()).framework.engine
  yield* extensionExportFiles({ list: (prefix) => engine.listWorking(prefix), read: (path) => engine.readWorking(path) })
}

function toView(r: Row, now = new Date()): CompanyExportView {
  const live = r.status === 'done' && (!r.expiresAt || r.expiresAt > now)
  return {
    id: r.id,
    status: r.status,
    requestedBy: r.requestedBy,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    bytes: r.bytes ?? null,
    summary: r.summary ?? null,
    error: r.error ?? null,
    downloadPath: live ? `/api/exports/${r.id}/download` : null,
  }
}

async function row(id: string): Promise<Row | null> {
  const [r] = await companyDb().select().from(companyExport).where(eq(companyExport.id, id)).limit(1)
  return r ?? null
}

/** Deletes expired archives; their rows stay as `deleted`. */
export async function pruneExpiredExports(now = new Date()): Promise<number> {
  const expired = await companyDb()
    .select({ id: companyExport.id })
    .from(companyExport)
    .where(and(eq(companyExport.status, 'done'), lt(companyExport.expiresAt, now)))
  for (const { id } of expired) {
    await rm(exportFile(id), { force: true })
    await companyDb().update(companyExport).set({ status: 'deleted' }).where(eq(companyExport.id, id))
  }
  return expired.length
}

/** Boot: a build the restart cut off is failed, said plainly (the partial file is removed). */
export async function failInterruptedExports(): Promise<number> {
  const cut = await companyDb()
    .update(companyExport)
    .set({ status: 'failed', error: 'The server restarted while this export was being built. Start a new export.', finishedAt: new Date() })
    .where(eq(companyExport.status, 'running'))
    .returning({ id: companyExport.id })
  for (const { id } of cut) await rm(exportFile(id), { force: true })
  return cut.length
}

export const liveExportPort: ExportPort = {
  isOwner: async (userId) => (await getUserRole(userId)) === 'owner',
  start: async (userId) => {
    exportDir() // fail loud before anything is recorded when storage isn't configured
    const busy = await companyDb()
      .select({ id: companyExport.id })
      .from(companyExport)
      .where(inArray(companyExport.status, ['pending', 'running']))
      .limit(1)
    if (busy.length) throw new KernelError('run_in_progress', `A company export is already being built (${busy[0].id}).`)
    await pruneExpiredExports()
    const [r] = await companyDb().insert(companyExport).values({ requestedBy: userId }).returning()
    const queued = await enqueueUserJob({
      userId,
      jobType: COMPANY_EXPORT_JOB,
      runAfter: new Date(),
      dedupeKey: `company_export:${r.id}`,
      payload: { exportId: r.id },
      maxAttempts: 1,
    })
    if (!queued.enqueued) throw new Error(`company export ${r.id}: the job was not queued (${queued.reason})`)
    return toView(r)
  },
  get: async (id) => {
    const r = await row(id)
    return r ? toView(r) : null
  },
  list: async () =>
    (await companyDb().select().from(companyExport).orderBy(desc(companyExport.createdAt)).limit(50)).map((r) => toView(r)),
  remove: async (id) => {
    const r = await row(id)
    if (!r) return null
    if (r.status === 'pending' || r.status === 'running') {
      throw new KernelError('run_in_progress', 'This export is still being built; delete it once it is done.')
    }
    await rm(exportFile(id), { force: true })
    const [u] = await companyDb().update(companyExport).set({ status: 'deleted' }).where(eq(companyExport.id, id)).returning()
    return toView(u)
  },
}

/** The job: claims the export once and starts the build detached (see the file comment). */
export async function processCompanyExportJob(job: UserJobQueue): Promise<void> {
  const id = typeof job.payload.exportId === 'string' ? job.payload.exportId : ''
  if (!id) throw new Error(`company export job ${job.id} has no exportId`)
  const claimed = await companyDb()
    .update(companyExport)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(companyExport.id, id), eq(companyExport.status, 'pending')))
    .returning({ id: companyExport.id })
  if (!claimed.length) return // already built or deleted: nothing to do
  void runCompanyExport(id, job.userId)
}

export async function runCompanyExport(id: string, requestedBy: string): Promise<void> {
  const sql = createAdminSql(2)
  try {
    await mkdir(exportDir(), { recursive: true })
    const { manifest, bytes } = await buildCompanyExport(
      {
        file: exportFile(id),
        rules: COMPANY_EXPORT_RULES,
        excludedSchemas: COMPANY_EXPORT_EXCLUDED_SCHEMAS,
        company: { name: await (await import('$lib/server/overview/sources')).foundingCompanyName() },
        appVersion,
        requestedBy,
        now: () => new Date(),
      },
      {
        catalog: () => readCatalog(sql),
        rows: (query) => cursorRows(sql, query),
        // The company's files, then the company modules' data (extensions/<id>/, U2 D7).
        files: () => concatFiles(companyExportFiles(sql), liveExtensionFiles()),
      },
    )
    const summary: CompanyExportSummary = {
      tables: manifest.tables.length,
      rows: manifest.tables.reduce((n, t) => n + t.rows, 0),
      privateRows: manifest.tables.reduce((n, t) => n + t.privateRows, 0),
      files: manifest.entries.filter((e) => e.path.startsWith('files/')).length,
      excluded: manifest.excluded.length,
    }
    const finishedAt = new Date()
    await companyDb()
      .update(companyExport)
      .set({ status: 'done', bytes, summary, finishedAt, expiresAt: new Date(finishedAt.getTime() + EXPORT_KEEP_MS) })
      .where(eq(companyExport.id, id))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[company-export] failed', { id, message })
    await companyDb()
      .update(companyExport)
      .set({ status: 'failed', error: message, finishedAt: new Date() })
      .where(eq(companyExport.id, id))
  } finally {
    await sql.end()
  }
}
