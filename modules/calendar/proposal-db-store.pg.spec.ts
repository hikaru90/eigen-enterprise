import type { ProposalRow } from './proposal-store'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbProposalStore } from './proposal-db-store'

/**
 * The proposals table against real Postgres (the test DB, :5433; migration
 * 0140). Skipped without DATABASE_URL. Its own mailbox (shared, so no user
 * row is needed for the FK) and mails per run.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('calendar proposals store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const run = randomUUID()
  const member = `pg-spec-${run}-ana`
  const mailboxId = randomUUID()
  const mails = [randomUUID(), randomUUID(), randomUUID()]

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
    await sql`insert into mailboxes (id, kind, group_id, created_by) values (${mailboxId}, 'shared', ${`g-${run}`}, 'pg-spec')`
    for (const id of mails) {
      await sql`insert into inbox_messages (id, mailbox_id, folder, thread_id, "from", subject, snippet, received_at, size_bytes)
                values (${id}, ${mailboxId}, 'inbox', ${randomUUID()}, ${JSON.stringify({ name: null, address: 'mara@sender.example' })}::jsonb, 'Call?', '', now(), 10)`
    }
  })

  afterAll(async () => {
    await sql`delete from mailboxes where id = ${mailboxId}`
    await sql.end()
  })

  const row = (messageId: string, over: Partial<ProposalRow> = {}): ProposalRow => ({
    id: randomUUID(),
    memberId: member,
    mailboxId,
    messageId,
    state: 'open',
    title: 'Call with Mara',
    startsAt: new Date('2026-11-19T14:00:00Z'),
    endsAt: new Date('2026-11-19T14:30:00Z'),
    timeZone: 'Europe/Berlin',
    location: null,
    call: 'https://meet.example/abc',
    attendees: [{ email: 'mara@sender.example', name: 'Mara Voss' }],
    eventId: null,
    createdAt: new Date('2026-11-12T09:00:00Z'),
    decidedAt: null,
    ...over,
  })

  it('round-trips a proposal; one per mail', async () => {
    const store = dbProposalStore(db)
    const p = row(mails[0]!)
    expect(await store.insert(p)).toBe(true)
    expect(await store.insert(row(mails[0]!))).toBe(false)
    expect(await store.get(p.id)).toEqual(p)
    expect(await store.forMessage(mails[0]!)).toEqual(p)
    expect(await store.get(randomUUID())).toBeNull()
  })

  it('lists a member’s open ones soonest first; decide claims once; reopen undoes it', async () => {
    const store = dbProposalStore(db)
    const later = row(mails[1]!, { startsAt: new Date('2026-11-25T14:00:00Z'), endsAt: new Date('2026-11-25T15:00:00Z') })
    const sooner = row(mails[2]!, { startsAt: new Date('2026-11-13T14:00:00Z'), endsAt: new Date('2026-11-13T15:00:00Z') })
    await store.insert(later)
    await store.insert(sooner)
    expect((await store.open(member)).map((p) => p.messageId)).toEqual([mails[2], mails[0], mails[1]])
    const at = new Date('2026-11-12T10:00:00Z')
    expect(await store.decide(sooner.id, 'accepted', at)).toBe(true)
    expect(await store.decide(sooner.id, 'dismissed', at)).toBe(false)
    expect(await store.get(sooner.id)).toMatchObject({ state: 'accepted', decidedAt: at })
    await store.reopen(sooner.id)
    expect(await store.get(sooner.id)).toMatchObject({ state: 'open', decidedAt: null, eventId: null })
    expect(await store.decide(later.id, 'dismissed', at)).toBe(true)
    expect((await store.open(member)).map((p) => p.messageId)).toEqual([mails[2], mails[0]])
  })

  it('the table refuses an open proposal with a decision time, a bad state or an empty span', async () => {
    const store = dbProposalStore(db)
    const extra = randomUUID()
    await sql`insert into inbox_messages (id, mailbox_id, folder, thread_id, "from", subject, snippet, received_at, size_bytes)
              values (${extra}, ${mailboxId}, 'inbox', ${randomUUID()}, ${JSON.stringify({ name: null, address: 'x@y.example' })}::jsonb, 's', '', now(), 1)`
    await expect(store.insert(row(extra, { decidedAt: new Date() }))).rejects.toThrow()
    await expect(store.insert(row(extra, { state: 'maybe' as never }))).rejects.toThrow()
    await expect(store.insert(row(extra, { endsAt: new Date('2026-11-19T14:00:00Z') }))).rejects.toThrow()
  })

  it('deleting the mail deletes its proposal', async () => {
    const store = dbProposalStore(db)
    await sql`delete from inbox_messages where id = ${mails[1]!}`
    expect(await store.forMessage(mails[1]!)).toBeNull()
  })
})
