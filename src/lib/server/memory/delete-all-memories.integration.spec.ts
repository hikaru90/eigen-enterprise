import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * "Delete everything in my Memory" (Memory → Settings): every thought, task,
 * note, capture, project, summary and graph vertex the person put in goes —
 * plus what Memory learned about them in check-ins and the webhook copies of
 * their thoughts. Their chats with the assistant, their AI usage log and their
 * API keys are not Memory and stay. Runs against the test database.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

describe.skipIf(!DATABASE_URL)('delete everything in my Memory', () => {
  const userId = `delall_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    await operator`
      insert into "user" (id, name, email, email_verified, onboarding_completed)
      values (${userId}, 'Delete all', ${`${userId}@test.local`}, true, true)`
  })

  afterAll(async () => {
    await operator`delete from "user" where id = ${userId}`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('removes thoughts, captures, notes, check-in answers, webhook copies and summaries; keeps chats, usage log and keys', async () => {
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const captured = await db.withDbUser(userId, () =>
      queueCapture(userId, 'A worry I never want to see again', { skipWorker: true }),
    )
    await operator`
      insert into text_file (user_id, title, body_text, lexical_text)
      values (${userId}, 'Private note', 'my private note', 'my private note')`
    await operator`
      insert into user_grounding_profile (user_id, narrative_summary_encrypted, facets, session_count)
      values (${userId}, 'ciphertext', ${operator.json({ role: 'Founder' })}, 3)`
    const [agent] = await operator`
      insert into connected_agent (user_id, name, webhook_url, signing_secret_encrypted,
        signing_secret_prefix, callback_token_hash, callback_token_prefix, enabled)
      values (${userId}, 'Agent', 'https://agent.test/hook', 'x', 'x', 'x', 'x', false)
      returning id`
    await operator`
      insert into webhook_delivery (user_id, agent_id, event_type, event_id, payload, status)
      values (${userId}, ${agent!.id}, 'thought.created', ${captured.thoughtId},
        ${operator.json({ data: { normalizedText: 'A worry' } })}, 'delivered')`
    const [community] = await operator`
      insert into graph_community (user_id, level) values (${userId}, 1) returning id`
    await operator`
      insert into community_summary (user_id, community_id, level, summary_text)
      values (${userId}, ${community!.id}, 1, 'Worries')`
    const [chat] = await operator`
      insert into chat_session (user_id, title) values (${userId}, 'Chat') returning id`
    await operator`
      insert into chat_message (session_id, user_id, role, content)
      values (${chat!.id}, ${userId}, 'user', 'hello')`
    await operator`
      insert into activity_call_log (user_id, provider, operation, base_cost_usd, markup_usd, total_cost_usd)
      values (${userId}, 'openrouter', 'llm.embedding.success(attempt=1)', '0', '0', '0')`
    await operator`
      insert into user_api_key (user_id, name, key_prefix, key_hash)
      values (${userId}, 'My key', 'eigen_ab', ${`hash_${userId}`})`

    const { deleteAllMemoriesForUser } = await import('./delete-all-memories')
    const result = await db.withDbUser(userId, () => deleteAllMemoriesForUser(userId))
    expect(result).toEqual({ thoughtsDeleted: 1, entitiesDeleted: 0, notesDeleted: 1 })

    expect(await operator`select 1 from thought where user_id = ${userId}`).toHaveLength(0)
    expect(await operator`select 1 from capture_session where user_id = ${userId}`).toHaveLength(0)
    expect(await operator`select 1 from text_file where user_id = ${userId}`).toHaveLength(0)
    expect(await operator`select 1 from graph_community where user_id = ${userId}`).toHaveLength(0)
    expect(await operator`select 1 from community_summary where user_id = ${userId}`).toHaveLength(
      0,
    )
    expect(await operator`select 1 from webhook_delivery where user_id = ${userId}`).toHaveLength(0)
    const [profile] = await operator`
      select narrative_summary_encrypted, facets, pending_check_in, session_count
      from user_grounding_profile where user_id = ${userId}`
    expect(profile).toMatchObject({
      narrative_summary_encrypted: null,
      facets: {},
      pending_check_in: null,
    })

    expect(await operator`select 1 from chat_message where user_id = ${userId}`).toHaveLength(1)
    expect(
      await operator`select 1 from activity_call_log where user_id = ${userId}
        and operation = 'llm.embedding.success(attempt=1)'`,
    ).toHaveLength(1)
    expect(await operator`select 1 from user_api_key where user_id = ${userId}`).toHaveLength(1)
  })
})
