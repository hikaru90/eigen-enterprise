import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * "Your Brain knows N decisions" (assistant page): the count is the thoughts
 * the LLM classified into the `decision` thought category of the person's
 * ontology — never a keyword guess — that are still known (not archived), in
 * the person's own Memory only. Runs against the test database with the app's
 * RLS role, so another account counts none of them, whatever its role.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

describe.skipIf(!DATABASE_URL)('countKnownDecisions', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const member = `kdec_member_${tag}`
  const other = `kdec_other_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')
  let countKnownDecisions: typeof import('./known-decisions').countKnownDecisions

  beforeAll(async () => {
    db = await import('$lib/server/db')
    ;({ countKnownDecisions } = await import('./known-decisions'))
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const id of [member, other]) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, 'member', ${`${id}@test.local`}, true, true, 'member')`
      for (const key of ['decision', 'idea']) {
        await operator`
          insert into ontology_entity_kind (user_id, key, name, definition, kind_type)
          values (${id}, ${key}, ${key}, ${key}, 'thought_category')`
      }
    }
    const thought = (userId: string, category: string, lifecycle: string) => operator`
      insert into thought (user_id, raw_text, normalized_text, category, lifecycle_status)
      values (${userId}, 'x', 'x', ${category}, ${lifecycle})`
    await thought(member, 'decision', 'open')
    await thought(member, 'decision', 'open')
    await thought(member, 'decision', 'completed')
    await thought(member, 'decision', 'archived')
    await thought(member, 'idea', 'open')
    await thought(other, 'decision', 'open')
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${member}, ${other})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('counts the person’s decision thoughts, open or done, never archived ones or other categories', async () => {
    expect(await db.withDbUser(member, () => countKnownDecisions(member))).toBe(3)
    expect(await db.withDbUser(other, () => countKnownDecisions(other))).toBe(1)
  })

  it('another account counts none of them, even asking for that person', async () => {
    expect(await db.withDbUser(other, () => countKnownDecisions(member))).toBe(0)
  })
})
