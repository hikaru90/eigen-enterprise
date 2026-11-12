import type { RepoSnapshot, RepoSummary } from './snapshot-types'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { repoSources, repoSourceTokens } from '$lib/server/db/repos.schema'
import { FRESH_STATE, type NewSource, type ReposStore, type SourcePatch, type SourceRow, type TokenPatch, type TokenRow } from './store'

/** The repos tables carry no RLS (company-level data): the request-scoped handle when there is one, the pooled app handle otherwise. */
export async function reposDb(): Promise<AppDatabase> {
  const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
  return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
}

type SourceDbRow = typeof repoSources.$inferSelect

const SUMMARY_ERROR_KINDS = new Set(['no_model', 'failed'])

const toSource = (r: SourceDbRow): SourceRow => {
  if (r.summaryErrorKind !== null && !SUMMARY_ERROR_KINDS.has(r.summaryErrorKind))
    throw new Error(`repo_sources ${r.id} has an unknown summary_error_kind ${r.summaryErrorKind}`)
  return {
    ...r,
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
    return toSource(r)
  }
  async updateSource(id: string, patch: SourcePatch) {
    const out = await (await this.db()).update(repoSources).set(patch).where(eq(repoSources.id, id)).returning({ id: repoSources.id })
    if (out.length === 0) throw new Error(`repo_sources ${id} not found`)
  }
  async updateSourcesOfToken(tokenId: string, patch: SourcePatch) {
    await (await this.db()).update(repoSources).set(patch).where(eq(repoSources.tokenId, tokenId))
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
