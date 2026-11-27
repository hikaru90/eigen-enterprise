/**
 * Per-worker e2e databases (scripts/e2e.sh, playwright.config.ts shards).
 *
 *   node scripts/e2e-databases.mjs create <prefix> <workers>
 *   node scripts/e2e-databases.mjs drop <prefix> <workers>
 *
 * create: a fresh `<prefix>_tpl` on the test Postgres gets what a box runs before it
 * starts (ee.json preStart: extensions, app role, AGE grants, migrations, RLS — the same
 * list the upgrade rehearsal runs), then `<prefix>_0..N-1` are cloned from it
 * (CREATE DATABASE … TEMPLATE, seconds each). drop: removes exactly those names.
 *
 * Other agents share this Postgres: only databases under our own unique prefix are
 * created or dropped; the shared test database is never touched beyond being the
 * connection CREATE/DROP DATABASE run from.
 */
import './load-env.mjs'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { preStartForRehearsal, rehearsalDatabaseUrl } from './upgrade-rehearsal-lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Same lock as the upgrade rehearsal: ensure-app-role's grants are cluster-wide. */
const BOOTSTRAP_LOCK = 7_303_118_401

const [cmd, prefix, workersArg] = process.argv.slice(2)
const workers = Number(workersArg)
if (
  !['create', 'drop'].includes(cmd ?? '') ||
  !/^ee_e2e_[a-z0-9_]+$/.test(prefix ?? '') ||
  !Number.isInteger(workers) ||
  workers < 1
) {
  console.error('usage: e2e-databases.mjs create|drop <ee_e2e_… prefix> <workers>')
  process.exit(2)
}
const testUrl = process.env.DATABASE_URL
if (!testUrl) throw new Error('DATABASE_URL is required (the test Postgres)')
const adminUrl = rehearsalDatabaseUrl(testUrl, new URL(testUrl).pathname.slice(1))
const template = `${prefix}_tpl`
const shards = Array.from({ length: workers }, (_, i) => `${prefix}_${i}`)

const admin = postgres(adminUrl, { max: 1, onnotice: () => {} })
try {
  if (cmd === 'drop') {
    for (const name of [...shards, template])
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    console.log(`[e2e] dropped ${template} and ${shards.join(', ')}`)
  } else {
    await admin.unsafe(`CREATE DATABASE ${template}`)
    const plan = preStartForRehearsal(JSON.parse(readFileSync(join(root, 'ee.json'), 'utf8')))
    const env = { ...process.env, DATABASE_URL: rehearsalDatabaseUrl(testUrl, template) }
    delete env.DATABASE_ADMIN_URL
    await admin`select pg_advisory_lock(${BOOTSTRAP_LOCK})`
    try {
      for (const script of plan.run) {
        const r = spawnSync(process.execPath, [script], {
          cwd: root,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        })
        if (r.status !== 0) {
          process.stderr.write(r.stdout + r.stderr)
          throw new Error(`${script} on ${template} failed (exit ${r.status})`)
        }
      }
    } finally {
      await admin`select pg_advisory_unlock(${BOOTSTRAP_LOCK})`
    }
    for (const name of shards) await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`)
    console.log(`[e2e] ${template} prepared (${plan.run.join(', ')}); cloned ${shards.join(', ')}`)
  }
} finally {
  await admin.end({ timeout: 5 })
}
