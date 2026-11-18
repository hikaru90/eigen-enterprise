import type { ContactFilter, ContactRow, ContactScope, ContactsStore, NextUpCache } from './store'
import { and, asc, desc, eq, ilike, inArray, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  contactCompanySettings,
  contactLogEntries,
  contactNextUp,
  contactPreferences,
  contacts,
  contactShares,
} from '$lib/server/db/contacts.schema'
import type { AppDatabase } from '$lib/server/db/context'
import { rowsFromDbExecute } from '$lib/server/db/execute-rows'
import { memberGroupMember } from '$lib/server/db/team.schema'
import { CHANNEL_TYPES } from './types'

/** ContactsStore over Postgres (company-level tables, migrations 0124 + 0139). */

const storedChannels = z.array(z.object({ type: z.enum(CHANNEL_TYPES), value: z.string().min(1) }).strict())

/** A row as read; malformed channels fail loud (only the service writes them). */
function toRow(r: typeof contacts.$inferSelect): ContactRow {
  const channels = storedChannels.safeParse(r.channels)
  if (!channels.success) throw new Error(`contact ${r.id} has malformed channels: ${channels.error.issues[0]?.message}`)
  return { ...r, channels: channels.data }
}

/** ILIKE pattern for a literal substring (%, _ and \ match themselves). */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/**
 * What a person sees, decided in the query itself: their own, the whole
 * team's (contacts.shared — every member, whoever joined when), and the ones
 * shared with them or with a group they are in right now.
 */
function scoped(scope: ContactScope): SQL | undefined {
  if (scope.kind === 'all') return undefined
  const me = scope.userId
  return or(
    eq(contacts.createdBy, me),
    eq(contacts.shared, true),
    sql`exists (select 1 from ${contactShares} where ${contactShares.contactId} = ${contacts.id} and (${contactShares.userId} = ${me} or ${contactShares.groupId} in (select ${memberGroupMember.groupId} from ${memberGroupMember} where ${memberGroupMember.userId} = ${me})))`,
  )
}

function filtered(filter: ContactFilter): SQL[] {
  const out: SQL[] = []
  if (filter.ids !== undefined) out.push(filter.ids.length === 0 ? sql`false` : inArray(contacts.id, [...filter.ids]))
  if (filter.tag !== undefined) out.push(sql`${contacts.tags} @> ARRAY[${filter.tag}]::text[]`)
  if (filter.query !== undefined) {
    const pattern = containsPattern(filter.query)
    out.push(or(ilike(contacts.name, pattern), ilike(contacts.organisation, pattern))!)
  }
  return out
}

const byName = [asc(sql`lower(${contacts.name})`), asc(contacts.id)]

