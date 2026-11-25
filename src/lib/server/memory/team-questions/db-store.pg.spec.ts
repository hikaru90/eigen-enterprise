import type { TeamQuestion } from './store'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbTeamQuestionStore } from './db-store'

/**
 * The Postgres store against a database with migration 0183 applied
 * (DATABASE_URL); skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('team_questions store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const author = `pg-spec-q-${randomUUID()}`
  const reader = `pg-spec-r-${randomUUID()}`
  const group = `pg-spec-g-${randomUUID()}`

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 4, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    await sql`delete from team_questions where author_id = ${author}`
    await sql.end()
  })

  const question = (over: Partial<TeamQuestion> = {}): TeamQuestion => {
    const at = new Date('2026-11-25T09:00:00Z')
    return {
      id: randomUUID(),
      authorId: author,
      text: 'Who owns the Acme renewal?',
      tags: ['sales'],
      audienceKind: 'chosen',
      audienceGroupIds: [group],
      audienceUserIds: [],
      status: 'open',
      createdVia: 'person',
      createdAt: at,
      updatedAt: at,
      closedAt: null,
      ...over,
    }
  }

  it('round-trips, lists by audience (author, person, group, company), answers while open, closes once', async () => {
    const store = dbTeamQuestionStore(() => db)
    const forGroup = question()
    const forReader = question({ audienceGroupIds: [], audienceUserIds: [reader], createdAt: new Date('2026-11-25T09:01:00Z') })
    await store.insert(forGroup)
    await store.insert(forReader)
    expect(await store.get(forGroup.id)).toEqual(forGroup)
    const ids = async (userId: string, groupIds: string[] = []) => (await store.listVisible({ userId, groupIds })).map((q) => q.id)
    expect(await ids(author)).toEqual(expect.arrayContaining([forReader.id, forGroup.id]))
    expect(await ids(reader)).toContain(forReader.id)
    expect(await ids(reader)).not.toContain(forGroup.id)
    expect(await ids('someone', [group])).toContain(forGroup.id)
    expect(await ids('someone', [group])).not.toContain(forReader.id)

    const answer = { id: randomUUID(), questionId: forGroup.id, authorId: reader, body: 'Kim.', createdVia: 'person' as const, createdAt: new Date('2026-11-25T10:00:00Z') }
    expect(await store.addAnswer(answer)).toMatchObject({ id: forGroup.id, updatedAt: answer.createdAt })
    expect(await store.answers([forGroup.id])).toEqual([answer])

    const at = new Date('2026-11-25T11:00:00Z')
    const [a, b] = await Promise.all([store.close(forGroup.id, at), store.close(forGroup.id, at)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(await store.addAnswer({ ...answer, id: randomUUID() })).toBeNull()
    expect(await store.answers([forGroup.id])).toHaveLength(1)
  })

  it('the database refuses an empty question, a company audience with names, an empty chosen audience', async () => {
    const store = dbTeamQuestionStore(() => db)
    await expect(store.insert(question({ text: '  ' }))).rejects.toThrow()
    await expect(store.insert(question({ audienceKind: 'company' }))).rejects.toThrow()
    await expect(store.insert(question({ audienceGroupIds: [] }))).rejects.toThrow()
  })
})
