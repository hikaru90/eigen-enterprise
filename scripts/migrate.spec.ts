import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMigrations } from './migrate.mjs'

/**
 * scripts/migrate.mjs on a throwaway database on the test server (DATABASE_URL, `npm run db:up`):
 * each file in its own transaction with its bookkeeping row, `-- ee:no-transaction` files
 * statement by statement, and every repository migration on a fresh database.
 */

const url = process.env.DATABASE_URL?.trim()
const repoMigrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '../drizzle')

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ee-migrate-'))
  mkdirSync(path.join(dir, 'meta'))
  const tags = Object.keys(files)
  writeFileSync(
    path.join(dir, 'meta/_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({
        idx: 9000 + idx,
        version: '7',
        when: 1_800_000_000_000 + idx,
        tag,
        breakpoints: true,
      })),
    }),
  )
  for (const [tag, sql] of Object.entries(files)) writeFileSync(path.join(dir, `${tag}.sql`), sql)
  return dir
}

describe.skipIf(!url)('migrate.mjs (Postgres, throwaway database)', () => {
  const name = `ee_migrate_spec_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
  let admin: postgres.Sql
  const dirs: string[] = []
  const open: postgres.Sql[] = []

  /** A new empty database; `boxReady` first runs scripts/ensure-extensions.mjs on it, as a box does before migrating. */
  const freshDatabase = async (suffix: string, { boxReady = false } = {}) => {
    const db = `${name}_${suffix}`
    await admin.unsafe(`CREATE DATABASE "${db}"`)
    const u = new URL(url!)
    u.pathname = `/${db}`
    if (boxReady) {
      execFileSync(
        'node',
        [path.join(path.dirname(repoMigrations), 'scripts/ensure-extensions.mjs')],
        {
          env: { ...process.env, DATABASE_URL: u.toString(), AGE_GRAPH_NAME: 'eigen_graph' },
          stdio: 'pipe',
        },
      )
    }
    const client = postgres(u.toString(), { max: 1, onnotice: () => {} })
    open.push(client)
    return client
  }
  const silent = () => {}

  beforeAll(() => {
    admin = postgres(url!, { max: 1, onnotice: () => {} })
  })

  afterAll(async () => {
    for (const c of open) await c.end()
    const left = await admin`SELECT datname FROM pg_database WHERE datname LIKE ${name + '%'}`
    for (const { datname } of left) await admin.unsafe(`DROP DATABASE "${datname}" WITH (FORCE)`)
    await admin.end()
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  it('a failing file is rolled back whole, with no bookkeeping row, and nothing after it runs', async () => {
    const client = await freshDatabase('rollback')
    const dir = fixture({
      '9000_ok': 'CREATE TABLE a (id int);',
      '9001_bad':
        'CREATE TABLE b (id int);\n--> statement-breakpoint\nINSERT INTO b SELECT id FROM missing_table;',
      '9002_later': 'CREATE TABLE c (id int);',
    })
    dirs.push(dir)
    await expect(applyMigrations({ client, migrationsFolder: dir, log: silent })).rejects.toThrow(
      /9001_bad failed and was rolled back.*later migrations were not run.*missing_table/s,
    )
    const tables =
      await client`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`
    expect(tables.map((r) => r.table_name)).toEqual(['a'])
    const [{ count }] =
      await client`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
    expect(count).toBe(1)
  })

  it('runs a -- ee:no-transaction file statement by statement (CREATE INDEX CONCURRENTLY works) and records it', async () => {
    const client = await freshDatabase('notx')
    const dir = fixture({
      '9000_table': "CREATE TABLE t (id int, b text);\nCREATE TYPE s AS ENUM ('a');",
      '9001_index':
        "-- ee:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_b_idx ON t (b);\nALTER TYPE s ADD VALUE IF NOT EXISTS 'b';",
    })
    dirs.push(dir)
    expect(await applyMigrations({ client, migrationsFolder: dir, log: silent })).toBe(2)
    const [idx] = await client`SELECT indexname FROM pg_indexes WHERE indexname = 't_b_idx'`
    expect(idx?.indexname).toBe('t_b_idx')
    const values = await client`SELECT unnest(enum_range(NULL::s))::text AS v`
    expect(values.map((r) => r.v)).toEqual(['a', 'b'])
    expect(await applyMigrations({ client, migrationsFolder: dir, log: silent })).toBe(0)
  })

  it('the same CREATE INDEX CONCURRENTLY in an ordinary file fails inside its transaction (why the marker exists)', async () => {
    const client = await freshDatabase('concurrently')
    const dir = fixture({
      '9000_index': 'CREATE TABLE t (b text);\nCREATE INDEX CONCURRENTLY t_b_idx ON t (b);',
    })
    dirs.push(dir)
    await expect(applyMigrations({ client, migrationsFolder: dir, log: silent })).rejects.toThrow(
      /transaction block/,
    )
    const tables =
      await client`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    expect(tables).toHaveLength(0)
  })

  it('refuses a -- ee:no-transaction file with an ordinary statement before applying anything', async () => {
    const client = await freshDatabase('refuse')
    const dir = fixture({
      '9000_first': 'CREATE TABLE a (id int);',
      '9001_mixed':
        '-- ee:no-transaction\nCREATE INDEX CONCURRENTLY a_idx ON a (id);\nALTER TABLE a ADD COLUMN b int;',
    })
    dirs.push(dir)
    await expect(applyMigrations({ client, migrationsFolder: dir, log: silent })).rejects.toThrow(
      /9001_mixed\.sql:3.*outside a transaction/,
    )
    const tables =
      await client`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    expect(tables).toHaveLength(0)
  })

  it(
    'applies every repository migration to a fresh database, each in its own transaction, then nothing is pending',
    { timeout: 180_000 },
    async () => {
      const client = await freshDatabase('repo', { boxReady: true })
      const applied = await applyMigrations({
        client,
        migrationsFolder: repoMigrations,
        log: silent,
      })
      const [{ count }] =
        await client`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`
      expect(count).toBe(applied)
      expect(applied).toBeGreaterThan(170)
      expect(await applyMigrations({ client, migrationsFolder: repoMigrations, log: silent })).toBe(
        0,
      )
    },
  )
})
