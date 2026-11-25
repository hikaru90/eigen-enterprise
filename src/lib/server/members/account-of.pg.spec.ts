import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * accountOf against the test database (DATABASE_URL); skipped without it.
 * It answers who is acting — a harness account included — while the members
 * listing (dbMemberStore) keeps harness accounts out. A removed AI co-worker
 * is no one.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('accountOf (Postgres)', () => {
  let sql: postgres.Sql
  const tag = randomUUID().slice(0, 8)
  const production = `acct-p-${tag}`
  const harness = `acct-h-${tag}`
  const removed = `acct-r-${tag}`

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    await sql`insert into "user" (id, name, email, account_kind) values
      (${production}, 'Pat Production', ${`${production}@example.test`}, 'production'),
      (${harness}, 'Hal Harness', ${`${harness}@example.test`}, 'harness')`
    await sql`insert into "user" (id, name, email, kind) values (${removed}, 'Rex Removed', ${`${removed}@example.test`}, 'coworker')`
    await sql`insert into coworker_profile (user_id, slug, lens, model_id, daily_cap_usd, created_by, enabled, removed_at)
      values (${removed}, ${`rex-${tag}`}, 'ops', 'm', 1, ${production}, false, now())`
  })

  afterAll(async () => {
    await sql`delete from coworker_profile where user_id = ${removed}`
    await sql`delete from "user" where id in (${production}, ${harness}, ${removed})`
    await sql.end()
  })

  it('finds a production account and a harness account; a removed co-worker and an unknown id are no one', async () => {
    const { accountOf } = await import('./account-of')
    expect(await accountOf(production)).toEqual({ id: production, name: 'Pat Production' })
    expect(await accountOf(harness)).toEqual({ id: harness, name: 'Hal Harness' })
    expect(await accountOf(removed)).toBeNull()
    expect(await accountOf(`nobody-${tag}`)).toBeNull()
  })

  it('the members listing still leaves the harness account out', async () => {
    const { dbMemberStore } = await import('./db-store')
    expect(await dbMemberStore.getMember(harness)).toBeNull()
    expect(await dbMemberStore.getMember(production)).toMatchObject({ id: production })
  })
})
