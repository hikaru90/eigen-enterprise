import type { ContactRow } from './store'
import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbContactsStore } from './db-store'

/**
 * Who sees a contact, decided by the store's query against real Postgres
 * (migration 0150, Contribute 9d28020a): the whole team means every member
 * now and later (a person who joins after the share sees it), a group share
 * follows the group's membership at read time, a person share is that person,
 * and private stays private. Needs DATABASE_URL with migrations applied;
 * skipped without it. Users and groups are per-run so parallel runs never meet.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('contacts sharing (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const run = `share-spec-${randomUUID()}`
  const ana = `${run}-ana`
  const ben = `${run}-ben`
  const cleo = `${run}-cleo`
  const late = `${run}-late`
  const sales = `${run}-sales`
  const scope = (userId: string) => ({ kind: 'person' as const, userId })

  async function addUser(id: string): Promise<void> {
    await sql`insert into "user" (id, name, email) values (${id}, ${id}, ${`${id}@example.test`})`
  }

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
    for (const id of [ana, ben, cleo]) await addUser(id)
    await sql`insert into member_group (id, name, created_by) values (${sales}, ${sales}, ${ana})`
    await sql`insert into member_group_member (group_id, user_id) values (${sales}, ${ben})`
  })

  afterAll(async () => {
    await sql`delete from contacts where created_by like ${`${run}%`}`
    await sql`delete from member_group where id = ${sales}`
    await sql`delete from "user" where id like ${`${run}%`}`
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
      stage: 'inbox',
      ownerId: null,
      via: null,
      latestStatus: null,
      waitingSince: null,
      createdBy: ana,
      createdByKind: 'user',
      shared: false,
      createdAt: at,
      updatedAt: at,
      ...over,
    }
  }

  it('whole team: a member who joins after the share sees it; private stays private', async () => {
    const store = dbContactsStore(db)
    const team = row({ name: 'Team One' })
    const secret = row({ name: 'Secret One' })
    await store.insert(team)
    await store.insert(secret)
    await store.applySharing([team.id], { kind: 'share', team: true, userIds: [], groupIds: [] }, ana, new Date())

    await addUser(late) // joins the company after the share
    const seenBy = async (userId: string) => (await store.list(scope(userId), { ids: [team.id, secret.id] })).map((r) => r.name)
    expect(await seenBy(late)).toEqual(['Team One'])
    expect(await seenBy(ben)).toEqual(['Team One'])
    expect(await seenBy(ana)).toEqual(['Secret One', 'Team One'])
    // Nothing was copied per member: the share is one flag on the contact.
    expect(await store.shares([team.id])).toEqual([])
    expect((await store.get(team.id))?.shared).toBe(true)
  })

  it('a person share is that person; a group share follows the group as it is when read', async () => {
    const store = dbContactsStore(db)
    const forCleo = row({ name: 'For Cleo' })
    const forSales = row({ name: 'For Sales' })
    await store.insert(forCleo)
    await store.insert(forSales)
    const at = new Date()
    await store.applySharing([forCleo.id], { kind: 'share', team: false, userIds: [cleo], groupIds: [] }, ana, at)
    await store.applySharing([forSales.id], { kind: 'share', team: false, userIds: [], groupIds: [sales] }, ana, at)
    // Sharing again with the same person is kept as it was (no duplicate, no error).
    await store.applySharing([forCleo.id], { kind: 'share', team: false, userIds: [cleo], groupIds: [] }, ana, at)

    const ids = [forCleo.id, forSales.id]
    const seenBy = async (userId: string) => (await store.list(scope(userId), { ids })).map((r) => r.name)
    expect(await seenBy(cleo)).toEqual(['For Cleo'])
    expect(await seenBy(ben)).toEqual(['For Sales'])
    const shares = await store.shares(ids)
    expect(shares).toHaveLength(2)
    expect(shares).toEqual(
      expect.arrayContaining([
        { contactId: forCleo.id, kind: 'user', subjectId: cleo },
        { contactId: forSales.id, kind: 'group', subjectId: sales },
      ]),
    )

    // Cleo joins Sales later: she sees the group's contact without any new share.
    await sql`insert into member_group_member (group_id, user_id) values (${sales}, ${cleo})`
    expect(await seenBy(cleo)).toEqual(['For Cleo', 'For Sales'])
    // Ben leaves Sales: he no longer sees it.
    await sql`delete from member_group_member where group_id = ${sales} and user_id = ${ben}`
    expect(await seenBy(ben)).toEqual([])
    // tags and follow-ups use the same scope.
    await store.update(forSales.id, {
      tags: ['partner'],
      nextFollowUpOn: '2026-11-20',
      updatedAt: new Date(),
    })
    expect(await store.tags(scope(cleo))).toContain('partner')
    expect((await store.followUps(scope(cleo), '2026-12-01')).map((r) => r.id)).toContain(forSales.id)
  })

  it('make private drops the whole-team flag and every person and group share, for all of them together', async () => {
    const store = dbContactsStore(db)
    const a = row({ name: 'A' })
    const b = row({ name: 'B' })
    await store.insert(a)
    await store.insert(b)
    await store.applySharing([a.id, b.id], { kind: 'share', team: true, userIds: [cleo], groupIds: [sales] }, ana, new Date())
    expect(await store.shares([a.id, b.id])).toHaveLength(4)
    await store.applySharing([a.id, b.id], { kind: 'private' }, ana, new Date())
    expect(await store.shares([a.id, b.id])).toEqual([])
    expect((await store.list(scope(cleo), { ids: [a.id, b.id] })).map((r) => r.name)).toEqual([])
    expect((await store.get(a.id))?.shared).toBe(false)
    // One unknown id: nothing changes (all or none).
    await expect(
      store.applySharing([a.id, randomUUID()], { kind: 'share', team: true, userIds: [], groupIds: [] }, ana, new Date()),
    ).rejects.toThrow(/not found/)
    expect((await store.get(a.id))?.shared).toBe(false)
  })

  it('a removed member loses their shares (cascade)', async () => {
    const store = dbContactsStore(db)
    const gone = `${run}-gone`
    await addUser(gone)
    const c = row({ name: 'For Gone' })
    await store.insert(c)
    await store.applySharing([c.id], { kind: 'share', team: false, userIds: [gone], groupIds: [] }, ana, new Date())
    await sql`delete from "user" where id = ${gone}`
    expect(await store.shares([c.id])).toEqual([])
  })

  it('keeps the person and company defaults for new contacts', async () => {
    const store = dbContactsStore(db)
    const before = await store.defaults(ana)
    expect(before.person).toBeNull()
    await store.setPersonDefault(ana, 'team')
    expect((await store.defaults(ana)).person).toBe('team')
    await store.setPersonDefault(ana, 'private')
    expect((await store.defaults(ana)).person).toBe('private')
    await store.setPersonDefault(ana, null)
    expect((await store.defaults(ana)).person).toBeNull()
    expect((await store.defaults(null)).person).toBeNull()
    // The company default is one row; restored so other specs on this DB see what was there.
    try {
      await store.setCompanyDefault('team', ana)
      expect((await store.defaults(ben)).company).toBe('team')
      await store.setCompanyDefault(null, ana)
      expect((await store.defaults(ben)).company).toBeNull()
    } finally {
      await store.setCompanyDefault(before.company, ana)
    }
    await expect(sql`insert into contact_preferences (user_id, default_visibility) values (${ana}, 'everyone')`).rejects.toThrow()
  })
})
