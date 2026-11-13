import type { ContactRow, LogEntryRow } from './store'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbContactsStore } from './db-store'

/**
 * The DB store against real Postgres (the test DB, :5433). Needs DATABASE_URL
 * with migrations applied (0124, 0139); skipped without it. Rows are tagged with a
 * per-run creator id so parallel runs never see each other's contacts.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('contacts store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const run = `pg-spec-${randomUUID()}`
  const other = `${run}-other`
  const mine = { kind: 'person' as const, userId: run }

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    await sql`delete from contacts where created_by in (${run}, ${other})`
    await sql.end()
  })

  const row = (over: Partial<ContactRow> = {}): ContactRow => {
    const at = new Date()
    return {
      id: randomUUID(),
      name: 'Mara Voss',
      organisation: null,
      title: null,
      channels: [],
      metHow: null,
      whyRelevant: null,
      tags: [],
      lastContactedOn: null,
      nextFollowUpOn: null,
      nextStep: null,
      createdBy: run,
      createdByKind: 'user',
      shared: false,
      createdAt: at,
      updatedAt: at,
      ...over,
    }
  }

  it('round-trips every field (channels as JSON, tags as text[], days as YYYY-MM-DD)', async () => {
    const store = dbContactsStore(db)
    const r = row({
      organisation: 'Northwind',
      title: 'Partner',
      channels: [
        { type: 'email', value: 'mara@northwind.example' },
        { type: 'linkedin', value: 'https://linkedin.com/in/mara' },
      ],
      metHow: 'Breakfast',
      whyRelevant: 'Seed rounds',
      tags: ['investor', 'seed round'],
      lastContactedOn: '2026-11-01',
      nextFollowUpOn: '2026-11-20',
      nextStep: 'Send the deck',
    })
    await store.insert(r)
    const got = await store.get(r.id)
    expect(got).toEqual({ ...r, createdAt: got!.createdAt, updatedAt: got!.updatedAt })
    expect(await store.get(randomUUID())).toBeNull()
  })

  it('scopes, filters by tag, searches name and organisation literally, and orders by name', async () => {
    const store = dbContactsStore(db)
    const jon = row({ name: 'jon Park', organisation: 'Atelier Print', tags: ['production', 'printing'] })
    const mara = row({ name: 'Mara Voss', organisation: 'Northwind', tags: ['investor'] })
    const zoe = row({ name: 'Zoë 100% Real', tags: ['customer'] })
    const hidden = row({ name: 'Hidden', createdBy: other, tags: ['secret tag'] })
    const shared = row({ name: 'Shared One', createdBy: other, shared: true, tags: ['partner'] })
    for (const r of [mara, zoe, jon, hidden, shared]) await store.insert(r)

    const ids = (rows: ContactRow[]) => rows.map((r) => r.id).filter((id) => [jon, mara, zoe, hidden, shared].some((x) => x.id === id))
    expect(ids(await store.list(mine, {}))).toEqual([jon.id, mara.id, shared.id, zoe.id])
    expect(ids(await store.list({ kind: 'all' }, {}))).toEqual([hidden.id, jon.id, mara.id, shared.id, zoe.id])
    expect(ids(await store.list(mine, { tag: 'investor' }))).toEqual([mara.id])
    expect(ids(await store.list(mine, { query: 'NORTH' }))).toEqual([mara.id])
    expect(ids(await store.list(mine, { query: '100%' }))).toEqual([zoe.id])
    expect(ids(await store.list(mine, { query: '_' }))).toEqual([])
    expect(ids(await store.list(mine, { tag: 'production', query: 'atelier' }))).toEqual([jon.id])

    const tags = await store.tags(mine)
    expect(tags).toEqual(expect.arrayContaining(['customer', 'investor', 'partner', 'printing', 'production']))
    expect(tags).not.toContain('secret tag')
    expect([...tags].sort()).toEqual(tags)
  })

  it('lists follow-ups up to a day, soonest first; updates and deletes', async () => {
    const store = dbContactsStore(db)
    const a = row({ name: 'b later', nextFollowUpOn: '2026-11-20' })
    const b = row({ name: 'A first', nextFollowUpOn: '2026-11-12' })
    const c = row({ name: 'C beyond', nextFollowUpOn: '2026-12-31' })
    const d = row({ name: 'D other', createdBy: other, nextFollowUpOn: '2026-11-13' })
    for (const r of [a, b, c, d]) await store.insert(r)
    const due = (await store.followUps(mine, '2026-11-26')).map((r) => r.id).filter((id) => [a.id, b.id, c.id, d.id].includes(id))
    expect(due).toEqual([b.id, a.id])

    const at = new Date()
    await store.update(a.id, { nextFollowUpOn: null, lastContactedOn: '2026-11-12', shared: true, updatedAt: at })
    expect(await store.get(a.id)).toMatchObject({ nextFollowUpOn: null, lastContactedOn: '2026-11-12', shared: true })
    await expect(store.update(randomUUID(), { name: 'x', updatedAt: at })).rejects.toThrow(/not found/)
    await store.delete(a.id)
    expect(await store.get(a.id)).toBeNull()
  })

  it('the database refuses what the service would: empty names, too many tags', async () => {
    const store = dbContactsStore(db)
    await expect(store.insert(row({ name: '  ' }))).rejects.toThrow()
    await expect(store.insert(row({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }))).rejects.toThrow()
  })

  const entry = (contactId: string, over: Partial<LogEntryRow> = {}): LogEntryRow => ({
    id: randomUUID(),
    contactId,
    on: '2026-11-11',
    note: null,
    answeredFollowUpOn: null,
    answeredStep: null,
    nextFollowUpOn: null,
    nextStep: null,
    loggedBy: run,
    loggedByKind: 'user',
    createdAt: new Date(),
    ...over,
  })

  it('records a log entry with the contact’s patch, lists entries newest day first, and deletes them with the contact', async () => {
    const store = dbContactsStore(db)
    const r = row({ nextFollowUpOn: '2026-11-10', nextStep: 'Send the deck' })
    await store.insert(r)
    const first = entry(r.id, { on: '2026-11-05', note: 'Coffee', answeredFollowUpOn: '2026-11-04', answeredStep: 'Ask', createdAt: new Date('2026-11-12T10:00:00Z') })
    const second = entry(r.id, { on: '2026-11-11', nextFollowUpOn: '2026-11-20', nextStep: 'Call', createdAt: new Date('2026-11-12T09:00:00Z') })
    await store.recordLog(first, { lastContactedOn: '2026-11-05', updatedAt: new Date() })
    await store.recordLog(second, { lastContactedOn: '2026-11-11', nextFollowUpOn: '2026-11-20', nextStep: 'Call', updatedAt: new Date() })
    expect(await store.get(r.id)).toMatchObject({ lastContactedOn: '2026-11-11', nextFollowUpOn: '2026-11-20', nextStep: 'Call' })
    expect(await store.logEntries(r.id)).toEqual([second, first])

    // Neither half lands when the contact is gone.
    await expect(store.recordLog(entry(randomUUID()), { updatedAt: new Date() })).rejects.toThrow(/not found/)
    await store.delete(r.id)
    expect(await store.logEntries(r.id)).toEqual([])
  })

  it('a bad entry leaves the contact unchanged (one transaction)', async () => {
    const store = dbContactsStore(db)
    const r = row()
    await store.insert(r)
    await expect(store.recordLog(entry(r.id, { note: '  ' }), { lastContactedOn: '2026-11-11', updatedAt: new Date() })).rejects.toThrow()
    expect(await store.get(r.id)).toMatchObject({ lastContactedOn: null })
  })

  it('inserts many contacts together, or none when one is refused', async () => {
    const store = dbContactsStore(db)
    const a = row({ name: 'Import A' })
    const b = row({ name: 'Import B' })
    await store.insertMany([a, b])
    expect((await store.get(a.id))?.name).toBe('Import A')
    expect((await store.get(b.id))?.name).toBe('Import B')
    const c = row({ name: 'Import C' })
    await expect(store.insertMany([c, row({ name: ' ' })])).rejects.toThrow()
    expect(await store.get(c.id)).toBeNull()
  })
})
