import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import type { BrainIntake } from '$lib/memory/brain-intake'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'
import { createMemoryTools } from '../../../../modules/memory/tools'
import { ORCHESTRATOR_AGENT_ID } from '../../../../modules/orchestrator/brain'

/**
 * memory.intake on the test database, as the app's RLS role (Contribute 30a8d920
 * part 2): a person sees what the brain took in from them — their own thoughts,
 * their documents — and the documents colleagues share; never a colleague's
 * thought or private document, in the counts or in the list. The company brain
 * reading for a person sees exactly that person's intake.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

vi.mock('$lib/server/capture/capture-enrich-worker', () => ({
  scheduleCaptureEnrichWorker: () => {},
}))

describe.skipIf(!DATABASE_URL)('memory.intake: what the brain took in, per reader', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const ony = `intake_ony_${tag}`
  const ben = `intake_ben_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')
  let onyThought: string
  let onyTask: string
  let onySharedNote: string
  let onyPrivateNote: string
  let benThought: string
  let benSharedNote: string
  let benPrivateNote: string

  const registry = new KernelRegistry({ principalScope: livePrincipalScope })
  for (const tool of createMemoryTools()) registry.register(tool)
  const asPerson = (id: string): ToolContext => ({
    principal: { id, kind: 'human', roles: ['member'] },
    requestId: `r-${id}`,
  })
  const brainFor = (id: string): ToolContext => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, ORCHESTRATOR_AGENT_ID),
    requestId: `rb-${id}`,
  })
  const intake = (ctx: ToolContext) =>
    registry.execute('memory.intake', { limit: 100 }, ctx) as Promise<BrainIntake>
  const ids = (i: BrainIntake) => i.recent.map((item) => item.id).sort()

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const [id, name] of [
      [ony, 'Ony'],
      [ben, 'Ben'],
    ] as const) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, ${name}, ${`${id}@test.local`}, true, true, 'member')`
    }
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const { createTextFile } = await import('$lib/server/text-files/service')
    await db.withDbUser(ony, async () => {
      onyThought = (
        await queueCapture(ony, 'Acme renews in March', { skipWorker: true, source: 'ui' })
      ).thoughtId
      onyTask = (
        await queueCapture(ony, 'Send Acme the offer', {
          skipWorker: true,
          source: 'agent',
          category: 'task',
        })
      ).thoughtId
      onySharedNote = (
        await createTextFile(ony, { title: 'Call recap Acme', body: 'They want blue' })
      ).id
      onyPrivateNote = (
        await createTextFile(ony, {
          title: 'Salary notes',
          body: 'my number',
          visibility: 'private',
        })
      ).id
    })
    await db.withDbUser(ben, async () => {
      benThought = (
        await queueCapture(ben, 'Ben worries about churn', { skipWorker: true, source: 'ui' })
      ).thoughtId
      benSharedNote = (await createTextFile(ben, { title: 'Pricing page', body: 'Three tiers' })).id
      benPrivateNote = (
        await createTextFile(ben, {
          title: 'Ben private',
          body: 'only mine',
          visibility: 'private',
        })
      ).id
    })
    // Ony's task was done long ago: it still counts (stored), but outside the recent windows.
    await operator`
      update thought set created_at = now() - interval '40 days', lifecycle_status = 'completed'
      where id = ${onyTask}`
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${ony}, ${ben})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('a person sees their own thoughts and documents and colleagues’ shared documents, nothing else', async () => {
    const seen = await intake(asPerson(ony))
    expect(ids(seen)).toEqual(
      [onyThought, onyTask, onySharedNote, onyPrivateNote, benSharedNote].sort(),
    )
    expect(ids(seen)).not.toContain(benThought)
    expect(ids(seen)).not.toContain(benPrivateNote)
    expect(seen.totals).toEqual({ day: 4, week: 4, month: 4, all: 5 })
    const counts = Object.fromEntries(seen.bySource.map((s) => [s.source.kind, s.counts.all]))
    expect(counts).toEqual({ app_input: 1, assistant: 1, own_document: 2, shared_document: 1 })
    const shared = seen.recent.find((item) => item.id === benSharedNote)!
    expect(shared).toMatchObject({ kind: 'document', title: 'Pricing page', sharedBy: 'Ben' })
    const thought = seen.recent.find((item) => item.id === onyThought)!
    expect(thought).toMatchObject({
      kind: 'thought',
      title: 'Acme renews in March',
      source: { kind: 'app_input' },
    })
  })

  it('the colleague sees only their own and the shared documents — none of Ony’s thoughts or private note', async () => {
    const seen = await intake(asPerson(ben))
    expect(ids(seen)).toEqual([benThought, benSharedNote, benPrivateNote, onySharedNote].sort())
    expect(seen.totals.all).toBe(4)
  })

  it('the company brain reading for a person sees that person’s intake', async () => {
    expect(ids(await intake(brainFor(ben)))).toEqual(ids(await intake(asPerson(ben))))
  })
})
