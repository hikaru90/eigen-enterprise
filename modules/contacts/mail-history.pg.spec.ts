import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { companyMailTo, mailboxMailWith } from './mail-history'

const hrefOf = (m: { mailboxId: string; folder: string; id: string }) => `/inbox?box=${m.mailboxId}&folder=${m.folder}&m=${m.id}`

/**
 * The history's mail queries against real Postgres (the test DB, :5433, with
 * 0129 + 0138 applied); skipped without DATABASE_URL. Access is not decided
 * here — the caller passes the mailboxes Email lets the viewer read — so the
 * test proves the query never leaves those mailboxes, matches addresses in
 * any case in From/To/Cc/Bcc, and leaves Spam and Trash out.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('contact history mail (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const run = randomUUID().slice(0, 8)
  const mara = `mara-${run}@northwind.example`
  const mine = randomUUID()
  const theirs = randomUUID()
  const ids: string[] = []
  const companyIds: string[] = []

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
    for (const id of [mine, theirs]) {
      await sql`insert into mailboxes (id, kind, group_id, created_by) values (${id}, 'shared', ${`g-${run}`}, 'pg-spec')`
    }
  })

  afterAll(async () => {
    await sql`delete from mailboxes where id in (${mine}, ${theirs})`
    if (companyIds.length > 0) await sql`delete from mail_messages where id = any(${companyIds}::uuid[])`
    await sql.end()
  })

  async function mail(mailboxId: string, over: { folder?: string; from?: string; to?: string[]; cc?: string[]; bcc?: string[]; at: string; subject: string }) {
    const id = randomUUID()
    ids.push(id)
    const people = (list: string[] = []) => JSON.stringify(list.map((address) => ({ name: null, address })))
    await sql`insert into inbox_messages (id, mailbox_id, folder, thread_id, "from", "to", cc, bcc, subject, snippet, received_at, size_bytes)
      values (${id}, ${mailboxId}, ${over.folder ?? 'inbox'}, ${randomUUID()}, ${JSON.stringify({ name: 'X', address: over.from ?? 'someone@else.example' })}::jsonb,
              ${people(over.to)}::jsonb, ${people(over.cc)}::jsonb, ${people(over.bcc)}::jsonb, ${over.subject}, ${`about ${over.subject}`}, ${over.at}, 10)`
    return id
  }

  it('finds mail from and to the address (any case, To/Cc/Bcc) in the given mailboxes only, newest first; no Spam, no Trash', async () => {
    const fromHer = await mail(mine, { from: mara.toUpperCase(), to: ['shared@co.example'], at: '2026-11-10T10:00:00Z', subject: 'From her' })
    const toHer = await mail(mine, { folder: 'sent', from: 'shared@co.example', to: ['x@y.example'], cc: [mara], at: '2026-11-11T10:00:00Z', subject: 'To her' })
    const bcc = await mail(mine, { folder: 'archive', from: 'shared@co.example', bcc: [mara], at: '2026-11-09T10:00:00Z', subject: 'Bcc her' })
    await mail(mine, { folder: 'spam', from: mara, at: '2026-11-12T10:00:00Z', subject: 'Spam' })
    await mail(mine, { folder: 'trash', from: mara, at: '2026-11-12T11:00:00Z', subject: 'Trash' })
    await mail(mine, { from: 'other@northwind.example', at: '2026-11-12T12:00:00Z', subject: 'Not her' })
    await mail(theirs, { from: mara, at: '2026-11-12T13:00:00Z', subject: 'Someone else’s mailbox' })

    const found = await mailboxMailWith(db, [{ id: mine, address: 'shared@co.example' }], [mara], hrefOf)
    expect(found.map((m) => [m.id, m.direction, m.subject])).toEqual([
      [toHer, 'sent', 'To her'],
      [fromHer, 'received', 'From her'],
      [bcc, 'received', 'Bcc her'],
    ])
    expect(found[0]).toMatchObject({
      via: { kind: 'mailbox', address: 'shared@co.example' },
      snippet: 'about To her',
      href: `/inbox?box=${mine}&folder=sent&m=${toHer}`,
    })
    expect(await mailboxMailWith(db, [], [mara], hrefOf)).toEqual([])
    expect(await mailboxMailWith(db, [{ id: mine, address: 'shared@co.example' }], [mara], hrefOf, 1)).toHaveLength(1)
  })

  it('finds what the company sent to the address (any case), newest first, without bodies', async () => {
    const [a] = await sql`insert into mail_messages (source, status, from_address, to_address, subject, text, content_stored, created_at)
      values ('template', 'delivered', 'hello@co.example', ${mara.toUpperCase()}, 'Welcome', 'secret body', true, '2026-11-01T10:00:00Z') returning id`
    const [b] = await sql`insert into mail_messages (source, status, from_address, to_address, subject, content_stored, created_at)
      values ('flow', 'queued', 'hello@co.example', ${mara}, 'Next', false, '2026-11-02T10:00:00Z') returning id`
    const [c] = await sql`insert into mail_messages (source, status, from_address, to_address, subject, content_stored)
      values ('flow', 'queued', 'hello@co.example', ${`other-${run}@x.example`}, 'Other', false) returning id`
    companyIds.push(a!.id, b!.id, c!.id)

    const found = await companyMailTo(db, [mara])
    expect(found).toEqual([
      { id: b!.id, direction: 'sent', via: { kind: 'company', status: 'queued' }, subject: 'Next', snippet: null, at: new Date('2026-11-02T10:00:00Z'), href: `/m/email/logs/${b!.id}` },
      { id: a!.id, direction: 'sent', via: { kind: 'company', status: 'delivered' }, subject: 'Welcome', snippet: null, at: new Date('2026-11-01T10:00:00Z'), href: `/m/email/logs/${a!.id}` },
    ])
  })
})
