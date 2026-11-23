import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

/**
 * The eval company's own database, on the local test Postgres (the compose
 * DB, :5433). Reset = drop and recreate it, then the same bootstrap scripts a
 * box runs (extensions + AGE graph, migrations, app role grants, RLS) — so
 * the fixture always lands on today's schema, never on other tests' rows.
 *
 * Import this BEFORE anything from $lib/server/db: the app pools read
 * DATABASE_URL once, at module load.
 */
export const EVAL_BRAIN_DATABASE = 'ee_eval_brain'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/

export function evalBrainDatabaseUrl(testUrl: string, name: string = EVAL_BRAIN_DATABASE): string {
  if (!DB_NAME.test(name)) throw new Error(`not a plain database name: ${name}`)
  let u: URL
  try {
    u = new URL(testUrl)
  } catch {
    throw new Error('eval:brain needs DATABASE_URL pointing at the local test Postgres (npm run db:up); it is missing or not a URL')
  }
  if (!LOCAL_HOSTS.has(u.hostname)) {
    throw new Error(`eval:brain only runs against the local test Postgres (it drops and recreates ${name}); DATABASE_URL points at ${u.hostname}`)
  }
  u.pathname = `/${name}`
  return u.toString()
}

const SCRIPTS = ['ensure-extensions.mjs', 'migrate.mjs', 'ensure-app-role.mjs', 'apply-rls.mjs']
const scriptsDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'scripts')

/**
 * Bootstraps run one at a time across processes: the role grants of
 * ensure-app-role.mjs are cluster-wide, and two at once fail with "tuple
 * concurrently updated" (the gate runs static.pg.spec and coworkers.pg.spec in
 * parallel). A session advisory lock on the test database serializes them.
 */
const BOOTSTRAP_LOCK = 7_303_118_401

/** Drop + recreate the eval database and bootstrap it like a box. Returns its URL. */
export async function recreateEvalBrainDatabase(testUrl: string, name: string = EVAL_BRAIN_DATABASE): Promise<string> {
  const evalUrl = evalBrainDatabaseUrl(testUrl, name)
  const lock = postgres(testUrl, { max: 1, onnotice: () => {} })
  try {
    await lock`select pg_advisory_lock(${BOOTSTRAP_LOCK})`
    return await bootstrap(testUrl, evalUrl, name)
  } finally {
    await lock`select pg_advisory_unlock(${BOOTSTRAP_LOCK})`.catch(() => {})
    await lock.end({ timeout: 5 })
  }
}

async function bootstrap(testUrl: string, evalUrl: string, name: string): Promise<string> {
  await dropEvalBrainDatabase(testUrl, name)
  const admin = postgres(testUrl, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`)
  } finally {
    await admin.end({ timeout: 5 })
  }
  for (const script of SCRIPTS) {
    const run = spawnSync(process.execPath, [join(scriptsDir, script)], {
      env: { ...process.env, DATABASE_URL: evalUrl },
      encoding: 'utf8',
    })
    if (run.status !== 0) {
      // The scripts print no credentials; their tail says what failed.
      const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split('\n').slice(-15).join('\n')
      throw new Error(`eval:brain database bootstrap failed in scripts/${script} (exit ${run.status}):\n${tail}`)
    }
  }
  return evalUrl
}

export async function dropEvalBrainDatabase(testUrl: string, name: string = EVAL_BRAIN_DATABASE): Promise<void> {
  evalBrainDatabaseUrl(testUrl, name)
  const admin = postgres(testUrl, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}
