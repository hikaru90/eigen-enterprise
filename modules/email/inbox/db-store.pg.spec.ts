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

    const list = await store.listMessages(m.id, { folder: 'inbox' }, 10)
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

  it('searches a folder literally and case-insensitively over subject, sender and snippet', async () => {
    const store = dbInboxStore(db)
    const m = box({ ownerUserId: ben })
    await store.insertMailbox(m, addr(m.id, `search-${run}`))
    const put = (over: Parameters<typeof message>[1]) => store.insertMessage(message(m.id, { id: randomUUID(), threadId: randomUUID(), ...over }))
    await put({ sesMessageId: `s1-${run}`, subject: 'Quarterly NUMBERS', receivedAt: new Date('2026-11-01') })
    await put({ sesMessageId: `s2-${run}`, subject: 'Lunch', from: { name: 'Jo Berg', address: 'jo@partner.example' }, snippet: 'at 100% noon', receivedAt: new Date('2026-11-02') })
    await put({ sesMessageId: `s3-${run}`, subject: 'No name', from: { name: null, address: 'robot@x.example' }, snippet: 'a_b', receivedAt: new Date('2026-11-03') })
    await put({ sesMessageId: `s4-${run}`, subject: 'quarterly in archive', folder: 'archive' })
    const subjects = async (search?: string) => (await store.listMessages(m.id, { folder: 'inbox', ...(search === undefined ? {} : { search }) }, 10)).map((x) => x.subject)
    expect(await subjects()).toEqual(['No name', 'Lunch', 'Quarterly NUMBERS'])
    expect(await subjects('quarterly')).toEqual(['Quarterly NUMBERS'])
    expect(await subjects('JO BERG')).toEqual(['Lunch'])
    expect(await subjects('partner.example')).toEqual(['Lunch'])
    expect(await subjects('robot@')).toEqual(['No name'])
    expect(await subjects('100%')).toEqual(['Lunch'])
    expect(await subjects('%')).toEqual(['Lunch'])
    expect(await subjects('a_b')).toEqual(['No name'])
    expect(await subjects('_')).toEqual(['No name'])
    expect(await subjects('\\')).toEqual([])
  })

  it('filters, sorts, spans folders for Starred and labels, and keeps labels per mail', async () => {
    const store = dbInboxStore(db)
    const m = box({ kind: 'shared', ownerUserId: null, groupId: `g3-${run}` })
    await store.insertMailbox(m, addr(m.id, `organize-${run}`))
    const put = async (over: Parameters<typeof message>[1]) => {
      const row = message(m.id, { id: randomUUID(), threadId: randomUUID(), sesMessageId: randomUUID(), ...over })
      await store.insertMessage(row)
      return row.id
    }
    const old = await put({ subject: 'old', readAt: new Date('2026-11-02'), receivedAt: new Date('2026-11-01') })
    const mid = await put({ subject: 'mid', starred: true, receivedAt: new Date('2026-11-05') })
    const arch = await put({ subject: 'arch', folder: 'archive', starred: true, receivedAt: new Date('2026-11-03') })
    await put({ subject: 'junk', folder: 'spam', starred: true, receivedAt: new Date('2026-11-04') })
    await sql`insert into inbox_attachments (message_id, part_index, filename, content_type, size_bytes, checksum, blocked)
              values (${mid}, 0, 'a.pdf', 'application/pdf', 10, 'x', false)`
    const subjects = async (q: Parameters<typeof store.listMessages>[1]) => (await store.listMessages(m.id, q, 10)).map((x) => x.subject)
    expect(await subjects({ folder: 'inbox', sort: 'oldest' })).toEqual(['old', 'mid'])
    expect(await subjects({ folder: 'inbox', filter: 'unread' })).toEqual(['mid'])
    expect(await subjects({ folder: 'inbox', filter: 'attachments' })).toEqual(['mid'])
    expect(await subjects({ folder: null, starred: true })).toEqual(['mid', 'arch'])

    const label = { id: randomUUID(), mailboxId: m.id, name: 'Clients', color: 'slate' as const, createdBy: ben, createdAt: new Date() }
    await store.insertLabel(label)
    await expect(store.insertLabel({ ...label, id: randomUUID(), name: 'CLIENTS' })).rejects.toThrow()
    expect((await store.listLabels(m.id)).map((l) => l.name)).toEqual(['Clients'])
    await store.setMessageLabel(old, label.id, true)
    await store.setMessageLabel(old, label.id, true)
    await store.setMessageLabel(arch, label.id, true)
    expect(await subjects({ folder: null, labelId: label.id })).toEqual(['arch', 'old'])
    const listed = await store.listMessages(m.id, { folder: 'inbox' }, 10)
    expect(listed.map((x) => [x.subject, x.labelIds, x.hasAttachments])).toEqual([
      ['mid', [], true],
      ['old', [label.id], false],
    ])
    await store.setMessageLabel(old, label.id, false)
    expect(await subjects({ folder: null, labelId: label.id })).toEqual(['arch'])
    await store.deleteLabel(label.id)
    expect(await store.listLabels(m.id)).toEqual([])
    expect((await store.listMessages(m.id, { folder: 'archive' }, 10))[0]!.labelIds).toEqual([])
  })

  it('counts per folder, lists a thread oldest first, and changes a mail with a notify', async () => {
    const store = dbInboxStore(db)
    const m = box({ kind: 'shared', ownerUserId: null, groupId: `g2-${run}` })
    await store.insertMailbox(m, addr(m.id, `thread-${run}`))
    const thread = randomUUID()
    const first = message(m.id, { id: randomUUID(), threadId: thread, sesMessageId: `th1-${run}`, receivedAt: new Date('2026-11-01') })
    const second = message(m.id, { id: randomUUID(), threadId: thread, sesMessageId: `th2-${run}`, receivedAt: new Date('2026-11-02'), folder: 'spam' })
    await store.insertMessage(second)
    await store.insertMessage(first)
    await store.insertMessage(message(m.id, { id: randomUUID(), threadId: randomUUID(), sesMessageId: `th3-${run}`, readAt: new Date() }))
    expect(Object.fromEntries(await store.folderCounts(m.id))).toEqual({ inbox: { total: 2, unread: 1 }, spam: { total: 1, unread: 1 } })
    expect((await store.threadMessages(m.id, thread)).map((x) => [x.id, x.textBody])).toEqual([
      [first.id, first.textBody],
      [second.id, second.textBody],
    ])

    const heard: string[] = []
    const listener = await sql.listen('inbox_messages', (payload) => heard.push(payload))
    try {
      const readAt = new Date('2026-11-12T11:00:00Z')
      await store.updateMessage(second.id, { folder: 'inbox', readAt, starred: true })
      expect(await store.getMessage(second.id)).toMatchObject({ folder: 'inbox', readAt, starred: true })
      await expect(store.updateMessage(randomUUID(), { starred: true })).rejects.toThrow()
      for (let i = 0; i < 50 && heard.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
      expect(heard).toEqual([m.id])
    } finally {
      await listener.unlisten()
    }
  })

  it('reads one attachment by id', async () => {
    const store = dbInboxStore(db)
    const m = (await store.personalMailboxOf(ana))!
    const row = { ...message(m.id, { id: randomUUID(), threadId: randomUUID() }), sesMessageId: `att-${run}` }
    const a = attachment(row.id, 0)
    await store.insertReceived(row, [a])
    expect(await store.getAttachment(a.id)).toMatchObject({ id: a.id, messageId: row.id, partIndex: 0, checksum: 'md5-0' })
    expect(await store.getAttachment(randomUUID())).toBeNull()
  })

  it('disables a mailbox', async () => {
    const store = dbInboxStore(db)
    const m = (await store.personalMailboxOf(ana))!
    const at = new Date('2026-11-12T10:00:00Z')
    await store.updateMailbox(m.id, { disabledAt: at, updatedAt: at })
    expect((await store.getMailbox(m.id))?.disabledAt?.toISOString()).toBe(at.toISOString())
  })
})
