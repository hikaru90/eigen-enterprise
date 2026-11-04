import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryRoadmapStore } from '../../../../modules/orchestrator/roadmap/store'

/**
 * The Roadmap is a system project (P-4): it can't be dismissed or deleted by
 * accident — not through dismiss, entity delete, or "delete all memories".
 * Runs against the test database on a throwaway user's Memory.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

describe.skipIf(!DATABASE_URL)('system projects are protected', () => {
  const userId = `sysproj_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')
  const store = new MemoryRoadmapStore({
    ownerId: async () => userId,
    withUserDb: async (id, fn) => db.withDbUser(id, fn),
  })

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    await operator`
      insert into "user" (id, name, email, email_verified, onboarding_completed)
      values (${userId}, 'System projects', ${`${userId}@test.local`}, true, true)`
  })

  afterAll(async () => {
    await operator`delete from "user" where id = ${userId}`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('dismissing the Roadmap fails loud', async () => {
    const projectId = await store.projectId()
    const { dismissProject } = await import('$lib/server/memory/project-list')
    const { SystemProjectError } = await import('$lib/server/memory/system-projects')
    await expect(db.withDbUser(userId, () => dismissProject(userId, projectId))).rejects.toThrow(
      SystemProjectError,
    )
    const [row] =
      await operator`select project_status from canonical_entity where id = ${projectId}`
    expect(row?.project_status).toBe('active')
  })

  it('deleting the Roadmap entity is refused', async () => {
    const projectId = await store.projectId()
    const { deleteCanonicalEntityForUser } =
      await import('$lib/server/memory/canonical-entity-admin')
    const result = await db.withDbUser(userId, () =>
      deleteCanonicalEntityForUser(userId, projectId),
    )
    expect(result).toEqual({ ok: false, reason: 'system_project' })
  })

  it('personal task lists leave the Roadmap tasks to the board', async () => {
    const item = await store.create({ title: 'Board only' })
    const { listTemporalEventsForUser } = await import('$lib/server/memory/temporal-event-list')
    const { items } = await db.withDbUser(userId, () =>
      listTemporalEventsForUser({ userId, status: 'all', includeTasks: true, range: 'all' }),
    )
    expect(items.map((i) => i.thoughtId)).not.toContain(item.id)
  })

  it('"delete all memories" keeps the Roadmap and its tasks, deletes the rest', async () => {
    await store.create({ title: 'Survives a memory wipe' })
    const [personal] = await operator`
      insert into thought (user_id, raw_text, normalized_text, category)
      values (${userId}, 'a personal note', 'a personal note', 'task') returning id`
    const { deleteAllMemoriesForUser } = await import('$lib/server/memory/delete-all-memories')
    await db.withDbUser(userId, () => deleteAllMemoriesForUser(userId))

    expect((await store.list()).map((i) => i.title).sort()).toEqual([
      'Board only',
      'Survives a memory wipe',
    ])
    const gone = await operator`select 1 from thought where id = ${personal!.id}`
    expect(gone).toHaveLength(0)
  })
})
