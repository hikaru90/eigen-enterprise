import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Memory › Tasks › Add a task (Contribute e7bdd452): the person says what they
 * typed is a task, so it is captured as one — category 'task' from the start,
 * marked categorySource 'person' so enrichment keeps it — and shows up in the
 * Tasks list right away. Real test DB with the app's RLS role.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

// Enrichment (LLM) is not what this is about; the queued row is.
vi.mock('$lib/server/capture/capture-enrich-worker', () => ({
  scheduleCaptureEnrichWorker: () => {},
}))

describe.skipIf(!DATABASE_URL)('capturing with a category the person chose', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const member = `pcat_member_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    await operator`
      insert into "user" (id, name, email, email_verified, onboarding_completed, role)
      values (${member}, 'member', ${`${member}@test.local`}, true, true, 'member')`
  })

  afterAll(async () => {
    await operator`delete from "user" where id = ${member}`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('a task added from Tasks is a task at once and is listed there', async () => {
    const { captureThought } = await import('$lib/server/capture/service')
    const { loadUnifiedTimeline } = await import('$lib/server/memory/timeline-unified')
    const { decryptTenantValue } = await import('$lib/server/crypto/tenant-encryption')

    const { saved, timeline, metadataEncrypted } = await db.withDbUser(member, async () => {
      const saved = await captureThought(member, 'Renew the passport', {
        source: 'ui',
        category: 'task',
      })
      const timeline = await loadUnifiedTimeline({
        userId: member,
        orderBy: 'ingest',
        sortDirection: 'desc',
        author: 'user',
        from: null,
        to: null,
        includeUndated: true,
      })
      const [row] = await operator`
        select metadata_encrypted from thought where id = ${saved.id}`
      return { saved, timeline, metadataEncrypted: row.metadata_encrypted as string }
    })

    const [row] = await operator`
      select t.category, k.key as kind_key
      from thought t join ontology_entity_kind k on k.id = t.ontology_entity_kind_id
      where t.id = ${saved.id}`
    expect(row).toEqual({ category: 'task', kind_key: 'task' })
    const metadata = JSON.parse(
      await db.withDbUser(member, () =>
        decryptTenantValue({
          userId: member,
          table: 'thought',
          column: 'metadata',
          ciphertext: metadataEncrypted,
        }),
      ),
    ) as Record<string, unknown>
    expect(metadata.categorySource).toBe('person')
    expect(timeline.items.some((item) => item.thoughtId === saved.id)).toBe(true)
  })

  it('a category the person’s Memory does not have is refused, nothing saved', async () => {
    const { captureThought } = await import('$lib/server/capture/service')
    await expect(
      db.withDbUser(member, () =>
        captureThought(member, 'Something', { source: 'ui', category: 'person' }),
      ),
    ).rejects.toThrow(/not a thought category/i)
    const [count] = await operator`
      select count(*)::int as n from thought where user_id = ${member}`
    expect(count).toEqual({ n: 1 })
  })
})
