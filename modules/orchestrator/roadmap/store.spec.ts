import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { InMemoryRoadmapStore, MemoryRoadmapStore, type RoadmapStore } from './store'

/**
 * Shared behaviour suite for every RoadmapStore implementation: the in-memory
 * fake (unit tests) and the Memory-backed store (the Roadmap project's tasks
 * in a real test database, each store on a fresh throwaway user's Memory).
 */
function storeBehavior(name: string, makeStore: () => RoadmapStore) {
  describe(name, () => {
    it('create stores the item with defaults (detail empty, status planned, kind feature)', async () => {
      const store = makeStore()
      const item = await store.create({ title: 'One-command deploy' })

      expect(item.title).toBe('One-command deploy')
      expect(item.detail).toBe('')
      expect(item.status).toBe('planned')
      expect(item.kind).toBe('feature')
      expect(item.position).toBe(0)
      expect(item.shippedAt).toBeNull()
      expect(item.id).toBeTruthy()
      expect(item.createdAt).toBeTruthy()
      expect(item.updatedAt).toBeTruthy()
    })

    it('create accepts explicit status, kind, detail, and position', async () => {
      const store = makeStore()
      const item = await store.create({
        title: 'Live journey verification',
        detail: 'e2e against a disposable database.',
        status: 'in_progress',
        kind: 'chore',
        position: 3,
      })

      expect(item.status).toBe('in_progress')
      expect(item.kind).toBe('chore')
      expect(item.detail).toBe('e2e against a disposable database.')
      expect(item.position).toBe(3)
      expect(item.shippedAt).toBeNull()
    })

    it('create stamps shipped_at when an item is born shipped', async () => {
      const store = makeStore()
      const item = await store.create({ title: 'Done already', status: 'shipped' })

      expect(item.status).toBe('shipped')
      expect(item.shippedAt).toBeTruthy()
    })

    it('list orders by status (shipped, in_progress, planned) then position', async () => {
      const store = makeStore()
      await store.create({ title: 'planned b', position: 1 })
      await store.create({ title: 'shipped b', status: 'shipped', position: 5 })
      await store.create({ title: 'in progress', status: 'in_progress' })
      await store.create({ title: 'planned a', position: 0 })
      await store.create({ title: 'shipped a', status: 'shipped', position: 0 })

      expect((await store.list()).map((item) => item.title)).toEqual([
        'shipped a',
        'shipped b',
        'in progress',
        'planned a',
        'planned b',
      ])
    })

    it('update patches fields and bumps updatedAt', async () => {
      const store = makeStore()
      const before = await store.create({ title: 'One-command deploy' })

      const after = await store.update(before.id, {
        title: 'One-command deploy v2',
        detail: 'curl-to-VPS.',
        kind: 'chore',
        position: 4,
      })

      expect(after.title).toBe('One-command deploy v2')
      expect(after.detail).toBe('curl-to-VPS.')
      expect(after.kind).toBe('chore')
      expect(after.position).toBe(4)
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(before.updatedAt).getTime(),
      )
    })

    it('update allows partial patches', async () => {
      const store = makeStore()
      const created = await store.create({ title: 'A', detail: 'keep me', kind: 'fix' })

      const after = await store.update(created.id, { title: 'B' })

      expect(after.title).toBe('B')
      expect(after.detail).toBe('keep me')
      expect(after.kind).toBe('fix')
    })

    it('moving status to shipped stamps shipped_at; moving away clears it', async () => {
      const store = makeStore()
      const created = await store.create({ title: 'A' })
      expect(created.shippedAt).toBeNull()

      const shipped = await store.update(created.id, { status: 'shipped' })
      expect(shipped.shippedAt).toBeTruthy()

      const backToPlanned = await store.update(created.id, { status: 'planned' })
      expect(backToPlanned.shippedAt).toBeNull()
      expect(backToPlanned.status).toBe('planned')
    })

    it('patching without status leaves shipped_at untouched', async () => {
      const store = makeStore()
      const created = await store.create({ title: 'A' })
      const shipped = await store.update(created.id, { status: 'shipped' })

      const retitled = await store.update(created.id, { title: 'A2' })
      expect(retitled.shippedAt).toBe(shipped.shippedAt)
      expect(retitled.title).toBe('A2')
    })

    it('update throws loud for an unknown id', async () => {
      const store = makeStore()

      await expect(store.update('nope', { title: 'x' })).rejects.toThrow(
        /unknown roadmap item: nope/,
      )
    })
  })
}

storeBehavior('InMemoryRoadmapStore', () => new InMemoryRoadmapStore())

