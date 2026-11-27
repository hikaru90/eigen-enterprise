import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import * as schema from '$lib/server/db/schema'
import { dbShareWhereStore } from './share-where'

/**
 * "Share where I am" against real Postgres (the test DB, :5433; migrations
 * applied, 0188): a person without a preference row shares; switching writes
 * the row (upsert) and keeps their other preferences. Skipped without
 * DATABASE_URL.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('user_preference.share_where (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const ann = `pg-spec-ann-${randomUUID()}`
  const ben = `pg-spec-ben-${randomUUID()}`

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql, { schema }) as unknown as AppDatabase
    for (const id of [ann, ben]) {
      await sql`insert into "user" (id, name, email) values (${id}, ${id}, ${`${id}@pg-spec.test`})`
    }
    await sql`insert into user_preference (user_id, preferred_language) values (${ben}, 'de')`
  })

  afterAll(async () => {
    await sql`delete from "user" where id in (${ann}, ${ben})`
    await sql.end()
  })

  it('nobody switched it off yet: no row and an existing row both share', async () => {
    const off = await dbShareWhereStore(db).offIds()
    expect(off).not.toContain(ann)
    expect(off).not.toContain(ben)
  })

  it('switching off writes the row (or updates it, other preferences kept); on again clears it', async () => {
    const store = dbShareWhereStore(db)
    await store.set(ann, false)
    await store.set(ben, false)
    expect(await store.offIds()).toEqual(expect.arrayContaining([ann, ben]))
    const [row] = await sql`select preferred_language from user_preference where user_id = ${ben}`
    expect(row.preferred_language).toBe('de')
    await store.set(ann, true)
    const off = await store.offIds()
    expect(off).not.toContain(ann)
    expect(off).toContain(ben)
  })
})
