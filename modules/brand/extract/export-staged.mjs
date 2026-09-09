/**
 * Export staged brand corpus items to corpus JSON files (phase-2d M2, dev-time).
 *
 * Usage: node modules/brand/extract/export-staged.mjs
 * Requires DATABASE_URL (owner-run). Reads every brand_corpus_staging row with
 * status 'staged', writes modules/brand/corpus/<id>.json, marks it exported.
 * Loud errors only — no defaults, no partial success without a stack trace.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { getDatabaseUrl } from '../../../scripts/db-urls.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const corpusDir = path.join(here, '../corpus')

const sql = postgres(getDatabaseUrl(), { max: 1 })

const staged = await sql`
  select id, session_id, name, corpus_item, status, created_at
  from brand_corpus_staging
  where status = 'staged'
  order by created_at asc
`

if (staged.length === 0) {
  console.info('no staged corpus items to export')
  await sql.end()
  process.exit(0)
}

mkdirSync(corpusDir, { recursive: true })

for (const row of staged) {
  const item = {
    id: row.id,
    name: row.name,
    ...row.corpus_item,
  }
  const file = path.join(corpusDir, `${row.id}.json`)
  writeFileSync(file, `${JSON.stringify(item, null, 2)}\n`)
  const exported = await sql`
    update brand_corpus_staging
    set status = 'exported'
    where id = ${row.id} and status = 'staged'
    returning id
  `
  if (exported.length !== 1) {
    throw new Error(`failed to mark corpus item exported: ${row.id}`)
  }
  console.info(`exported ${row.name} -> modules/brand/corpus/${row.id}.json`)
}

await sql.end()
