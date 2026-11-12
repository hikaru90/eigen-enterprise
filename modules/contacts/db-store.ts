import type { ContactFilter, ContactRow, ContactScope, ContactsStore } from './store'
import { and, asc, eq, ilike, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { contacts } from '$lib/server/db/contacts.schema'
import type { AppDatabase } from '$lib/server/db/context'
import { rowsFromDbExecute } from '$lib/server/db/execute-rows'
import { CHANNEL_TYPES } from './types'

/** ContactsStore over Postgres (company-level table, migration 0124). */

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

function scoped(scope: ContactScope): SQL | undefined {
  return scope.kind === 'all' ? undefined : or(eq(contacts.createdBy, scope.userId), eq(contacts.shared, true))
}

function filtered(filter: ContactFilter): SQL[] {
  const out: SQL[] = []
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
  }
}
