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
    await store.updateSource(s.id, { etags: { repo: '"e1"' }, branchHeads: { main: 'abc' }, docShas: { 'README.md': 'r1' }, snapshot: { takenAt: 'x' } as never })
    expect(await store.source(s.id)).toMatchObject({ etags: { repo: '"e1"' }, branchHeads: { main: 'abc' }, docShas: { 'README.md': 'r1' }, snapshot: { takenAt: 'x' } })
    await expect(store.enableSource({ tokenId: other.id, repoId: id, fullName: 'pg/state', defaultBranch: 'main', dueAt: past })).rejects.toThrow('another token')
    const again = await store.enableSource({ tokenId: t.id, repoId: id, fullName: 'pg/renamed', defaultBranch: 'dev', dueAt: past })
    expect(again).toMatchObject({ id: s.id, fullName: 'pg/renamed', defaultBranch: 'dev', etags: {}, snapshot: null })
    await store.deleteToken(t.id)
    expect(await store.source(s.id)).toBeNull()
  })
})
