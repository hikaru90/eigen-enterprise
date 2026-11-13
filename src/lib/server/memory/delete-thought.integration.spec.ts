import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MemoryRoadmapStore } from '../../../../modules/orchestrator/roadmap/store'

/**
 * "Delete" on a thought removes it for good — not an archive — and takes
 * everything derived from it along: the raw capture, its search index and
 * embedding (same row), its dates and reminders, entities only it mentioned,
 * the AI summaries built from it, its AGE graph vertices and the webhook
 * payloads that carried its text. Runs against the test database.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

const uid = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`

describe.skipIf(!DATABASE_URL)('deleting a thought removes it from everything derived', () => {
  const userId = uid('delthought')
  const otherId = uid('delthought_other')
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')

  async function graphIds(): Promise<string[]> {
    const { runTenantScopedCypher } = await import('$lib/server/graph/age-cypher')
    const rows = await db.withDbUser(userId, () =>
      runTenantScopedCypher(
        userId,
        `MATCH (n {user_id: $user_id}) RETURN n.id AS id`,
        { user_id: userId },
        'id agtype',
      ),
    )
    return rows.map((r) => String(r.id))
  }

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const id of [userId, otherId]) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed)
        values (${id}, 'Delete thought', ${`${id}@test.local`}, true, true)`
    }
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${userId}, ${otherId})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('removes the thought, its capture, dates, lone entities, summaries, graph and webhook copies', async () => {
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const { upsertEntityNode, upsertMentionEdge, upsertEventNode } =
      await import('$lib/server/graph/age')

    const doomed = await db.withDbUser(userId, () =>
      queueCapture(userId, 'I am worried about burnout before the funding round', {
        skipWorker: true,
        source: 'ui',
      }),
    )
    const kept = await db.withDbUser(userId, () =>
      queueCapture(userId, 'Lunch with Mara about the funding round', {
        skipWorker: true,
        source: 'ui',
      }),
    )
    const t = doomed.thoughtId
    await operator`update thought set embedding = array_fill(0.1::real, array[1536])::vector
      where id in (${t}, ${kept.thoughtId})`

    // A date + reminder extracted from it.
    const [event] = await operator`
      insert into temporal_event (user_id, thought_id, kind, active_period, time_precision,
        timezone, confidence, semantic_summary, lexical_text)
      values (${userId}, ${t}, 'deadline', tsrange(now()::timestamp, null), 'day', 'UTC', 0.9,
        'burnout check-in', 'burnout check-in') returning id`
    await operator`
      insert into event_reminder_schedule (user_id, temporal_event_id, fire_at, lead_minutes)
      values (${userId}, ${event!.id}, now() + interval '1 day', 15)`

    // "Burnout" is mentioned only here; "Funding round" in both thoughts.
    const [lone] = await operator`
      insert into canonical_entity (user_id, canonical_key, label, entity_type)
      values (${userId}, 'burnout', 'Burnout', 'concept') returning id`
    const [shared] = await operator`
      insert into canonical_entity (user_id, canonical_key, label, entity_type)
      values (${userId}, 'funding round', 'Funding round', 'event') returning id`
    await operator`
      insert into thought_entity (user_id, thought_id, entity_id) values
        (${userId}, ${t}, ${lone!.id}), (${userId}, ${t}, ${shared!.id}),
        (${userId}, ${kept.thoughtId}, ${shared!.id})`

    // AI summary of a community built from the doomed thought, and one that is not.
    const [touched] = await operator`
      insert into graph_community (user_id, level) values (${userId}, 1) returning id`
    const [untouched] = await operator`
      insert into graph_community (user_id, level) values (${userId}, 1) returning id`
    const [mara] = await operator`
      insert into canonical_entity (user_id, canonical_key, label, entity_type)
      values (${userId}, 'mara', 'Mara', 'person') returning id`
    await operator`
      insert into thought_entity (user_id, thought_id, entity_id)
      values (${userId}, ${kept.thoughtId}, ${mara!.id})`
    await operator`
      insert into community_member (user_id, community_id, canonical_entity_id) values
        (${userId}, ${touched!.id}, ${shared!.id}), (${userId}, ${untouched!.id}, ${mara!.id})`
    await operator`
      insert into community_summary (user_id, community_id, level, summary_text) values
        (${userId}, ${touched!.id}, 1, 'Worries about burnout around the funding round'),
        (${userId}, ${untouched!.id}, 1, 'Meetings with Mara')`

    // A webhook delivery that carried the text to a connected agent.
    const [agent] = await operator`
      insert into connected_agent (user_id, name, webhook_url, signing_secret_encrypted,
        signing_secret_prefix, callback_token_hash, callback_token_prefix, enabled)
      values (${userId}, 'Agent', 'https://agent.test/hook', 'x', 'x', 'x', 'x', false)
      returning id`
    await operator`
      insert into webhook_delivery (user_id, agent_id, event_type, event_id, payload, status)
      values
        (${userId}, ${agent!.id}, 'thought.created', ${t},
          ${operator.json({ data: { thoughtId: t, normalizedText: 'burnout' } })}, 'delivered'),
        (${userId}, ${agent!.id}, 'thought.created', ${kept.thoughtId},
          ${operator.json({ data: { thoughtId: kept.thoughtId } })}, 'delivered')`

    // Graph: the entity and event vertices derived from the thought.
    await db.withDbUser(userId, async () => {
      for (const e of [lone!, shared!]) {
        await upsertEntityNode({
          id: e.id,
          userId,
          canonicalKey: 'k',
          label: 'label',
          entityType: 'concept',
        })
        await upsertMentionEdge({ userId, thoughtId: t, entityId: e.id })
      }
      await upsertEventNode({
        id: event!.id,
        userId,
        kind: 'deadline',
        label: 'burnout check-in',
        startAt: new Date().toISOString(),
        endAt: new Date().toISOString(),
      })
    })
    expect(await graphIds()).toEqual(expect.arrayContaining([t, lone!.id, event!.id]))

    const { deleteThoughtForUser } = await import('./delete-thought')
    const result = await db.withDbUser(userId, () => deleteThoughtForUser(userId, t))
    expect(result).toEqual({ ok: true })

    // The row (text, embedding, search index) and the raw capture are gone.
    expect(await operator`select 1 from thought where id = ${t}`).toHaveLength(0)
    expect(
      await operator`select 1 from thought where user_id = ${userId}
        and lexical_tsv @@ to_tsquery('simple', 'burnout')`,
    ).toHaveLength(0)
    expect(
      await operator`select 1 from capture_session where user_id = ${userId}
        and raw_input like '%burnout%'`,
    ).toHaveLength(0)
    // Its dates and reminders.
    expect(await operator`select 1 from temporal_event where thought_id = ${t}`).toHaveLength(0)
    expect(
      await operator`select 1 from event_reminder_schedule where temporal_event_id = ${event!.id}`,
    ).toHaveLength(0)
    // The entity only it mentioned; the shared one stays.
    expect(await operator`select 1 from canonical_entity where id = ${lone!.id}`).toHaveLength(0)
    expect(await operator`select 1 from canonical_entity where id = ${shared!.id}`).toHaveLength(1)
    // AI summaries built from it are dropped (rebuilt from what remains); others stay.
    expect(
      await operator`select 1 from community_summary where community_id = ${touched!.id}`,
    ).toHaveLength(0)
    expect(
      await operator`select 1 from community_summary where community_id = ${untouched!.id}`,
    ).toHaveLength(1)
    // Webhook copies of its text.
    expect(await operator`select 1 from webhook_delivery where event_id = ${t}`).toHaveLength(0)
    expect(
      await operator`select 1 from webhook_delivery where event_id = ${kept.thoughtId}`,
    ).toHaveLength(1)
    // Graph vertices: thought, its event, the lone entity.
    const remaining = await graphIds()
    expect(remaining).not.toContain(t)
    expect(remaining).not.toContain(event!.id)
    expect(remaining).not.toContain(lone!.id)
    expect(remaining).toContain(kept.thoughtId)
    // The other thought is untouched, with its own capture.
    expect(await operator`select 1 from thought where id = ${kept.thoughtId}`).toHaveLength(1)
    expect(
      await operator`select 1 from capture_session where thought_id = ${kept.thoughtId}`,
    ).toHaveLength(1)
  })

  it("can't delete another person's thought", async () => {
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const theirs = await db.withDbUser(otherId, () =>
      queueCapture(otherId, 'Private to the other member', { skipWorker: true }),
    )
    const { deleteThoughtForUser } = await import('./delete-thought')
    const result = await db.withDbUser(userId, () => deleteThoughtForUser(userId, theirs.thoughtId))
    expect(result).toEqual({ ok: false, reason: 'not_found' })
    expect(await operator`select 1 from thought where id = ${theirs.thoughtId}`).toHaveLength(1)
  })

  it('deletes archived thoughts for good on request — Delete used to only archive them', async () => {
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const { setThoughtLifecycleStatus } = await import('./lifecycle')
    const capture = (text: string) =>
      db.withDbUser(userId, () => queueCapture(userId, text, { skipWorker: true }))
    const archived = await capture('Deleted last month, still archived')
    const open = await capture('Still open')
    await db.withDbUser(userId, () =>
      setThoughtLifecycleStatus(userId, archived.thoughtId, 'archived'),
    )

    const { countArchivedThoughts, deleteArchivedThoughtsForUser } =
      await import('./delete-thought')
    expect(await db.withDbUser(userId, () => countArchivedThoughts(userId))).toBe(1)
    expect(await db.withDbUser(userId, () => deleteArchivedThoughtsForUser(userId))).toEqual({
      deleted: 1,
    })
    expect(await operator`select 1 from thought where id = ${archived.thoughtId}`).toHaveLength(0)
    expect(await operator`select 1 from thought where id = ${open.thoughtId}`).toHaveLength(1)
    expect(await db.withDbUser(userId, () => countArchivedThoughts(userId))).toBe(0)
  })

  it("the Tasks tab's trash deletes the thought behind a row for good — task or date", async () => {
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const capture = (text: string) =>
      db.withDbUser(userId, () => queueCapture(userId, text, { skipWorker: true }))
    const task = await capture('Call the therapist back')
    const dated = await capture('Doctor appointment about the lump on Friday')
    const [event] = await operator`
      insert into temporal_event (user_id, thought_id, kind, active_period, time_precision,
        timezone, confidence, semantic_summary, lexical_text)
      values (${userId}, ${dated.thoughtId}, 'appointment', tsrange(now()::timestamp, null), 'day',
        'UTC', 0.9, 'doctor appointment', 'doctor appointment') returning id`
    const { deleteTimelineItemForUser } = await import('./delete-thought')

    expect(
      await db.withDbUser(userId, () =>
        deleteTimelineItemForUser(userId, `task:${task.thoughtId}`),
      ),
    ).toEqual({ ok: true })
    expect(await operator`select 1 from thought where id = ${task.thoughtId}`).toHaveLength(0)

    expect(
      await db.withDbUser(userId, () => deleteTimelineItemForUser(userId, String(event!.id))),
    ).toEqual({ ok: true })
    expect(await operator`select 1 from thought where id = ${dated.thoughtId}`).toHaveLength(0)
    expect(await operator`select 1 from temporal_event where id = ${event!.id}`).toHaveLength(0)
  })

  it("the Tasks tab's trash can't reach another person's date, and unknown rows are not found", async () => {
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const theirs = await db.withDbUser(otherId, () =>
      queueCapture(otherId, 'Their private appointment', { skipWorker: true }),
    )
    const [event] = await operator`
      insert into temporal_event (user_id, thought_id, kind, active_period, time_precision,
        timezone, confidence, semantic_summary, lexical_text)
      values (${otherId}, ${theirs.thoughtId}, 'appointment', tsrange(now()::timestamp, null),
        'day', 'UTC', 0.9, 'their appointment', 'their appointment') returning id`
    const { deleteTimelineItemForUser } = await import('./delete-thought')
    const notFound = { ok: false, reason: 'not_found' }
    expect(
      await db.withDbUser(userId, () => deleteTimelineItemForUser(userId, String(event!.id))),
    ).toEqual(notFound)
    expect(await operator`select 1 from thought where id = ${theirs.thoughtId}`).toHaveLength(1)
    expect(
      await db.withDbUser(userId, () => deleteTimelineItemForUser(userId, 'task:not-a-uuid')),
    ).toEqual(notFound)
    expect(
      await db.withDbUser(userId, () => deleteTimelineItemForUser(userId, 'not-a-uuid')),
    ).toEqual(notFound)
  })

  it('refuses a task of the company Roadmap (it is changed on the board)', async () => {
    const store = new MemoryRoadmapStore({
      ownerId: async () => userId,
      withUserDb: async (id, fn) => db.withDbUser(id, fn),
    })
    const item = await store.create({ title: 'Ship calls' })
    const { deleteThoughtForUser } = await import('./delete-thought')
    const result = await db.withDbUser(userId, () => deleteThoughtForUser(userId, item.id))
    expect(result).toEqual({ ok: false, reason: 'system_project_task', projectLabel: 'Roadmap' })
    expect(await operator`select 1 from thought where id = ${item.id}`).toHaveLength(1)
  })
})