const DATABASE_URL = process.env.DATABASE_URL?.trim()

/** Throwaway users (Memory owners) created by the Memory-backed suite; deleted after. */
const createdUsers: string[] = []
let _operator: postgres.Sql | null = null
const operator = () => (_operator ??= postgres(DATABASE_URL!, { max: 1, prepare: false }))

async function createUser(prefix: string): Promise<string> {
  const id = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  await operator()`
    insert into "user" (id, name, email, email_verified, onboarding_completed)
    values (${id}, ${prefix}, ${`${id}@test.local`}, true, true)`
  createdUsers.push(id)
  return id
}

describe.skipIf(!DATABASE_URL)('MemoryRoadmapStore (test database)', () => {
  afterAll(async () => {
    for (const id of createdUsers) await operator()`delete from "user" where id = ${id}`
    await _operator?.end()
    const { closeAppDbPool } = await import('$lib/server/db')
    await closeAppDbPool()
  })

  function makeStore(): MemoryRoadmapStore {
    let userId: Promise<string> | null = null
    return new MemoryRoadmapStore({
      ownerId: () => (userId ??= createUser('roadmap_store')),
      withUserDb: async (id, fn) => {
        const { withDbUser } = await import('$lib/server/db')
        return withDbUser(id, fn)
      },
    })
  }

  storeBehavior('behaviour', makeStore)

  it('items are tasks of the Roadmap system project in that Memory', async () => {
    const store = makeStore()
    const item = await store.create({
      title: 'Invoice reminders',
      detail: 'A week early.',
      kind: 'fix',
    })
    await store.update(item.id, { status: 'in_progress' })
    const projectId = await store.projectId()

    const [project] = await operator()`
      select label, system_key, project_status, project_source, entity_type
      from canonical_entity where id = ${projectId}`
    expect(project).toEqual({
      label: 'Roadmap',
      system_key: 'roadmap',
      project_status: 'active',
      project_source: 'manual',
      entity_type: 'project',
    })
    const [task] = await operator()`
      select t.category, t.lifecycle_status, t.task_kind, t.task_started_at is not null as started,
        t.normalized_text_encrypted is not null as encrypted, t.enrich_queue_status, te.source
      from thought t join thought_entity te on te.thought_id = t.id and te.entity_id = ${projectId}
      where t.id = ${item.id}`
    expect(task).toEqual({
      category: 'task',
      lifecycle_status: 'open',
      task_kind: 'fix',
      started: true,
      encrypted: true,
      enrich_queue_status: null,
      source: 'manual',
    })
  })

  it('the project is created once (idempotent), and an archived task leaves the roadmap', async () => {
    const store = makeStore()
    const first = await store.projectId()
    expect(await store.projectId()).toBe(first)
    const item = await store.create({ title: 'Archive me' })
    await operator()`update thought set lifecycle_status = 'archived' where id = ${item.id}`
    expect(await store.list()).toEqual([])
    await expect(store.update(item.id, { title: 'x' })).rejects.toThrow(/unknown roadmap item/)
  })

  it('a task edited in Memory keeps its other metadata when the roadmap rewrites it', async () => {
    const store = makeStore()
    const item = await store.create({ title: 'Keep metadata', detail: 'one' })
    const after = await store.update(item.id, { detail: 'two', title: 'Kept metadata' })
    expect(after).toMatchObject({ title: 'Kept metadata', detail: 'two' })
  })
})

/**
 * The migration copy (drizzle/0120 → roadmap_ensure_project): run inside one
 * transaction that is rolled back, so the test database keeps its state.
 */
