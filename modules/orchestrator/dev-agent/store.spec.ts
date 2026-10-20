import type { DevAgentRunStatus } from './state'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { kernelDevagentRuns } from '$lib/server/db/devagent.schema'
import { InMemoryDevAgentRunStore, type CreateDevAgentRun, type DevAgentRunStore } from './store'

function makeRun(overrides: Partial<CreateDevAgentRun> = {}): CreateDevAgentRun {
  const id = overrides.id ?? randomUUID()
  return {
    id,
    task: `task-${id}`,
    status: 'dispatched',
    branch: `wt/da/${id}`,
    worktreePath: `/repo/../ee-da-${id}`,
    startedAt: new Date().toISOString(),
    ...overrides,
  }
}

async function testStoreContract(make: () => DevAgentRunStore): Promise<string[]> {
  const store = make()
  const createdIds: string[] = []

  const created = await store.create(makeRun())
  createdIds.push(created.id)
  expect(created.status).toBe('dispatched')
  expect(created.finishedAt).toBeNull()
  expect(created.resultSummary).toBeNull()
  expect(created.green).toBeNull()
  expect(created.error).toBeNull()

  expect(await store.get(created.id)).toEqual(created)
  expect(await store.get(randomUUID())).toBeNull()

  const updated = await store.update(created.id, {
    status: 'green',
    finishedAt: new Date().toISOString(),
    green: true,
    resultSummary: 'verification: vitest exit 0, check exit 0',
  })
  expect(updated).toMatchObject({ status: 'green', green: true })
  expect(await store.get(created.id)).toMatchObject({ status: 'green', green: true })

  await store.update(created.id, { status: 'merged', finishedAt: new Date().toISOString() })
  const listed = await store.list()
  expect(listed.some((run) => run.id === created.id)).toBe(true)

  await expect(store.update(randomUUID(), { status: 'failed' })).rejects.toThrow(/unknown dev-agent run/)

  // single-flight gate: active rows are found, terminal rows are not
  const active = await store.create(makeRun({ status: 'running' as DevAgentRunStatus }))
  createdIds.push(active.id)
  expect((await store.findActive())?.id).toBe(active.id)
  await store.update(active.id, { status: 'aborted', finishedAt: new Date().toISOString() })
  expect(await store.findActive()).toBeNull()

  // list is most-recent-first
  const newest = await store.create(makeRun())
  createdIds.push(newest.id)
  const list = await store.list()
  expect(list[0].id).toBe(newest.id)
  return createdIds
}

describe('InMemoryDevAgentRunStore', () => {
  it('satisfies the run store contract', async () => {
    await testStoreContract(() => new InMemoryDevAgentRunStore())
  })

  it('rejects duplicate run ids', async () => {
    const store = new InMemoryDevAgentRunStore()
    const run = makeRun()
    await store.create(run)
    await expect(store.create(run)).rejects.toThrow(/duplicate dev-agent run id/)
  })

  it('finds the newest active run', async () => {
    const store = new InMemoryDevAgentRunStore()
    const older = await store.create(makeRun({ status: 'running' as DevAgentRunStatus }))
    const newer = await store.create(makeRun({ status: 'dispatched' as DevAgentRunStatus }))
    expect((await store.findActive())?.id).toBe(newer.id)
    await store.update(older.id, { status: 'green' })
    expect((await store.findActive())?.id).toBe(newer.id)
  })
})

const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('DbDevAgentRunStore (eigen_test)', () => {
  it('satisfies the run store contract against the real DB', async () => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const db: AppDatabase = createScopedDrizzle(appSql)
    const store = new (await import('./store')).DbDevAgentRunStore(db)
    let createdIds: string[] = []
    try {
      createdIds = await testStoreContract(() => store)
    } finally {
      for (const id of createdIds) {
        await db.delete(kernelDevagentRuns).where(eq(kernelDevagentRuns.id, id))
      }
    }
  })
})
