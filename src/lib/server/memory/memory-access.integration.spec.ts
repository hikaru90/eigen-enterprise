import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryTools } from '../../../../modules/memory/tools'
import { ORCHESTRATOR_PRINCIPAL } from '../../../../modules/orchestrator/brain'

/**
 * Pins the access facts the Memory page's "Who can see your Memory" note
 * states (src/routes/(nucleus)/m/memory/memory-privacy-note.svelte). If one
 * of these starts failing, the note is no longer true: change the note with
 * the code. Runs against the test database with the app's RLS role.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

// Enrichment (LLM) is not what these facts are about; the queued row is.
vi.mock('$lib/server/capture/capture-enrich-worker', () => ({
  scheduleCaptureEnrichWorker: () => {},
}))

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

  const memoryTool = (name: string) => {
    const found = createMemoryTools().find((t) => t.name === name)
    if (!found) throw new Error(`${name} descriptor missing`)
    return found
  }
  const asAssistant = { principal: ORCHESTRATOR_PRINCIPAL, requestId: 'r2' }

  it('the assistant saves a thought into the Memory of the person it works for — never as itself', async () => {
    // Production 2026-11-17: this seeded ontology kinds for user_id 'orchestrator' and failed.
    const saved = (await db.withDbUser(member, () =>
      memoryTool('memory.capture_thought').handler(asAssistant, {
        raw: 'Call the plumber on Friday',
      }),
    )) as { thoughtId: string; status: string }
    expect(saved).toEqual({ thoughtId: expect.any(String), status: 'queued' })
    const [row] = await operator`
      select user_id, author, capture_source from thought where id = ${saved.thoughtId}`
    expect(row).toEqual({ user_id: member, author: 'user', capture_source: 'agent' })
    const [asItself] = await operator`
      select
        (select count(*) from ontology_entity_kind where user_id = ${ORCHESTRATOR_PRINCIPAL.id})::int as kinds,
        (select count(*) from thought where user_id = ${ORCHESTRATOR_PRINCIPAL.id})::int as thoughts`
    expect(asItself).toEqual({ kinds: 0, thoughts: 0 })
  })

  it('working for no one, the assistant’s Memory writes fail loud and save nothing', async () => {
    for (const [name, input] of [
      ['memory.capture_thought', { raw: 'orphan thought' }],
      ['memory.create_text_file', { title: 'Orphan note', body: 'nobody asked' }],
    ] as const) {
      await expect(memoryTool(name).handler(asAssistant, input)).rejects.toMatchObject({
        name: 'KernelError',
        code: 'permission_denied',
        message: expect.stringMatching(/works for no one/i),
      })
    }
    const [none] = await operator`
      select (select count(*) from text_file where user_id = ${ORCHESTRATOR_PRINCIPAL.id})::int as notes`
    expect(none).toEqual({ notes: 0 })
  })

  it('the assistant writes notes into the person’s Memory, marked as its own, and changes only those', async () => {
    const created = (await db.withDbUser(member, () =>
      memoryTool('memory.create_text_file').handler(asAssistant, {
        title: 'Packing list',
        body: 'passport',
      }),
    )) as { textFileId: string; title: string }
    expect(created).toEqual({ textFileId: expect.any(String), title: 'Packing list' })
    const [note] = await operator`
      select user_id, author, author_label, author_key_id from text_file where id = ${created.textFileId}`
    expect(note).toEqual({
      user_id: member,
      author: 'agent',
      author_label: 'Assistant',
      author_key_id: null,
    })

    const updated = (await db.withDbUser(member, () =>
      memoryTool('memory.update_text_file').handler(asAssistant, {
        text_file_id: created.textFileId,
        title: 'Packing list (Rome)',
      }),
    )) as { textFileId: string; title: string }
    expect(updated).toMatchObject({ textFileId: created.textFileId, title: 'Packing list (Rome)' })
    // What it hands back never carries the note's text.
    expect(JSON.stringify(updated)).not.toContain('passport')

    const [own] = await operator`
      select id from text_file where user_id = ${member} and author = 'user' limit 1`
    await expect(
      db.withDbUser(member, () =>
        memoryTool('memory.update_text_file').handler(asAssistant, {
          text_file_id: own.id,
          body: 'overwritten',
        }),
      ),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    const [kept] = await operator`select title from text_file where id = ${own.id}`
    expect(kept).toEqual({ title: 'Private note' })
  })
})
