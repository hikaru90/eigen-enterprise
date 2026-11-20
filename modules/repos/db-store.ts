import type { CopyMode, FileSnap, RepoSnapshot, RepoSummary } from './snapshot-types'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { repoSourceFiles, repoSources, repoSourceTokens } from '$lib/server/db/repos.schema'
import { FRESH_STATE, type NewSource, type ReposStore, type SourcePatch, type SourceRow, type TokenPatch, type TokenRow } from './store'

/** The repos tables carry no RLS (company-level data): the request-scoped handle when there is one, the pooled app handle otherwise. */
export async function reposDb(): Promise<AppDatabase> {
  const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
  return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
}

type SourceDbRow = typeof repoSources.$inferSelect

const SUMMARY_ERROR_KINDS = new Set(['no_model', 'failed'])
const COPY_MODES = new Set<CopyMode>(['all', 'docs'])
/** File rows per statement; repo_source_files writes go in chunks of this size. */
const FILE_BATCH = 500

const toSource = (r: SourceDbRow): SourceRow => {
  if (r.summaryErrorKind !== null && !SUMMARY_ERROR_KINDS.has(r.summaryErrorKind))
    throw new Error(`repo_sources ${r.id} has an unknown summary_error_kind ${r.summaryErrorKind}`)
  if (!COPY_MODES.has(r.copyMode as CopyMode)) throw new Error(`repo_sources ${r.id} has an unknown copy_mode ${r.copyMode}`)
  return {
    ...r,
    copyMode: r.copyMode as CopyMode,
    snapshot: (r.snapshot ?? null) as RepoSnapshot | null,
    summary: (r.summary ?? null) as RepoSummary | null,
    summaryErrorKind: r.summaryErrorKind as SourceRow['summaryErrorKind'],
  }
}

export class DbReposStore implements ReposStore {
  constructor(private readonly db: () => Promise<AppDatabase> = reposDb) {}

  async insertToken(row: TokenRow) {
    await (await this.db()).insert(repoSourceTokens).values(row)
  }
  async token(id: string) {
    const [r] = await (await this.db()).select().from(repoSourceTokens).where(eq(repoSourceTokens.id, id))
    return r ?? null
  }
  async tokens() {
    return (await this.db()).select().from(repoSourceTokens).orderBy(asc(repoSourceTokens.createdAt))
  }
  async updateToken(id: string, patch: TokenPatch) {
    const out = await (await this.db()).update(repoSourceTokens).set(patch).where(eq(repoSourceTokens.id, id)).returning({ id: repoSourceTokens.id })
    if (out.length === 0) throw new Error(`repo_source_tokens ${id} not found`)
  }
  async deleteToken(id: string) {
    await (await this.db()).delete(repoSourceTokens).where(eq(repoSourceTokens.id, id))
  }

  async sources() {
    return (await (await this.db()).select().from(repoSources).orderBy(asc(repoSources.fullName))).map(toSource)
  }
  async source(id: string) {
    const [r] = await (await this.db()).select().from(repoSources).where(eq(repoSources.id, id))
    return r ? toSource(r) : null
  }
  async sourceByRepoId(repoId: number) {
    const [r] = await (await this.db()).select().from(repoSources).where(eq(repoSources.repoId, repoId))
    return r ? toSource(r) : null
  }
  async enableSource(n: NewSource) {
    const db = await this.db()
    const fresh = { ...FRESH_STATE, fullName: n.fullName, defaultBranch: n.defaultBranch, enabled: true, dueAt: n.dueAt }
    const [r] = await db
      .insert(repoSources)
      .values({ ...n, ...fresh })
      .onConflictDoUpdate({ target: repoSources.repoId, set: fresh, where: eq(repoSources.tokenId, n.tokenId) })
      .returning()
    if (!r) throw new Error(`repo ${n.repoId} belongs to another token`)
    // A fresh state re-reads every file: the copied file rows go with it.
    await db.delete(repoSourceFiles).where(eq(repoSourceFiles.sourceId, r.id))
    return toSource(r)
  }
  async updateSource(id: string, patch: SourcePatch) {
    const out = await (await this.db()).update(repoSources).set(patch).where(eq(repoSources.id, id)).returning({ id: repoSources.id })
    if (out.length === 0) throw new Error(`repo_sources ${id} not found`)
  }
  async updateSourcesOfToken(tokenId: string, patch: SourcePatch) {
    await (await this.db()).update(repoSources).set(patch).where(eq(repoSources.tokenId, tokenId))
  }

