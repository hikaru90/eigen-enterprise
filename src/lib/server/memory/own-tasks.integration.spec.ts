import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'
import type { OwnTaskView } from '$lib/server/memory/own-tasks'
import { createMemoryTools } from '../../../../modules/memory/tools'
import { ORCHESTRATOR_AGENT_ID } from '../../../../modules/orchestrator/brain'

/**
 * Contribute e9490497 end to end on the test database: the company brain, acting
 * as a member through the registry (live row-level-security scope, no request
 * around it), adds a task to that member's Memory › Tasks, lists it, completes
 * it and deletes it for good — and cannot touch another member's task.
 * Enrichment (LLM) is not what this is about; the queued task row is.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

vi.mock('$lib/server/capture/capture-enrich-worker', () => ({
  scheduleCaptureEnrichWorker: () => {},
}))

describe.skipIf(!DATABASE_URL)('Memory › Tasks through the assistant (memory.*_task)', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const member = `owntask_member_${tag}`
  const other = `owntask_other_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')

  const registry = new KernelRegistry({ principalScope: livePrincipalScope })
  for (const tool of createMemoryTools()) registry.register(tool)
  const brainFor = (id: string): ToolContext => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, ORCHESTRATOR_AGENT_ID),
    requestId: `r-${id}`,
  })

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const id of [member, other]) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, 'member', ${`${id}@test.local`}, true, true, 'member')`
    }
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${member}, ${other})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('adds, lists, completes and deletes the member’s own task; another member’s brain cannot touch it', async () => {
    const created = (await registry.execute('memory.create_task', { title: 'Renew the parking permit' }, brainFor(member))) as {
      task: OwnTaskView
    }
    expect(created.task).toMatchObject({ kind: 'task', status: 'open', title: 'Renew the parking permit', project: null })
    expect(created.task.id).toBe(`task:${created.task.thoughtId}`)
    const [row] = await operator`
      select user_id, category, capture_source from thought where id = ${created.task.thoughtId}`
    expect(row).toEqual({ user_id: member, category: 'task', capture_source: 'agent' })

    const open = (await registry.execute('memory.list_tasks', {}, brainFor(member))) as { tasks: OwnTaskView[] }
    expect(open.tasks.map((t) => t.id)).toContain(created.task.id)

    // Another member's assistant: not theirs, so not found — and nothing changes.
    for (const [name, input] of [
      ['memory.complete_task', { task_id: created.task.id }],
      ['memory.delete_task', { task_id: created.task.id }],
    ] as const) {
      await expect(registry.execute(name, input, brainFor(other))).rejects.toThrow(/not in your Memory/i)
    }
    const theirs = (await registry.execute('memory.list_tasks', { status: 'all' }, brainFor(other))) as { tasks: OwnTaskView[] }
    expect(theirs.tasks).toEqual([])

    const done = (await registry.execute('memory.complete_task', { task_id: created.task.id }, brainFor(member))) as {
      task: OwnTaskView
    }
    expect(done.task.status).toBe('completed')
    const doneList = (await registry.execute('memory.list_tasks', { status: 'done' }, brainFor(member))) as { tasks: OwnTaskView[] }
    expect(doneList.tasks.map((t) => t.id)).toContain(created.task.id)

    expect(await registry.execute('memory.delete_task', { task_id: created.task.id }, brainFor(member))).toEqual({
      deleted: true,
      taskId: created.task.id,
    })
    const [gone] = await operator`select count(*)::int as n from thought where id = ${created.task.thoughtId}`
    expect(gone).toEqual({ n: 0 })
  })
})
