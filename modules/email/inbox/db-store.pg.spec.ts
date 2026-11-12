import type { AddressRow, AttachmentRow, MailboxRow } from './store'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbInboxStore } from './db-store'
import { message } from './test-fixtures'

/**
 * The DB store against real Postgres (the test DB, :5433). Needs DATABASE_URL
 * with migrations applied (0129, 0131); skipped without it. Each run makes its own
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

  const attachment = (messageId: string, partIndex: number): AttachmentRow => ({
    id: randomUUID(),
    messageId,
    partIndex,
    filename: `f${partIndex}.pdf`,
    contentType: 'application/pdf',
    sizeBytes: 10 + partIndex,
    contentId: partIndex === 1 ? 'logo@s' : null,
    checksum: `md5-${partIndex}`,
    blocked: partIndex === 1,
    createdAt: new Date(),
  })

  it('stores received mail with attachments once per mailbox, notifying the mailbox on commit', async () => {
    const store = dbInboxStore(db)
    const m = (await store.personalMailboxOf(ana))!
    const heard: string[] = []
    const listener = await sql.listen('inbox_messages', (payload) => heard.push(payload))
    try {
      const row = { ...message(m.id, { id: randomUUID(), threadId: randomUUID() }), sesMessageId: `r-${run}` }
      expect(await store.insertReceived(row, [attachment(row.id, 1), attachment(row.id, 0)])).toEqual({ stored: true })
      const retry = { ...row, id: randomUUID() }
      expect(await store.insertReceived(retry, [attachment(retry.id, 0)])).toEqual({ stored: false })
      expect(await store.getMessage(retry.id)).toBeNull()
      expect(await store.listAttachments(retry.id)).toEqual([])
      const parts = await store.listAttachments(row.id)
      expect(parts.map((a) => [a.partIndex, a.contentId, a.blocked, a.checksum])).toEqual([
        [0, null, false, 'md5-0'],
        [1, 'logo@s', true, 'md5-1'],
      ])

      // A broken attachment rolls the message back too.
      const bad = { ...message(m.id, { id: randomUUID(), threadId: randomUUID() }), sesMessageId: `bad-${run}` }
      await expect(store.insertReceived(bad, [attachment(bad.id, 0), attachment(bad.id, 0)])).rejects.toThrow()
      expect(await store.getMessage(bad.id)).toBeNull()

      for (let i = 0; i < 50 && heard.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
      expect(heard).toEqual([m.id])
    } finally {
      await listener.unlisten()
    }
  })

  it('finds a thread by RFC Message-ID within one mailbox only, earliest first', async () => {
    const store = dbInboxStore(db)
    const m = (await store.personalMailboxOf(ana))!
    const other = box({ kind: 'shared', ownerUserId: null, groupId: `g-${run}` })
    await store.insertMailbox(other, addr(other.id, `shared-${run}`))
    const [tOld, tNew, tOther] = [randomUUID(), randomUUID(), randomUUID()]
    await store.insertMessage(message(m.id, { id: randomUUID(), sesMessageId: `t1-${run}`, messageId: `one-${run}@s`, threadId: tOld, receivedAt: new Date('2026-11-01') }))
    await store.insertMessage(message(m.id, { id: randomUUID(), sesMessageId: `t2-${run}`, messageId: `two-${run}@s`, threadId: tNew, receivedAt: new Date('2026-11-02') }))
    await store.insertMessage(message(other.id, { id: randomUUID(), sesMessageId: `t3-${run}`, messageId: `three-${run}@s`, threadId: tOther }))
    expect(await store.threadOf(m.id, [`two-${run}@s`, `one-${run}@s`])).toBe(tOld)
    expect(await store.threadOf(m.id, [`two-${run}@s`])).toBe(tNew)
    expect(await store.threadOf(m.id, [`three-${run}@s`])).toBeNull()
    expect(await store.threadOf(m.id, [])).toBeNull()
  })

  it('looks up exact addresses to their mailbox in the order asked', async () => {
    const store = dbInboxStore(db)
    const m = (await store.personalMailboxOf(ana))!
    await store.insertAddress(addr(m.id, `alias-${run}`, false))
    const out = await store.mailboxesFor([`alias-${run}@${domain}`, `nobody@${domain}`, `ana.lind@${domain}`])
    expect(out.map((x) => [x.address, x.mailbox.id])).toEqual([
      [`alias-${run}@${domain}`, m.id],
      [`ana.lind@${domain}`, m.id],
    ])
    expect(await store.mailboxesFor([])).toEqual([])
  })

  it('disables a mailbox', async () => {
    const store = dbInboxStore(db)
    const m = (await store.personalMailboxOf(ana))!
    const at = new Date('2026-11-12T10:00:00Z')
    await store.updateMailbox(m.id, { disabledAt: at, updatedAt: at })
    expect((await store.getMailbox(m.id))?.disabledAt?.toISOString()).toBe(at.toISOString())
  })
})
