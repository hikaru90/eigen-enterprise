import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { readCatalog } from './catalog'
import { planCompanyExport, type TablePlan } from './plan'
import { COMPANY_EXPORT_EXCLUDED_SCHEMAS, COMPANY_EXPORT_RULES } from './rules'

/**
 * The "everything" guard (plan/phase-export.md §2) against the migrated test
 * database: every table and column there has a rule, and every planned query
 * runs. A migration that adds a table or a column to a table with private rows
 * fails here until it is classified in rules.ts.
 */

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
const sql = url ? postgres(url, { max: 1 }) : null
afterAll(async () => {
  await sql?.end()
})

const rowsPlan = (plan: TablePlan[], table: string) => {
  const p = plan.find((x) => x.table === table)
  if (!p || p.export !== 'rows') throw new Error(`${table} is not exported`)
  return p
}

class Rollback extends Error {}

describe.skipIf(!sql)('company export rules against the database', () => {
  it('classify every table and every column, and every planned query runs', async () => {
    const plan = planCompanyExport(await readCatalog(sql!), COMPANY_EXPORT_RULES, COMPANY_EXPORT_EXCLUDED_SCHEMAS)
    for (const p of plan) {
      if (p.export !== 'rows') continue
      await expect(sql!.unsafe(`${p.sql} LIMIT 1`), p.table).resolves.toBeDefined()
    }
  })

  it('a DM’s message is metadata only; a channel message is in full', async () => {
    const plan = planCompanyExport(await readCatalog(sql!), COMPANY_EXPORT_RULES, COMPANY_EXPORT_EXCLUDED_SCHEMAS)
    const messages = rowsPlan(plan, 'messages')
    const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
    let seen: Record<string, unknown>[] = []
    await sql!
      .begin(async (tx) => {
        const uid = `export_spec_${suffix}`
        await tx`INSERT INTO "user" (id, name, email) VALUES (${uid}, 'Spec', ${`${uid}@test.local`})`
        const [dm] = await tx`INSERT INTO message_conversations (kind, private, dm_key, created_by) VALUES ('dm', true, ${`dm:${suffix}`}, ${uid}) RETURNING id`
        const [ch] = await tx`INSERT INTO message_conversations (kind, name, created_by) VALUES ('channel', ${`general-${suffix}`}, ${uid}) RETURNING id`
        await tx`INSERT INTO messages (conversation_id, author_id, body) VALUES (${dm.id}, ${uid}, 'the dm body'), (${ch.id}, ${uid}, 'the channel body')`
        seen = (await tx.unsafe(`${messages.sql} WHERE t.author_id = '${uid}' ORDER BY t.body`)).map((r) => r.row)
        throw new Rollback()
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e
      })
    expect(seen).toHaveLength(2)
    const [channel, dm] = seen
    expect(channel).toMatchObject({ body: 'the channel body' })
    expect(dm).toMatchObject({ _private: true })
    expect(dm).not.toHaveProperty('body')
    expect(Object.keys(dm).sort()).toEqual(
      ['_private', 'author_id', 'conversation_id', 'created_at', 'deleted_at', 'edited_at', 'id', 'parent_id', 'reply_to_id'].sort(),
    )
  })

  it('a secret column never appears in the exported row', async () => {
    const plan = planCompanyExport(await readCatalog(sql!), COMPANY_EXPORT_RULES, COMPANY_EXPORT_EXCLUDED_SCHEMAS)
    const account = rowsPlan(plan, 'account')
    expect(account.sql).toContain(`- 'password'`)
    expect(account.sql).toContain(`- 'refresh_token'`)
  })
})

describe.skipIf(!sql)('a full company export of the test database', () => {
  it('streams every table into a zip a standard unzip reads, private rows without content', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { unzipSync, strFromU8 } = await import('fflate')
    const { buildCompanyExport } = await import('./run')
    const { cursorRows } = await import('./catalog')
    const dir = mkdtempSync(join(tmpdir(), 'ee-full-export-'))
    try {
      const file = join(dir, 'export.zip')
      const { manifest } = await buildCompanyExport(
        {
          file,
          rules: COMPANY_EXPORT_RULES,
          excludedSchemas: COMPANY_EXPORT_EXCLUDED_SCHEMAS,
          company: { name: 'Test Co' },
          appVersion: 'test',
          requestedBy: 'spec',
          now: () => new Date(),
        },
        { catalog: () => readCatalog(sql!), rows: (q) => cursorRows(sql!, q, 200), files: async function* () {} },
      )
      const zip = unzipSync(readFileSync(file))
      for (const t of manifest.tables) {
        const lines = strFromU8(zip[`data/${t.table}.jsonl`]).split('\n').filter(Boolean)
        expect(lines.length, t.table).toBe(t.rows)
      }
      const thoughts = strFromU8(zip['data/thought.jsonl']).split('\n').filter(Boolean).map((l) => JSON.parse(l))
      for (const row of thoughts.filter((r) => r._private)) {
        expect(row).not.toHaveProperty('raw_text')
        expect(row).not.toHaveProperty('raw_text_encrypted')
        expect(row).not.toHaveProperty('embedding')
      }
      expect(JSON.parse(strFromU8(zip['manifest.json'])).tables.length).toBe(manifest.tables.length)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
