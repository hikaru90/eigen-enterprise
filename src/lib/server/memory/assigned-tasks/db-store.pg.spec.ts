import type { AssignedTask } from './store'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbAssignedTaskStore } from './db-store'

/**
 * The Postgres store against a database with migration 0159 applied
 * (DATABASE_URL); skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('assigned_tasks store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const assigner = `pg-spec-a-${randomUUID()}`
  const assignee = `pg-spec-b-${randomUUID()}`

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 4, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    await sql`delete from assigned_tasks where assigner_id = ${assigner}`
    await sql.end()
  })

  const task = (over: Partial<AssignedTask> = {}): AssignedTask => {
    const at = new Date('2026-11-19T09:00:00Z')
    return {
      id: randomUUID(),
      assignerId: assigner,
      assigneeId: assignee,
      title: 'Send the Q4 deck',
      context: 'Before the call.',
      dueOn: '2026-11-21',
      status: 'open',
      createdVia: 'assistant',
      createdAt: at,
      updatedAt: at,
      completedAt: null,
      assigneeUpdate: 'assigned',
      assigneeUpdateAt: at,
      assigneeSeenAt: null,
      assignerUpdate: null,
      assignerUpdateAt: null,
      assignerSeenAt: at,
      ...over,
    }
  }

  it('round-trips a task, lists it for both people, completes once, and keeps comments in order', async () => {
    const store = dbAssignedTaskStore(() => db)
    const t = task()
    await store.insert(t)
    expect(await store.get(t.id)).toEqual(t)
    expect((await store.listFor(assignee)).map((x) => x.id)).toContain(t.id)
    expect((await store.listFor(assigner)).map((x) => x.id)).toContain(t.id)
    expect((await store.listFor('someone-else')).map((x) => x.id)).not.toContain(t.id)

    const c1 = { id: randomUUID(), taskId: t.id, authorId: assignee, body: 'Which version?', createdAt: new Date('2026-11-19T10:00:00Z') }
    const afterComment = await store.addComment(c1, 'assignee')
    expect(afterComment).toMatchObject({ assignerUpdate: 'commented', assignerUpdateAt: c1.createdAt, assigneeSeenAt: c1.createdAt })
    const c2 = { id: randomUUID(), taskId: t.id, authorId: assigner, body: 'With pricing.', createdAt: new Date('2026-11-19T10:05:00Z') }
    await store.addComment(c2, 'assigner')
    expect((await store.comments([t.id])).map((c) => c.body)).toEqual(['Which version?', 'With pricing.'])

    const doneAt = new Date('2026-11-19T11:00:00Z')
    const [a, b] = await Promise.all([store.complete(t.id, doneAt), store.complete(t.id, doneAt)])
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(await store.get(t.id)).toMatchObject({ status: 'done', completedAt: doneAt, assignerUpdate: 'completed' })

    await store.markSeen(t.id, 'assigner', new Date('2026-11-19T12:00:00Z'))
    expect((await store.get(t.id))!.assignerSeenAt).toEqual(new Date('2026-11-19T12:00:00Z'))
  })

  it('the database refuses a task to yourself, an empty title and a bad update pair', async () => {
    const store = dbAssignedTaskStore(() => db)
    await expect(store.insert(task({ assigneeId: assigner }))).rejects.toThrow()
    await expect(store.insert(task({ title: '  ' }))).rejects.toThrow()
    await expect(store.insert(task({ assigneeUpdateAt: null }))).rejects.toThrow()
  })
})