export function dbContactsStore(db: AppDatabase): ContactsStore {
  return {
    async insert(row) {
      await db.insert(contacts).values(row)
    },
    async insertMany(rows) {
      if (rows.length === 0) return
      // One statement: every row or none.
      await db.insert(contacts).values(rows)
    },
    async get(id) {
      const [r] = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1)
      return r ? toRow(r) : null
    },
    async list(scope, filter) {
      const rows = await db
        .select()
        .from(contacts)
        .where(and(scoped(scope), ...filtered(filter)))
        .orderBy(...byName)
      return rows.map(toRow)
    },
    async tags(scope) {
      const where = scoped(scope)
      const result = await db.execute(
        sql`select distinct t.tag from ${contacts}, unnest(${contacts.tags}) as t(tag) ${where ? sql`where ${where}` : sql``} order by t.tag`,
      )
      return rowsFromDbExecute<{ tag: string }>(result).map((r) => r.tag)
    },
    async followUps(scope, until) {
      const rows = await db
        .select()
        .from(contacts)
        .where(and(scoped(scope), isNotNull(contacts.nextFollowUpOn), lte(contacts.nextFollowUpOn, until)))
        .orderBy(asc(contacts.nextFollowUpOn), ...byName)
      return rows.map(toRow)
    },
    async update(id, patch) {
      const out = await db.update(contacts).set(patch).where(eq(contacts.id, id)).returning({ id: contacts.id })
      if (out.length === 0) throw new Error(`contact ${id} not found`)
    },
    async delete(id) {
      await db.delete(contacts).where(eq(contacts.id, id))
    },
    async recordLog(entry, patch) {
      await db.transaction(async (tx) => {
        const out = await tx.update(contacts).set(patch).where(eq(contacts.id, entry.contactId)).returning({ id: contacts.id })
        if (out.length === 0) throw new Error(`contact ${entry.contactId} not found`)
        await tx.insert(contactLogEntries).values(entry)
      })
    },
    async logEntries(contactId) {
      return db
        .select()
        .from(contactLogEntries)
        .where(eq(contactLogEntries.contactId, contactId))
        .orderBy(desc(contactLogEntries.on), desc(contactLogEntries.createdAt), desc(contactLogEntries.id))
    },
    async shares(ids) {
      if (ids.length === 0) return []
      const rows = await db
        .select()
        .from(contactShares)
        .where(inArray(contactShares.contactId, [...ids]))
        .orderBy(asc(contactShares.createdAt))
      return rows.map((r) => ({
        contactId: r.contactId,
        kind: r.subjectKind,
        subjectId: (r.subjectKind === 'user' ? r.userId : r.groupId)!,
      }))
    },
    async applySharing(ids, change, grantedBy, at) {
      if (ids.length === 0) return
      await db.transaction(async (tx) => {
        const touched = await tx
          .update(contacts)
          .set(
            change.kind === 'private'
              ? { shared: false, updatedAt: at }
              : change.team
                ? { shared: true, updatedAt: at }
                : { updatedAt: at },
          )
          .where(inArray(contacts.id, [...ids]))
          .returning({ id: contacts.id })
        if (touched.length !== ids.length) throw new Error('a contact to share was not found')
        if (change.kind === 'private') {
          await tx.delete(contactShares).where(inArray(contactShares.contactId, [...ids]))
          return
        }
        const values = ids.flatMap((contactId) => [
          ...change.userIds.map((userId) => ({
            contactId,
            subjectKind: 'user' as const,
            userId,
            groupId: null,
            grantedBy,
            createdAt: at,
          })),
          ...change.groupIds.map((groupId) => ({
            contactId,
            subjectKind: 'group' as const,
            userId: null,
            groupId,
            grantedBy,
            createdAt: at,
          })),
        ])
        // Already shared with them: kept as it was.
        if (values.length > 0) await tx.insert(contactShares).values(values).onConflictDoNothing()
      })
    },
    async defaults(userId) {
      const [company] = await db.select().from(contactCompanySettings).where(eq(contactCompanySettings.id, true)).limit(1)
      const [person] =
        userId === null ? [] : await db.select().from(contactPreferences).where(eq(contactPreferences.userId, userId)).limit(1)
      return {
        person: person?.defaultVisibility ?? null,
        company: company?.defaultVisibility ?? null,
      }
    },
    async setPersonDefault(userId, visibility) {
      if (visibility === null) {
        await db.delete(contactPreferences).where(eq(contactPreferences.userId, userId))
        return
      }
      await db
        .insert(contactPreferences)
        .values({ userId, defaultVisibility: visibility, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: contactPreferences.userId,
          set: { defaultVisibility: visibility, updatedAt: new Date() },
        })
    },
    async setCompanyDefault(visibility, by) {
      if (visibility === null) {
        await db.delete(contactCompanySettings).where(eq(contactCompanySettings.id, true))
        return
      }
      await db
        .insert(contactCompanySettings)
        .values({ id: true, defaultVisibility: visibility, updatedBy: by, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: contactCompanySettings.id,
          set: { defaultVisibility: visibility, updatedBy: by, updatedAt: new Date() },
        })
    },
  }
}

/** NextUpCache over Postgres (migration 0145): one row per person, replaced on every new pick. */
export function dbNextUpCache(db: AppDatabase): NextUpCache {
  return {
    async get(userId) {
      const [r] = await db.select().from(contactNextUp).where(eq(contactNextUp.userId, userId)).limit(1)
      return r ? { userId: r.userId, day: r.day, generatedAt: r.generatedAt, suggestions: r.suggestions } : null
    },
    async put(entry) {
      await db
        .insert(contactNextUp)
        .values(entry)
        .onConflictDoUpdate({
          target: contactNextUp.userId,
          set: { day: entry.day, generatedAt: entry.generatedAt, suggestions: entry.suggestions },
        })
    },
  }
}
