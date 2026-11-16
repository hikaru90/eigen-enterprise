import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Thoughts written before the enrich queue existed carry no queue status and were
 * never enriched. No queue path ever looked at them, so the capture page spun on
 * "Indexing in background" forever (production, 2026-11-16). Queue sync must
 * hand them to the worker; rows that did get enriched stay untouched.
 * Runs against the test database.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`

describe.skipIf(!DATABASE_URL)('thoughts the enrich queue never saw', () => {
  const userId = uid('unqueued')
  const otherId = uid('unqueued_other')
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')

  async function strandedThought(owner: string, text: string, enriched: boolean): Promise<string> {
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const queued = await db.withDbUser(owner, () =>
      queueCapture(owner, text, { skipWorker: true, source: 'api' }),
    )
    await operator`
      update thought
      set enrich_queue_status = null,
          enriched_at = ${enriched ? new Date() : null}
      where id = ${queued.thoughtId}`
    return queued.thoughtId
  }

  async function statusOf(id: string): Promise<string | null> {
    const [row] = await operator`select enrich_queue_status from thought where id = ${id}`
    return (row?.enrich_queue_status as string | null) ?? null
  }

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const id of [userId, otherId]) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed)
        values (${id}, 'Unqueued thoughts', ${`${id}@test.local`}, true, true)`
    }
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${userId}, ${otherId})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('queue sync puts never-enriched, unqueued thoughts back in the queue — only for this tenant', async () => {
    const stranded = await strandedThought(userId, 'Ship the onboarding checklist', false)
    const legacyEnriched = await strandedThought(userId, 'Old enriched note', true)
    const otherTenant = await strandedThought(otherId, 'Someone else entirely', false)

    const { syncCaptureEnrichQueue } = await import('$lib/server/capture/sync-capture-enrich-queue')
    const result = await db.withDbUser(userId, () => syncCaptureEnrichQueue(userId))

    expect(result.requeuedUnqueued).toBe(1)
    expect(result.activeThoughtIds).toContain(stranded)
    expect(await statusOf(stranded)).toBe('pending')
    expect(await statusOf(legacyEnriched)).toBeNull()
    expect(await statusOf(otherTenant)).toBeNull()
  })
})
