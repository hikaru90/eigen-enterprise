import { getTableName } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { DbRoadmapStore, InMemoryRoadmapStore, type RoadmapStore } from './store'

/**
 * Shared behaviour suite for every RoadmapStore implementation: in-memory
 * fakes (unit tests) and the drizzle-backed store (fake db handle).
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

/**
 * Sequence-observing fake of the drizzle builder surface used by
 * DbRoadmapStore: selects replay configurable rows, inserts/updates replay a
 * configurable returning row. Dispatches on table name; fails loud on
 * unexpected tables.
 */
function makeFakeDb(options: { selectRows?: () => unknown[]; returningRow?: unknown } = {}) {
  const calls: Array<{
    op: 'insert' | 'select' | 'update'
    table: string
    values?: unknown
    set?: unknown
  }> = []

  function tableName(table: unknown): string {
    const name = getTableName(table as never)
    if (!name) throw new Error('fake db: unknown table')
    return name
  }

  const db = {
    insert(table: unknown) {
      const name = tableName(table)
      return {
        values(values: unknown) {
          calls.push({ op: 'insert', table: name, values })
          return { returning: async () => [options.returningRow ?? {}] }
        },
      }
    },
    select() {
      return {
        from(table: unknown) {
          const name = tableName(table)
          calls.push({ op: 'select', table: name })
          const node = {
            where: () => node,
            orderBy: () => node,
            limit: () => node,
            then: (
              resolve: (rows: unknown[]) => unknown,
              reject: (err: unknown) => unknown,
            ) => Promise.resolve(options.selectRows?.() ?? []).then(resolve, reject),
          }
          return node
        },
      }
    },
    update(table: unknown) {
      const name = tableName(table)
      return {
        set(set: unknown) {
          return {
            where: () => ({
              returning: async () => {
                calls.push({ op: 'update', table: name, set })
                return [options.returningRow ?? {}]
              },
            }),
          }
        },
      }
    },
  }

  return { db: db as unknown as AppDatabase, calls }
}

const dbRow = {
  id: 'row-1',
  title: 'One-command deploy',
  detail: 'curl-to-VPS.',
  status: 'planned',
  kind: 'feature',
  position: 2,
  shippedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
}

describe('DbRoadmapStore', () => {
  it('create inserts with domain values and maps the returned row', async () => {
    const fake = makeFakeDb({ returningRow: dbRow })
    const store = new DbRoadmapStore(fake.db)

    const item = await store.create({ title: 'One-command deploy' })

    expect(item).toMatchObject({
      id: 'row-1',
      title: 'One-command deploy',
      detail: 'curl-to-VPS.',
      status: 'planned',
      kind: 'feature',
      position: 2,
      shippedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    expect(fake.calls.map((c) => c.op)).toEqual(['insert'])
    expect(fake.calls[0]).toMatchObject({ op: 'insert', table: 'extension_roadmap_items' })
    expect(fake.calls[0].values).toMatchObject({
      title: 'One-command deploy',
      detail: '',
      status: 'planned',
      kind: 'feature',
      position: 0,
    })
  })

  it('create born shipped stamps shipped_at on the insert', async () => {
    const fake = makeFakeDb({ returningRow: { ...dbRow, status: 'shipped', shippedAt: new Date('2026-02-01T00:00:00Z') } })
    const store = new DbRoadmapStore(fake.db)

    const item = await store.create({ title: 'Done', status: 'shipped' })

    expect(item.status).toBe('shipped')
    expect(item.shippedAt).toBe('2026-02-01T00:00:00.000Z')
    const values = fake.calls[0].values as { shippedAt: unknown }
    expect(values.shippedAt).toBeInstanceOf(Date)
  })

  it('update throws loud when the id is unknown (empty select)', async () => {
    const fake = makeFakeDb({ selectRows: () => [] })
    const store = new DbRoadmapStore(fake.db)

    await expect(store.update('nope', { title: 'x' })).rejects.toThrow(
      /unknown roadmap item: nope/,
    )
    expect(fake.calls.map((c) => c.op)).toEqual(['select'])
  })

  it('update writes only the provided fields plus updatedAt', async () => {
    const fake = makeFakeDb({ selectRows: () => [dbRow], returningRow: dbRow })
    const store = new DbRoadmapStore(fake.db)

    await store.update('row-1', { title: 'Renamed' })

    expect(fake.calls.at(-1)).toMatchObject({ op: 'update', table: 'extension_roadmap_items' })
    expect(fake.calls.at(-1)?.set).toMatchObject({ title: 'Renamed' })
    const set = fake.calls.at(-1)?.set as Record<string, unknown>
    expect(set.detail).toBeUndefined()
    expect(set.status).toBeUndefined()
    expect(set.shippedAt).toBeUndefined()
    expect(set.updatedAt).toBeInstanceOf(Date)
  })

  it('update stamps shipped_at when status moves to shipped and clears it when it leaves', async () => {
    const fake = makeFakeDb({ selectRows: () => [dbRow], returningRow: dbRow })
    const store = new DbRoadmapStore(fake.db)

    await store.update('row-1', { status: 'shipped' })
    let set = fake.calls.at(-1)?.set as Record<string, unknown>
    expect(set.status).toBe('shipped')
    expect(set.shippedAt).toBeInstanceOf(Date)

    await store.update('row-1', { status: 'planned' })
    set = fake.calls.at(-1)?.set as Record<string, unknown>
    expect(set.status).toBe('planned')
    expect(set.shippedAt).toBeNull()
  })

  it('list selects the roadmap table', async () => {
    const fake = makeFakeDb({ selectRows: () => [dbRow] })
    const store = new DbRoadmapStore(fake.db)

    const items = await store.list()

    expect(items).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ op: 'select', table: 'extension_roadmap_items' })
  })
})
