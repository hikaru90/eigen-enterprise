import type { AddressRow, MailboxRow } from './store'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbInboxStore } from './db-store'
import { message } from './test-fixtures'

/**
 * The DB store against real Postgres (the test DB, :5433). Needs DATABASE_URL
 * with migrations applied (0129); skipped without it. Each run makes its own
 * domain and users, so parallel runs never see each other's rows.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('inbox store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const run = randomUUID().slice(0, 8)
  const domain = `pg-${run}.example`
  const domainId = randomUUID()
  const ana = `pg-ana-${run}`
  const ben = `pg-ben-${run}`

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
    await sql`insert into mail_domains (id, name, region, dkim_selector, public_key, created_by)
              values (${domainId}, ${domain}, 'eu-central-1', 'ee', 'k', 'pg-spec')`
    for (const id of [ana, ben]) {
      await sql`insert into "user" (id, name, email) values (${id}, ${id}, ${`${id}@home.example`})`
    }
  })

  afterAll(async () => {
    await sql`delete from mailboxes where created_by = ${run}`
    await sql`delete from mail_domains where id = ${domainId}`
    await sql`delete from "user" where id in (${ana}, ${ben})`
    await sql.end()
  })

  const box = (over: Partial<MailboxRow> = {}): MailboxRow => ({
    id: randomUUID(),
    kind: 'personal',
    ownerUserId: ana,
    groupId: null,
    displayName: null,
    disabledAt: null,
    createdBy: run,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  })
  const addr = (mailboxId: string, local: string, primary = true): AddressRow => ({
    address: `${local}@${domain}`,
    mailboxId,
    domainId,
    primary,
    createdBy: run,
    createdAt: new Date(),
  })

  it('stores a mailbox with its primary address, aliases, and keeps addresses unique', async () => {
    const store = dbInboxStore(db)
    const m = box()
    await store.insertMailbox(m, addr(m.id, 'ana.lind'))
    await store.insertAddress(addr(m.id, 'ana', false))
    expect(await store.personalMailboxOf(ana)).toMatchObject({ id: m.id, kind: 'personal' })
    expect((await store.listAddresses()).filter((a) => a.mailboxId === m.id).map((a) => [a.address, a.primary])).toEqual([
      [`ana.lind@${domain}`, true],
      [`ana@${domain}`, false],
    ])

    const other = box({ ownerUserId: ben })
    await expect(store.insertMailbox(other, addr(other.id, 'ana'))).rejects.toThrow()
    expect(await store.getMailbox(other.id)).toBeNull() // the mailbox insert rolled back with its address
  })

  it('allows one personal mailbox per member', async () => {
    const store = dbInboxStore(db)
    const again = box()
    await expect(store.insertMailbox(again, addr(again.id, `second-${run}`))).rejects.toThrow()
  })

  it('never deletes a primary address as an alias', async () => {
    const store = dbInboxStore(db)
    await store.deleteAlias(`ana.lind@${domain}`)
    expect(await store.getAddress(`ana.lind@${domain}`)).not.toBeNull()
    await store.deleteAlias(`ana@${domain}`)
    expect(await store.getAddress(`ana@${domain}`)).toBeNull()
  })

  it('stores mail, lists a folder newest first without bodies, and counts per mailbox', async () => {
    const store = dbInboxStore(db)
    const m = (await store.personalMailboxOf(ana))!
    const thread = randomUUID()
    const older = message(m.id, { id: randomUUID(), threadId: thread, receivedAt: new Date('2026-11-10T00:00:00Z'), sesMessageId: `a-${run}` })
    const newer = message(m.id, {
      id: randomUUID(),
      threadId: thread,
      receivedAt: new Date('2026-11-11T00:00:00Z'),
      sesMessageId: `b-${run}`,
      readAt: new Date(),
      sizeBytes: 100,
    })
    await store.insertMessage(older)
    await store.insertMessage(newer)
    await expect(store.insertMessage({ ...older, id: randomUUID() })).rejects.toThrow() // same SES message, same mailbox

    const list = await store.listMessages(m.id, 'inbox', 10)
    expect(list.map((x) => x.id)).toEqual([newer.id, older.id])
    expect(list[0]).not.toHaveProperty('textBody')
    expect(await store.getMessage(older.id)).toMatchObject({ textBody: 'Hi Ana, how are you?', from: older.from, verdicts: older.verdicts })
    expect((await store.stats()).get(m.id)).toEqual({ messages: 2, unread: 1, sizeBytes: 2148 })
  })

  it('disables a mailbox', async () => {
    const store = dbInboxStore(db)
    const m = (await store.personalMailboxOf(ana))!
    const at = new Date('2026-11-12T10:00:00Z')
    await store.updateMailbox(m.id, { disabledAt: at, updatedAt: at })
    expect((await store.getMailbox(m.id))?.disabledAt?.toISOString()).toBe(at.toISOString())
  })
})
