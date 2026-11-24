/**
 * Programmatic Drizzle migration runner.
 *
 * Applies every journal entry of drizzle/ whose SQL hash is not yet in
 * drizzle.__drizzle_migrations. Fully non-interactive — safe for Docker / CI / non-TTY environments.
 *
 * Transactions (plan/phase-upgrades.md §6.4 step 3)
 * -------------------------------------------------
 * Each file runs in its OWN transaction together with its bookkeeping row: BEGIN, the file's
 * statements (drizzle's `--> statement-breakpoint` chunks), INSERT into __drizzle_migrations,
 * COMMIT. Any error rolls that file back whole and stops the run, loudly; later files are not
 * attempted. (Before, every chunk ran in autocommit, so a failure left a half-applied file.)
 * Not one transaction for the whole run: a release's earlier, good files stay applied and a
 * retry resumes at the failed file.
 *
 * A file whose first line is `-- ee:no-transaction` runs outside a transaction, one statement at
 * a time, then gets its row; it may hold only statements that cannot run inside one (CREATE/DROP
 * INDEX CONCURRENTLY, REINDEX … CONCURRENTLY, ALTER TYPE … ADD VALUE — scripts/check-migrations.mjs).
 * Every pending file is planned before the first one runs, so such a file with anything else in
 * it is refused before the database changes.
 *
 * Push-to-migrate transition
 * --------------------------
 * This project was previously managed with `drizzle-kit push`, which never creates
 * the `drizzle.__drizzle_migrations` tracking table. The bootstrap step below detects that
 * condition (thought table exists but migrations table is empty/missing) and pre-seeds migration
 * records for 0000-0008 so that only the genuinely missing files (0009+) are applied.
 *
 * The hash stored per entry is SHA-256 of the raw SQL file content — the same
 * computation drizzle-orm/postgres-js/migrator uses internally.
 *
 * Usage: node scripts/migrate.mjs
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planMigration } from './check-migrations.mjs'

const repoMigrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), '../drizzle')

// Index of the last migration that was applied via drizzle-kit push (never tracked).
// Any entry with idx <= LAST_PUSH_IDX on a push-managed DB is treated as already applied.
const LAST_PUSH_IDX = 8 // 0008_chat_message_metadata

function migrationHash(sqlContent) {
  return createHash('sha256').update(sqlContent).digest('hex')
}

/** Fail fast when a .sql file exists but is absent from the journal (never applied on deploy). */
function assertJournalCoversAllMigrationFiles(migrationsFolder, journal) {
  const journalTags = new Set(journal.entries.map((e) => e.tag))
  const diskTags = readdirSync(migrationsFolder)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .map((name) => name.replace(/\.sql$/, ''))
  const missing = diskTags.filter((tag) => !journalTags.has(tag)).sort()
  if (missing.length > 0) {
    throw new Error(
      `Migration journal is missing ${missing.length} SQL file(s): ${missing.join(', ')}. ` +
        'Add them to drizzle/meta/_journal.json or deploy will skip schema changes.',
    )
  }
}

async function ensureBookkeeping(client) {
  await client`CREATE SCHEMA IF NOT EXISTS drizzle`
  await client`
		CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
			id         SERIAL PRIMARY KEY,
			hash       text NOT NULL,
			created_at bigint
		)
	`
  // Pin DDL to public schema.  The DB-level search_path includes ag_catalog
  // where AGE's internal label tables live — without this SET, unqualified
  // CREATE TABLE could resolve to ag_catalog and collide with AGE labels.
  await client.unsafe('SET search_path TO public')
}

/**
 * Detects a DB previously managed by drizzle-kit push and pre-seeds the
 * drizzle.__drizzle_migrations table so already-applied files are skipped.
 */