describe.skipIf(!DATABASE_URL)('roadmap_ensure_project — legacy rows into Memory', () => {
  const ROLLBACK = new Error('rollback')
  const ids = {
    planned: '7a0e0000-0000-4000-8000-000000000001',
    started: '7a0e0000-0000-4000-8000-000000000002',
    shipped: '7a0e0000-0000-4000-8000-000000000003',
  }

  async function inRolledBackTx(fn: (tx: postgres.TransactionSql) => Promise<void>) {
    const sql = postgres(DATABASE_URL!, { max: 1, prepare: false })
    try {
      await sql.begin(async (tx) => {
        await fn(tx)
        throw ROLLBACK
      })
    } catch (err) {
      if (err !== ROLLBACK) throw err
    } finally {
      await sql.end()
    }
  }

  async function seedLegacy(tx: postgres.TransactionSql) {
    await tx`
      CREATE TABLE IF NOT EXISTS "extension_roadmap_items" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "title" text NOT NULL, "detail" text DEFAULT '' NOT NULL,
        "status" text DEFAULT 'planned' NOT NULL, "kind" text DEFAULT 'feature' NOT NULL,
        "position" integer DEFAULT 0 NOT NULL, "shipped_at" timestamp with time zone,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL)`
    await tx`
      insert into extension_roadmap_items (id, title, detail, status, kind, position, shipped_at, updated_at)
      values
        (${ids.planned}, 'Company templates', 'One click.', 'planned', 'feature', 3, null, '2026-10-20T10:00:00Z'),
        (${ids.started}, 'Live journey verification', '', 'in_progress', 'chore', 0, null, '2026-10-21T10:00:00Z'),
        (${ids.shipped}, 'Founding journey', 'Chat compiles the website.', 'shipped', 'fix', 4, '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')`
  }

  async function makeOwner(tx: postgres.TransactionSql, id: string) {
    await tx`update "user" set role = 'admin' where role = 'owner'`
    await tx`
      insert into "user" (id, name, email, email_verified, onboarding_completed, role)
      values (${id}, 'Owner', ${`${id}@test.local`}, true, true, 'owner')`
  }

  it("copies every legacy row into the owner's Roadmap project, then drops the table", async () => {
    await inRolledBackTx(async (tx) => {
      await seedLegacy(tx)
      const legacyCount = Number(
        (await tx`select count(*) as n from extension_roadmap_items`)[0]!.n,
      )
      const owner = `roadmap_owner_${Date.now().toString(36)}`
      await makeOwner(tx, owner)

      const [{ id: projectId }] = (await tx`select roadmap_ensure_project(${owner}) as id`) as [
        { id: string },
      ]
      expect((await tx`select to_regclass('public.extension_roadmap_items') as t`)[0]!.t).toBeNull()

      const [project] = await tx`
        select label, system_key, project_status from canonical_entity where id = ${projectId}`
      expect(project).toEqual({ label: 'Roadmap', system_key: 'roadmap', project_status: 'active' })

      const tasks = await tx`
        select t.id, t.normalized_text, t.metadata->>'detail' as detail, t.category,
          t.lifecycle_status, t.lifecycle_completed_at::text as completed_at, t.task_kind, t.task_position,
          t.task_started_at is not null as started
        from thought t join thought_entity te on te.thought_id = t.id
        where te.entity_id = ${projectId} and t.user_id = ${owner}`
      expect(tasks).toHaveLength(legacyCount)
      const byId = new Map(tasks.map((t) => [t.id as string, t]))
      expect(byId.get(ids.planned)).toMatchObject({
        normalized_text: 'Company templates',
        detail: 'One click.',
        category: 'task',
        lifecycle_status: 'open',
        completed_at: null,
        task_kind: 'feature',
        task_position: 3,
        started: false,
      })
      expect(byId.get(ids.started)).toMatchObject({
        lifecycle_status: 'open',
        task_kind: 'chore',
        started: true,
      })
      const shipped = byId.get(ids.shipped)!
      expect(shipped).toMatchObject({
        lifecycle_status: 'completed',
        task_kind: 'fix',
        task_position: 4,
      })
      expect(shipped.completed_at).toBe('2026-10-15 00:00:00')

      // Idempotent: a second call finds the same project and nothing to copy.
      const [{ id: again }] = (await tx`select roadmap_ensure_project(${owner}) as id`) as [
        { id: string },
      ]
      expect(again).toBe(projectId)
    })
  })

  it('a non-owner gets a Roadmap project but never adopts the legacy rows', async () => {
    await inRolledBackTx(async (tx) => {
      await seedLegacy(tx)
      const member = `roadmap_member_${Date.now().toString(36)}`
      await tx`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${member}, 'Member', ${`${member}@test.local`}, true, true, 'member')`
      const [{ id }] = (await tx`select roadmap_ensure_project(${member}) as id`) as [
        { id: string },
      ]
      expect(id).toBeTruthy()
      expect((await tx`select to_regclass('public.extension_roadmap_items') as t`)[0]!.t).toBe(
        'extension_roadmap_items',
      )
      const linked = await tx`select 1 from thought_entity where entity_id = ${id}`
      expect(linked).toHaveLength(0)
    })
  })

  it("an app session can't ensure another user's project", async () => {
    await inRolledBackTx(async (tx) => {
      const owner = `roadmap_owner_${Date.now().toString(36)}`
      await makeOwner(tx, owner)
      await tx`select set_config('app.current_user_id', 'someone-else', true)`
      await expect(tx`select roadmap_ensure_project(${owner})`).rejects.toThrow(
        /cannot ensure the project/,
      )
    })
  })
})
