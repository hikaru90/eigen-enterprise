import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMemoryTools } from '../../../../modules/memory/tools'
import { ORCHESTRATOR_PRINCIPAL } from '../../../../modules/orchestrator/brain'

/**
 * Pins the access facts the Memory page's "Who can see your Memory" note
 * states (src/routes/(nucleus)/m/memory/memory-privacy-note.svelte). If one
 * of these starts failing, the note is no longer true: change the note with
 * the code. Runs against the test database with the app's RLS role.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

describe.skipIf(!DATABASE_URL)('who can read a person’s Memory', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const member = `memacc_member_${tag}`
  const owner = `memacc_owner_${tag}`
  const admin = `memacc_admin_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')
  let thoughtId: string

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const [id, role] of [
      [member, 'member'],
      [owner, 'member'],
      [admin, 'admin'],
    ] as const) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, ${role}, ${`${id}@test.local`}, true, true, ${role})`
    }
    // The test DB may already hold a company owner; the role column is what RLS would ignore.
    await operator`update "user" set role = 'owner' where id = ${owner}
      and not exists (select 1 from "user" where role = 'owner' and id <> ${owner})`
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    thoughtId = (
      await db.withDbUser(member, () =>
        queueCapture(member, 'A private worry about my manager', { skipWorker: true }),
      )
    ).thoughtId
    await operator`
      insert into text_file (user_id, title, body_text, lexical_text)
      values (${member}, 'Private note', 'my private note', 'my private note')`
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${member}, ${owner}, ${admin})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('no other account — another member, an admin, the owner — can read it, even asking by id', async () => {
    for (const reader of [owner, admin]) {
      const rows = await db.withDbUser(reader, (scoped) =>
        scoped.execute(
          sql`select
            (select count(*) from thought where user_id = ${member})::int as thoughts,
            (select count(*) from capture_session where user_id = ${member})::int as captures,
            (select count(*) from text_file where user_id = ${member})::int as notes`,
        ),
      )
      expect([...rows][0]).toEqual({ thoughts: 0, captures: 0, notes: 0 })
    }
    const own = await db.withDbUser(member, (scoped) =>
      scoped.execute(sql`select count(*)::int as n from thought where id = ${thoughtId}`),
    )
    expect([...own][0]).toEqual({ n: 1 })
  })

  it("the company assistant's memory tools act as the assistant, never as the person", async () => {
    const retrieve = createMemoryTools().find((t) => t.name === 'memory.retrieve_thoughts')!
    // The chat runs the orchestrator inside the person's DB session (handle-agent-chat-post).
    const outcome = await db
      .withDbUser(member, () =>
        retrieve.handler(
          { principal: ORCHESTRATOR_PRINCIPAL, requestId: 'r1' },
          { order: 'created_at' },
        ),
      )
      .then(
        (value) => JSON.stringify(value),
        (err: unknown) => `error: ${err instanceof Error ? err.message : String(err)}`,
      )
    expect(outcome).not.toContain(thoughtId)
    expect(outcome).not.toContain('private worry')
  })
})