async function bootstrapIfPushManaged(client, migrationsFolder, journal, log) {
  // If the table already has records, migrations have run before — nothing to do.
  const [{ count }] = await client`SELECT COUNT(*) AS count FROM drizzle.__drizzle_migrations`
  if (parseInt(count, 10) > 0) return

  // Check if this looks like a push-managed DB (thought table exists).
  const [{ exists }] = await client`
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = 'public' AND table_name = 'thought'
		) AS exists
	`
  if (!exists) return // Fresh database — apply everything from 0000.

  log(`[eigen] Detected push-managed DB. Seeding migration history for idx 0–${LAST_PUSH_IDX}...`)
  for (const entry of journal.entries) {
    if (entry.idx > LAST_PUSH_IDX) break
    const sqlContent = readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf-8')
    await client`
			INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
			VALUES (${migrationHash(sqlContent)}, ${entry.when})
		`
  }
  log(`[eigen] Migration history seeded. Applying idx ${LAST_PUSH_IDX + 1}+.`)
}

async function applyOne(client, { entry, hash, plan }) {
  const record = (sql) => sql`
		INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
		VALUES (${hash}, ${entry.when})
	`
  if (plan.mode === 'transaction') {
    try {
      await client.begin(async (tx) => {
        for (const stmt of plan.statements) await tx.unsafe(stmt)
        await record(tx)
      })
    } catch (err) {
      throw new Error(
        `${entry.tag} failed and was rolled back (nothing of it is applied); later migrations were not run: ${err.message}`,
        { cause: err },
      )
    }
    return
  }
  for (const [i, stmt] of plan.statements.entries()) {
    try {
      await client.unsafe(stmt)
    } catch (err) {
      throw new Error(
        `${entry.tag} (-- ee:no-transaction) failed at statement ${i + 1} of ${plan.statements.length}; ` +
          `statements before it stay applied and the file is not recorded, so it runs again from the top next time; ` +
          `later migrations were not run: ${err.message}`,
        { cause: err },
      )
    }
  }
  await record(client)
}

/**
 * Applies the journal entries of `migrationsFolder` missing from drizzle.__drizzle_migrations
 * (by hash, so an entry applied out of order is not skipped), each file in its own transaction.
 * @param {{ client: import('postgres').Sql, migrationsFolder?: string, log?: (line: string) => void }} input
 * @returns {Promise<number>} how many files were applied
 */
export async function applyMigrations({
  client,
  migrationsFolder = repoMigrationsFolder,
  log = console.log,
}) {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf-8'),
  )
  assertJournalCoversAllMigrationFiles(migrationsFolder, journal)
  log(`[eigen] Running migrations from ${migrationsFolder}`)
  await ensureBookkeeping(client)
  await bootstrapIfPushManaged(client, migrationsFolder, journal, log)

  const applied = new Set(
    (await client`SELECT hash FROM drizzle.__drizzle_migrations`).map((r) => r.hash),
  )
  const pending = []
  for (const entry of journal.entries) {
    const sqlContent = readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), 'utf-8')
    const hash = migrationHash(sqlContent)
    if (applied.has(hash)) continue
    applied.add(hash)
    pending.push({ entry, hash, plan: planMigration(sqlContent, entry.tag) })
  }

  for (const item of pending) {
    log(
      `[eigen] Applying ${item.entry.tag}${item.plan.mode === 'no-transaction' ? ' (no transaction)' : ''}...`,
    )
    await applyOne(client, item)
  }
  log(
    pending.length === 0
      ? '[eigen] No pending migrations.'
      : `[eigen] Applied ${pending.length} migration(s).`,
  )
  return pending.length
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isMain) {
  await import('./load-env.mjs')
  const { default: postgres } = await import('postgres')
  const { getDatabaseUrl } = await import('./db-urls.mjs')
  const client = postgres(getDatabaseUrl(), { max: 1 })
  try {
    await applyMigrations({ client })
    console.log('[eigen] Migrations complete.')
  } catch (err) {
    console.error('[eigen] Migration failed:', err)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}
