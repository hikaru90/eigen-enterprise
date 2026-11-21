import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'
import { createMemoryTools } from '../../../../modules/memory/tools'
import { ORCHESTRATOR_AGENT_ID } from '../../../../modules/orchestrator/brain'

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
    // Notes are shared by default (plan/shared-memory-voice-agent-tools.md §1); this one is Private.
    await operator`
      insert into text_file (user_id, title, body_text, lexical_text, visibility)
      values (${member}, 'Private note', 'my private note', 'my private note', 'private')`
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${member}, ${owner}, ${admin})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('no other account — another member, an admin, the owner — can read their thoughts or a Private note, even asking by id', async () => {
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

  /**
   * The kernel path the brain's tool calls take (CB3): the registry with the
   * live row-level-security scope — no request context around it, exactly
   * like a Telegram turn or a background run.
   */
  const registry = new KernelRegistry({ principalScope: livePrincipalScope })
  for (const tool of createMemoryTools()) registry.register(tool)
  /** The company brain acting as this member (their id and kernel roles, via the brain). */
  const brainFor = (id: string, roles = ['member']): ToolContext => ({
    principal: delegatedPrincipal({ id, roles }, ORCHESTRATOR_AGENT_ID),
    requestId: `r-${id}`,
  })
  /** An agent principal that is no person (an API key of no member). */
  const bareAgent: ToolContext = { principal: { id: ORCHESTRATOR_AGENT_ID, kind: 'agent', roles: ['agent'] }, requestId: 'r-agent' }
  const outcomeOf = (run: Promise<unknown>) =>
    run.then(
      (value) => JSON.stringify(value),
      (err: unknown) => `error: ${err instanceof Error ? err.message : String(err)}`,
    )

  it('the company brain acting as a member finds that member’s own thought via memory.retrieve_thoughts', async () => {
    const outcome = await outcomeOf(
      registry.execute('memory.retrieve_thoughts', { order: 'created_at', detail: 'full' }, brainFor(member)),
    )
    expect(outcome).toContain(thoughtId)
  })

  it('acting as another member it cannot find it — not even inside the first member’s DB session', async () => {
    for (const other of [owner, admin]) {
      const roles = other === admin ? ['admin', 'member'] : ['member']
      const outside = await outcomeOf(
        registry.execute('memory.retrieve_thoughts', { order: 'created_at', detail: 'full' }, brainFor(other, roles)),
      )
      // A surrounding session of someone else is never borrowed: the call opens the other's own.
      const inside = await outcomeOf(
        db.withDbUser(member, () =>
          registry.execute('memory.retrieve_thoughts', { order: 'created_at', detail: 'full' }, brainFor(other, roles)),
        ),
      )
      for (const outcome of [outside, inside]) {
        expect(outcome).not.toMatch(/^error/)
        expect(outcome).not.toContain(thoughtId)
        expect(outcome).not.toContain('private worry')
      }
    }
  })

  it('an agent principal that is no person reads nothing of anyone’s Memory', async () => {
    const outcome = await outcomeOf(
      db.withDbUser(member, () => registry.execute('memory.retrieve_thoughts', { order: 'created_at' }, bareAgent)),
    )
    expect(outcome).not.toContain(thoughtId)
    expect(outcome).not.toContain('private worry')
  })

  const asAssistant = brainFor(member)

  it('the brain saves a thought into the Memory of the person it acts as — never as itself, no request needed', async () => {
    // Production 2026-11-17: this seeded ontology kinds for user_id 'orchestrator' and failed.
    // No surrounding DB session (a Telegram turn): the registry opens the member's.
    const saved = (await registry.execute('memory.capture_thought', { raw: 'Call the plumber on Friday' }, asAssistant)) as {
      thoughtId: string
      status: string
    }
    expect(saved).toEqual({ thoughtId: expect.any(String), status: 'queued' })
    const [row] = await operator`
      select user_id, author, capture_source from thought where id = ${saved.thoughtId}`
    expect(row).toEqual({ user_id: member, author: 'user', capture_source: 'agent' })
    const [asItself] = await operator`
      select
        (select count(*) from ontology_entity_kind where user_id = ${ORCHESTRATOR_AGENT_ID})::int as kinds,
        (select count(*) from thought where user_id = ${ORCHESTRATOR_AGENT_ID})::int as thoughts`
    expect(asItself).toEqual({ kinds: 0, thoughts: 0 })
  })

  it('an agent principal working for no one: its Memory writes fail loud and save nothing', async () => {
    for (const [name, input] of [
      ['memory.capture_thought', { raw: 'orphan thought' }],
      ['memory.create_text_file', { title: 'Orphan note', body: 'nobody asked' }],
    ] as const) {
      await expect(registry.execute(name, input, bareAgent)).rejects.toMatchObject({
        name: 'KernelError',
        code: 'permission_denied',
        message: expect.stringMatching(/works for no one/i),
      })
    }
    const [none] = await operator`
      select (select count(*) from text_file where user_id = ${ORCHESTRATOR_AGENT_ID})::int as notes`
    expect(none).toEqual({ notes: 0 })
  })

  it('the assistant writes notes into the person’s Memory, marked as its own, and changes only those', async () => {
    const created = (await registry.execute(
      'memory.create_text_file',
      { title: 'Packing list', body: 'passport' },
      asAssistant,
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

    const updated = (await registry.execute(
      'memory.update_text_file',
      { text_file_id: created.textFileId, title: 'Packing list (Rome)' },
      asAssistant,
    )) as { textFileId: string; title: string }
    expect(updated).toMatchObject({ textFileId: created.textFileId, title: 'Packing list (Rome)' })
    // What it hands back never carries the note's text.
    expect(JSON.stringify(updated)).not.toContain('passport')

    const [own] = await operator`
      select id from text_file where user_id = ${member} and author = 'user' limit 1`
    await expect(
      registry.execute('memory.update_text_file', { text_file_id: own.id, body: 'overwritten' }, asAssistant),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    const [kept] = await operator`select title from text_file where id = ${own.id}`
    expect(kept).toEqual({ title: 'Private note' })
  })
})
