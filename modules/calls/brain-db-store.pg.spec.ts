import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { brainOff, brainOn, shareBrainAnswer } from './brain'
import { dbBrainAnswerStore } from './brain-db-store'
import { dbCallsStore } from './db-store'
import { forceEnd, newCall } from './state'

/**
 * The Company Brain's tables against real Postgres (the test DB, :5433,
 * migration 0159 applied): listening stretches stored by the call's locked
 * mutation, closed by switching off and by the call ending; one open stretch
 * per call; answers private until shared (the call record loads shared ones
 * only); sharing someone else's answer is refused. Needs DATABASE_URL.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('Company Brain stores (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const ids: string[] = []
  const at = (s: number) => new Date(Date.UTC(2026, 10, 19, 10, 0, s))

  const make = async () => {
    const id = randomUUID()
    ids.push(id)
    const rec = newCall({
      id,
      roomName: `ee-call-${id}`,
      contextKind: 'meeting',
      contextId: null,
      title: 'Brain spec',
      startedBy: 'pg-ann',
      startedByParticipant: true,
      invitees: ['pg-ben'],
      now: at(0),
    })
    expect(await dbCallsStore(db).insert(rec)).toEqual({ ok: true })
    return id
  }

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    if (ids.length > 0) await sql`delete from "call" where id in ${sql(ids)}`
    await sql.end()
  })

  it('switching on and off is stored with the call; the call ending closes it (off_by null)', async () => {
    const id = await make()
    const calls = dbCallsStore(db)
    const l1 = randomUUID()
    await calls.mutate(id, (r) => brainOn(r, 'pg-ann', at(10), l1))
    expect((await calls.get(id))!.brainListens).toEqual([{ id: l1, callId: id, onBy: 'pg-ann', onAt: at(10), offAt: null, offBy: null }])
    await calls.mutate(id, (r) => brainOff(r, 'pg-ben', at(20)))
    const l2 = randomUUID()
    await calls.mutate(id, (r) => brainOn(r, 'pg-ben', at(30), l2))
    await calls.mutate(id, (r) => forceEnd(r, at(40)))
    expect((await calls.get(id))!.brainListens).toEqual([
      { id: l1, callId: id, onBy: 'pg-ann', onAt: at(10), offAt: at(20), offBy: 'pg-ben' },
      { id: l2, callId: id, onBy: 'pg-ben', onAt: at(30), offAt: at(40), offBy: null },
    ])
  })

  it('at most one open stretch per call (the database says so too)', async () => {
    const id = await make()
    await sql`insert into call_brain_listen (id, call_id, on_by, on_at) values (${randomUUID()}, ${id}, 'pg-ann', ${at(1)})`
    await expect(sql`insert into call_brain_listen (id, call_id, on_by, on_at) values (${randomUUID()}, ${id}, 'pg-ben', ${at(2)})`).rejects.toThrow()
  })

  it('an answer is private until its asker shares it; the call record carries shared answers only', async () => {
    const id = await make()
    const calls = dbCallsStore(db)
    const answers = dbBrainAnswerStore(db)
    const mine = { id: randomUUID(), callId: id, askedBy: 'pg-ben', question: 'Wann?', answer: 'Morgen.', askedAt: at(5) }
    const other = { id: randomUUID(), callId: id, askedBy: 'pg-ann', question: 'Wer?', answer: 'Weiß ich nicht.', askedAt: at(6) }
    await answers.add(mine)
    await answers.add(other)
    expect((await calls.get(id))!.brainShared).toEqual([])
    expect(await answers.listMine(id, 'pg-ben')).toEqual([{ ...mine, sharedAt: null }])
    expect(await answers.get('not-a-uuid')).toBeNull()

    await calls.mutate(id, (r) => shareBrainAnswer(r, mine, at(7)))
    expect((await calls.get(id))!.brainShared).toEqual([{ ...mine, sharedAt: at(7) }])
    expect((await answers.get(mine.id))!.sharedAt).toEqual(at(7))
    // Sharing as someone who did not ask it matches nothing: refused, nothing stored.
    await expect(calls.mutate(id, (r) => shareBrainAnswer(r, { ...other, askedBy: 'pg-ben' }, at(8)))).rejects.toThrow(/matched no unshared answer/)
    expect((await calls.get(id))!.brainShared.map((s) => s.id)).toEqual([mine.id])
  })

  it('deleting the call deletes its Brain rows', async () => {
    const id = await make()
    await dbCallsStore(db).mutate(id, (r) => brainOn(r, 'pg-ann', at(1), randomUUID()))
    await dbBrainAnswerStore(db).add({ id: randomUUID(), callId: id, askedBy: 'pg-ann', question: 'Q?', answer: 'A.', askedAt: at(2) })
    await sql`delete from "call" where id = ${id}`
    expect(await dbBrainAnswerStore(db).listMine(id, 'pg-ann')).toEqual([])
    expect((await sql`select count(*)::int as n from call_brain_listen where call_id = ${id}`)[0]!.n).toBe(0)
  })
})