  async sourceFiles(sourceId: string) {
    const rows = await (await this.db())
      .select({ path: repoSourceFiles.path, sha: repoSourceFiles.sha, size: repoSourceFiles.size })
      .from(repoSourceFiles)
      .where(eq(repoSourceFiles.sourceId, sourceId))
      .orderBy(asc(repoSourceFiles.path))
    return rows as FileSnap[]
  }
  async upsertSourceFiles(sourceId: string, rows: FileSnap[]) {
    const db = await this.db()
    for (let i = 0; i < rows.length; i += FILE_BATCH) {
      const chunk = rows.slice(i, i + FILE_BATCH).map((r) => ({ sourceId, ...r }))
      if (chunk.length === 0) continue
      await db
        .insert(repoSourceFiles)
        .values(chunk)
        .onConflictDoUpdate({ target: [repoSourceFiles.sourceId, repoSourceFiles.path], set: { sha: sql`excluded.sha`, size: sql`excluded.size` } })
    }
  }
  async deleteSourceFiles(sourceId: string, paths: string[]) {
    const db = await this.db()
    for (let i = 0; i < paths.length; i += FILE_BATCH) {
      const chunk = paths.slice(i, i + FILE_BATCH)
      if (chunk.length === 0) continue
      await db.delete(repoSourceFiles).where(and(eq(repoSourceFiles.sourceId, sourceId), inArray(repoSourceFiles.path, chunk)))
    }
  }
  async setCopyMode(sourceId: string, mode: CopyMode) {
    await this.updateSource(sourceId, { copyMode: mode })
  }

  /**
   * One statement, FOR UPDATE SKIP LOCKED (like email's mail_jobs): two
   * tickers (blue-green slots) never claim the same repo, and a live lease
   * keeps a long sync from being claimed again.
   */
  async claimDue(opts: { owner: string; limit: number; now: Date; leaseMs: number; onlyId?: string }) {
    const db = await this.db()
    const now = opts.now.toISOString()
    const until = new Date(opts.now.getTime() + opts.leaseMs).toISOString()
    const which = opts.onlyId ? sql`s.id = ${opts.onlyId}::uuid` : sql`s.due_at <= ${now}::timestamptz`
    const claimed = await db.execute<{ id: string }>(sql`
      UPDATE repo_sources SET claimed_by = ${opts.owner}, claimed_until = ${until}::timestamptz
      WHERE id IN (
        SELECT s.id FROM repo_sources s JOIN repo_source_tokens t ON t.id = s.token_id
        WHERE s.enabled AND ${which}
          AND (s.paused_until IS NULL OR s.paused_until <= ${now}::timestamptz)
          AND (s.claimed_until IS NULL OR s.claimed_until < ${now}::timestamptz)
          AND t.last_error IS NULL
        ORDER BY s.due_at LIMIT ${opts.limit} FOR UPDATE OF s SKIP LOCKED
      )
      RETURNING id`)
    const ids = [...claimed].map((r) => r.id)
    if (ids.length === 0) return []
    const rows = await db
      .select()
      .from(repoSources)
      .where(and(inArray(repoSources.id, ids), eq(repoSources.claimedBy, opts.owner)))
      .orderBy(asc(repoSources.dueAt))
    return rows.map(toSource)
  }
}

export const dbReposStore = (): ReposStore => new DbReposStore()
