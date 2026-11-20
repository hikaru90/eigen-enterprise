import type { TokenRow } from './store'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DbReposStore } from './db-store'

/**
 * The repos store against real Postgres (the test DB, :5433, migration 0134
 * applied): two tickers claiming at once never share a repo, the lease and
 * the token's error keep rows out, and the state round-trips. Skipped without
 * DATABASE_URL.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('repos store (Postgres)', () => {
  let sql: postgres.Sql
  let store: DbReposStore
  const tokens: string[] = []

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 4, onnotice: () => {} })
    const { drizzle } = await import('drizzle-orm/postgres-js')
    // Separate connections, so the two claims below really run concurrently.
    store = new DbReposStore(async () => drizzle(sql))
  })

  afterAll(async () => {
    if (tokens.length > 0) await sql`delete from repo_source_tokens where id in ${sql(tokens)}`
    await sql.end()
  })

  const token = async (over: Partial<TokenRow> = {}): Promise<TokenRow> => {
    const row: TokenRow = {
      id: randomUUID(),
      githubLogin: 'pg-spec',
      tokenSealed: '{"sealed":true}',
      last4: 'abcd',
      expiresAt: null,
      addedBy: 'pg-spec',
      createdAt: new Date(),
      lastError: null,
      ...over,
    }
    tokens.push(row.id)
    await store.insertToken(row)
    return row
  }
  const repoId = () => 9_000_000_000 + Math.floor(Math.random() * 1_000_000_000)
  const past = new Date('2020-01-01T00:00:00Z')

  it('two concurrent tickers never claim the same repo', async () => {
    const t = await token()
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) => store.enableSource({ tokenId: t.id, repoId: repoId(), fullName: `pg/r${i}`, defaultBranch: 'main', dueAt: past })),
    ).then((rows) => rows.map((r) => r.id))
    const now = new Date()
    const [a, b] = await Promise.all([
      store.claimDue({ owner: 'slot-a', limit: 4, now, leaseMs: 60_000 }),
      store.claimDue({ owner: 'slot-b', limit: 4, now, leaseMs: 60_000 }),
    ])
    const mine = (rows: { id: string }[]) => rows.map((r) => r.id).filter((id) => ids.includes(id))
    const all = [...mine(a), ...mine(b)]
    expect(new Set(all).size).toBe(all.length)
    expect(all.sort()).toEqual([...ids].sort())
    // The lease holds: nothing is claimed again while it runs.
    expect(mine(await store.claimDue({ owner: 'slot-c', limit: 10, now, leaseMs: 60_000 }))).toEqual([])
  })

  it("leaves out paused repos, repos not due, and every repo of a token that stopped", async () => {
    const stopped = await token({ lastError: 'The GitHub token for x no longer works.' })
    const ok = await token()
    const a = await store.enableSource({ tokenId: stopped.id, repoId: repoId(), fullName: 'pg/stopped', defaultBranch: 'main', dueAt: past })
    const b = await store.enableSource({ tokenId: ok.id, repoId: repoId(), fullName: 'pg/paused', defaultBranch: 'main', dueAt: past })
    const c = await store.enableSource({ tokenId: ok.id, repoId: repoId(), fullName: 'pg/later', defaultBranch: 'main', dueAt: new Date(Date.now() + 3_600_000) })
    await store.updateSource(b.id, { pausedUntil: new Date(Date.now() + 3_600_000) })
    const claimed = (await store.claimDue({ owner: 'slot-a', limit: 50, now: new Date(), leaseMs: 60_000 })).map((r) => r.id)
    expect(claimed).not.toContain(a.id)
    expect(claimed).not.toContain(b.id)
    expect(claimed).not.toContain(c.id)
    expect((await store.claimDue({ owner: 'slot-a', limit: 1, now: new Date(), leaseMs: 60_000, onlyId: c.id })).map((r) => r.id)).toEqual([c.id])
  })

  it('round-trips the sync state, and a repo id belongs to one token', async () => {
    const t = await token()
    const other = await token()
    const id = repoId()
    const s = await store.enableSource({ tokenId: t.id, repoId: id, fullName: 'pg/state', defaultBranch: 'main', dueAt: past })
    await store.updateSource(s.id, { etags: { repo: '"e1"' }, branchHeads: { main: 'abc' }, copyMode: 'docs', snapshot: { takenAt: 'x' } as never })
    expect(await store.source(s.id)).toMatchObject({ etags: { repo: '"e1"' }, branchHeads: { main: 'abc' }, copyMode: 'docs', snapshot: { takenAt: 'x' } })
    await expect(store.enableSource({ tokenId: other.id, repoId: id, fullName: 'pg/state', defaultBranch: 'main', dueAt: past })).rejects.toThrow('another token')
    const again = await store.enableSource({ tokenId: t.id, repoId: id, fullName: 'pg/renamed', defaultBranch: 'dev', dueAt: past })
    expect(again).toMatchObject({ id: s.id, fullName: 'pg/renamed', defaultBranch: 'dev', etags: {}, snapshot: null, copyMode: 'docs' })
    await store.deleteToken(t.id)
    expect(await store.source(s.id)).toBeNull()
  })

  it('the file rows (migration 0161) upsert, delete and cascade with the repo', async () => {
    const t = await token()
    const s = await store.enableSource({ tokenId: t.id, repoId: repoId(), fullName: 'pg/files', defaultBranch: 'main', dueAt: past })
    expect(await store.sourceFiles(s.id)).toEqual([])
    const rows = Array.from({ length: 1200 }, (_, i) => ({ path: `src/file-${String(i).padStart(4, '0')}.ts`, sha: `${i}`.padEnd(40, 'a'), size: i }))
    await store.upsertSourceFiles(s.id, rows)
    expect(await store.sourceFiles(s.id)).toEqual(rows)
    // Upserts update in place and inserts only the missing.
    await store.upsertSourceFiles(s.id, [{ path: rows[0]!.path, sha: 'b'.padEnd(40, '0'), size: 1 }, { path: 'README.md', sha: 'c'.padEnd(40, '0'), size: 2 }])
    const after = await store.sourceFiles(s.id)
    expect(after.find((f) => f.path === rows[0]!.path)).toMatchObject({ sha: 'b'.padEnd(40, '0') })
    expect(after).toHaveLength(1201)
    await store.deleteSourceFiles(s.id, [rows[0]!.path, 'src/file-0001.ts'])
    const remaining = await store.sourceFiles(s.id)
    expect(remaining.some((f) => f.path === 'src/file-0000.ts' || f.path === 'src/file-0001.ts')).toBe(false)
    expect(remaining.some((f) => f.path === 'src/file-0002.ts')).toBe(true)
    // Re-enabling resets to a fresh state: the copied file rows go with it.
    await store.enableSource({ tokenId: t.id, repoId: s.repoId, fullName: 'pg/files', defaultBranch: 'main', dueAt: past })
    expect(await store.sourceFiles(s.id)).toEqual([])
    await expect(sql`update repo_sources set copy_mode = 'everything' where id = ${s.id}`).rejects.toThrow(/copy_mode_check/)
    await store.deleteToken(t.id)
    expect(await store.sourceFiles(s.id)).toEqual([])
  })

  it('the summary columns (migration 0135) round-trip, and re-enabling clears them', async () => {
    const t = await token()
    const id = repoId()
    const row = await store.enableSource({ tokenId: t.id, repoId: id, fullName: 'pg/summary', defaultBranch: 'main', dueAt: past })
    expect(row).toMatchObject({ summary: null, summaryErrorKind: null, summaryError: null, summaryErrorAt: null })
    const summary = { summary: 'All good.', highlights: [{ kind: 'pr' as const, text: 'Merged', ref: '#1' }], writtenAt: '2026-11-12T14:00:00.000Z' }
    const at = new Date('2026-11-12T14:16:00Z')
    await store.updateSource(row.id, { summary, summaryErrorKind: 'failed', summaryError: 'Writing the summary failed.', summaryErrorAt: at })
    expect(await store.source(row.id)).toMatchObject({ summary, summaryErrorKind: 'failed', summaryError: 'Writing the summary failed.', summaryErrorAt: at })
    await expect(sql`update repo_sources set summary_error_kind = 'other' where id = ${row.id}`).rejects.toThrow(/summary_error_kind_check/)
    const again = await store.enableSource({ tokenId: t.id, repoId: id, fullName: 'pg/summary', defaultBranch: 'main', dueAt: past })
    expect(again).toMatchObject({ summary: null, summaryErrorKind: null })
  })
})
