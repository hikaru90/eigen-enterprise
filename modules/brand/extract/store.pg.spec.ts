import type { ProposedCandidate } from './propose'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { expandSeeds } from '../style-format/expand'
import { validSeeds } from '../style-format/seeds.spec'
import { DbBrandExtractionStore } from './store'

/**
 * The extraction store's guide sessions against real Postgres (the test DB,
 * migration 0127 applied): the session + guide written together, the
 * source/url CHECK, bytes kept out of the metadata read, cascade on delete.
 * Needs DATABASE_URL; skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

const guide = {
  filename: 'Kindred CI.pdf',
  mime: 'application/pdf' as const,
  sizeBytes: 9,
  base64: 'JVBERi0xLjcK',
}

function candidate(): ProposedCandidate {
  const seeds = validSeeds()
  const expanded = expandSeeds(seeds)
  return { label: 'Color-led', seeds, cssVars: expanded.cssVars, darkCssVars: expanded.darkCssVars }
}

describe.skipIf(!url)('DbBrandExtractionStore guide sessions (Postgres)', () => {
  let sql: postgres.Sql
  let store: DbBrandExtractionStore
  const ids: string[] = []

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    store = new DbBrandExtractionStore(drizzle(sql) as unknown as AppDatabase)
  })

  afterAll(async () => {
    if (ids.length) await sql`delete from brand_extraction_sessions where id in ${sql(ids)}`
    await sql.end()
  })

  it('stores a guide session with its guide; reads the bytes back, metadata without them', async () => {
    const session = await store.createGuideSession({ guide })
    ids.push(session.id)
    expect(session).toMatchObject({
      source: 'guide',
      url: null,
      title: 'Kindred CI.pdf',
      status: 'active',
    })
    await expect(store.requireSession(session.id)).resolves.toMatchObject({
      source: 'guide',
      url: null,
    })
    await expect(store.getGuide(session.id)).resolves.toEqual(guide)
    await expect(store.getGuideMeta(session.id)).resolves.toEqual({
      filename: 'Kindred CI.pdf',
      mime: 'application/pdf',
      sizeBytes: 9,
    })
  })

  it('URL sessions default to source url and have no guide', async () => {
    const session = await store.createSession({ url: 'https://example.com', title: 'Example' })
    ids.push(session.id)
    expect(session).toMatchObject({ source: 'url', url: 'https://example.com' })
    await expect(store.getGuide(session.id)).resolves.toBeNull()
  })

  it('the CHECK keeps source and url consistent', async () => {
    await expect(
      sql`insert into brand_extraction_sessions (source, url) values ('url', null)`,
    ).rejects.toThrow(/brand_extraction_sessions_source_check/)
    await expect(
      sql`insert into brand_extraction_sessions (source, url) values ('guide', 'https://example.com')`,
    ).rejects.toThrow(/brand_extraction_sessions_source_check/)
  })

  it('runs the judge loop on a guide session and stages a corpus item naming the guide', async () => {
    const session = await store.createGuideSession({ guide })
    ids.push(session.id)
    await store.createRound({
      sessionId: session.id,
      round: 0,
      digest: 'BRAND GUIDE',
      screenshotB64: '',
      candidates: [],
    })
    await store.createRound({
      sessionId: session.id,
      round: 1,
      digest: 'BRAND GUIDE',
      screenshotB64: '',
      candidates: [candidate(), candidate(), candidate()],
    })
    await store.judgeRound({ sessionId: session.id, round: 1, chosen: 2 })
    const staged = await store.accept(session.id, 'Kindred print')
    expect(staged.corpusItem.provenance).toMatchObject({
      source: 'extraction',
      note: 'brand guide “Kindred CI.pdf”',
    })
    await sql`delete from brand_corpus_staging where id = ${staged.id}`
  })

  it('deleting the session deletes its guide', async () => {
    const session = await store.createGuideSession({ guide })
    await sql`delete from brand_extraction_sessions where id = ${session.id}`
    const rows = await sql`select 1 from brand_extraction_guides where session_id = ${session.id}`
    expect(rows).toHaveLength(0)
  })
})
