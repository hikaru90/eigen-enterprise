#!/usr/bin/env node
/**
 * The upgrade rehearsal (plan/phase-upgrades.md §7 "Core schema", §8 U1):
 * proves this tree can upgrade a real install of the previous stable release
 * without breaking that release while it still runs during blue/green.
 *
 *   npm run upgrade:rehearsal      (starts the compose test Postgres first)
 *
 * On the local test Postgres (DATABASE_URL, :5433), in a fresh throwaway
 * database that is dropped at the end, also on failure:
 *  1. the previous stable release = the newest vX.Y.Z tag behind HEAD;
 *  2. its tree (`git archive`) in the OS temp dir, with this checkout's
 *     node_modules when its package-lock.json is identical, else `npm ci`;
 *  3. its own ee.json preStart (extensions, app role, AGE probe, its
 *     migrations, RLS) — what a box ran when it installed that release;
 *  4. the demo company, seeded by that release's own code (demo.seed_company);
 *  5. that release's read smoke on its own schema (the baseline);
 *  6. THIS tree's ee.json preStart (green's preStart: this tree's migrations);
 *  7. that release's read smoke again, on the new schema: every read must still
 *     work and return what it returned before (shape and counts).
 *
 * The read smoke runs the previous release's own registry in process — its
 * composition root (bootApp), its tools, its DB layer — as the demo owner:
 * the closest thing to the old app serving reads after the migrations short
 * of booting its server. The list is scripts/upgrade-rehearsal-smoke.mjs.
 *
 * Children get a clean environment (PATH, HOME, temp) plus throwaway values:
 * never this checkout's .env secrets, provider keys or production URLs. Step
 * logs are kept in test-results/upgrade-rehearsal/<database>/.
 * Exit 0 = green; 1 = a step or the cleanup failed (the report says which).
 */
import './load-env.mjs'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import {
  formatReport,
  pickPreviousRelease,
  planRehearsal,
  preStartForRehearsal,
  rehearsalDatabaseName,
  rehearsalDatabaseUrl,
  runSteps,
} from './upgrade-rehearsal-lib.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MINUTE = 60_000

/**
 * The bootstrap lock evals/brain/db.ts takes: ensure-app-role's grants are
 * cluster-wide, and two bootstraps at once fail with "tuple concurrently updated".
 */
const BOOTSTRAP_LOCK = 7_303_118_401

const ageGraph = process.env.AGE_GRAPH_NAME?.trim()
if (!ageGraph) throw new Error('AGE_GRAPH_NAME is required (see .env.example)')
const testUrl = process.env.DATABASE_URL ?? ''
const dbName = rehearsalDatabaseName({ now: new Date(), random: randomBytes(3).toString('hex') })
const dbUrl = rehearsalDatabaseUrl(testUrl, dbName)
// CREATE / DROP DATABASE run from the test database itself (DATABASE_URL as it is).
const adminUrl = rehearsalDatabaseUrl(testUrl, new URL(testUrl).pathname.slice(1))
const work = mkdtempSync(join(tmpdir(), 'ee-upgrade-rehearsal-'))
const releaseDir = join(work, 'release')
const stateDir = join(work, 'state')
const logDir = join(root, 'test-results', 'upgrade-rehearsal', dbName)
mkdirSync(logDir, { recursive: true })

/** What every child sees: a clean environment plus throwaway values for this rehearsal only. */
const childEnv = {
  ...Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SHELL', 'USER'].flatMap((k) =>
      process.env[k] ? [[k, process.env[k]]] : [],
    ),
  ),
  DATABASE_URL: dbUrl,
  DATABASE_ADMIN_URL: dbUrl,
  AGE_GRAPH_NAME: ageGraph,
  // The app role's password is cluster-wide on the test Postgres: the same one this checkout uses.
  ...(process.env.EIGEN_APP_DB_PASSWORD
    ? { EIGEN_APP_DB_PASSWORD: process.env.EIGEN_APP_DB_PASSWORD }
    : {}),
  ORIGIN: 'http://localhost:4173',
  BETTER_AUTH_SECRET: `rehearsal-${randomBytes(24).toString('hex')}`,
  TENANT_MASTER_KEY: `rehearsal-${randomBytes(24).toString('hex')}`,
  MAIL_TRANSPORT: 'fake',
  EE_AGENT_STATE_DIR: join(stateDir, 'agent'),
  DRIVE_STORAGE_DIR: join(stateDir, 'drive'),
  COMPANY_DATA_DIR: join(stateDir, 'company-data'),
  COMPANY_KEYS_DIR: join(stateDir, 'company-keys'),
}

let interrupted = false
// Ctrl-C reaches the running child too; the step fails and the cleanup still runs.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (interrupted = true))

/** @param {string[]} args */
function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** @param {string} file */
function tail(file, n = 25) {
  return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n')
}

/**
 * Run a child with its output in a step log; throw with what ran, the exit and the log's tail.
 * @param {string} label @param {string} cmd @param {string[]} args @param {{ cwd: string, timeoutMs: number }} o
 */
function run(label, cmd, args, { cwd, timeoutMs }) {
  const log = join(logDir, `${label.replace(/[^\w.-]+/g, '_')}.log`)
  const fd = openSync(log, 'w')
  let r
  try {
    r = spawnSync(cmd, args, { cwd, env: childEnv, stdio: ['ignore', fd, fd], timeout: timeoutMs })
  } finally {
    closeSync(fd)
  }
  if (interrupted) throw new Error(`${label}: interrupted`)
  if (r.error) throw new Error(`${label}: ${r.error.message} (log: ${log})`)
  if (r.status !== 0) {
    throw new Error(`${label} exited ${r.status ?? r.signal} (log: ${log}):\n${tail(log)}`)
  }
  return log
}

/** @param {(sql: import('postgres').Sql) => Promise<void>} fn */
async function admin(fn) {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    await fn(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** @param {() => void} fn */
async function withBootstrapLock(fn) {
  const sql = postgres(adminUrl, { max: 1, onnotice: () => {} })
  try {
    await sql`select pg_advisory_lock(${BOOTSTRAP_LOCK})`
    fn()
  } finally {
    await sql`select pg_advisory_unlock(${BOOTSTRAP_LOCK})`.catch(() => {})
    await sql.end({ timeout: 5 })
  }
}

/** @param {string} dir @param {string} side */
async function preStartIn(dir, side) {
  const plan = preStartForRehearsal(JSON.parse(readFileSync(join(dir, 'ee.json'), 'utf8')))
  await withBootstrapLock(() => {
    for (const script of plan.run)
      run(`${side} ${script}`, process.execPath, [script], { cwd: dir, timeoutMs: 10 * MINUTE })
  })
  return plan
}

/** @param {string[]} args */
function releaseRunner(label, ...args) {
  return run(
    label,
    join(releaseDir, 'node_modules', '.bin', 'vite-node'),
    [
      '--config',
      'vitest.config.ts',
      '--options.transformMode.ssr=.*',
      'scripts/upgrade-rehearsal-release.ts',
      '--',
      ...args,
    ],
    { cwd: releaseDir, timeoutMs: 15 * MINUTE },
  )
}

const { steps, cleanup } = planRehearsal({
  previousRelease: async () => {
    const tag = pickPreviousRelease({
      merged: git('tag', '--merged', 'HEAD', '--list', 'v*').split('\n').filter(Boolean),
      atHead: git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean),
    })
    return { tag, sha: git('rev-parse', `${tag}^{commit}`) }
  },

  createDatabase: async () => {
    await admin((sql) => sql.unsafe(`CREATE DATABASE ${dbName}`).then(() => {}))
    return `${dbName} on ${new URL(adminUrl).host}`
  },

  dropDatabase: async () => {
    await admin((sql) =>
      sql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).then(() => {}),
    )
    return `dropped ${dbName}`
  },

  checkoutRelease: async (tag) => {
    mkdirSync(releaseDir, { recursive: true })
    const archive = join(work, 'release.tar')
    git('archive', '--format=tar', '-o', archive, tag)
    run('extract', 'tar', ['-xf', archive, '-C', releaseDir], { cwd: work, timeoutMs: 5 * MINUTE })
    rmSync(archive)
    // Same lock = same packages: reuse this checkout's install (minutes saved); else the release's own.
    const lockSame =
      readFileSync(join(releaseDir, 'package-lock.json'), 'utf8') ===
      readFileSync(join(root, 'package-lock.json'), 'utf8')
    let deps
    if (lockSame) {
      if (!existsSync(join(root, 'node_modules', '.bin', 'vite-node'))) {
        throw new Error(
          'this checkout has no node_modules (run npm ci): the previous release reuses them, its package-lock.json is identical',
        )
      }
      symlinkSync(join(root, 'node_modules'), join(releaseDir, 'node_modules'), 'dir')
      deps = "this checkout's node_modules (identical package-lock.json)"
    } else {
      run(
        `${tag} npm ci`,
        'npm',
        ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
        {
          cwd: releaseDir,
          timeoutMs: 20 * MINUTE,
        },
      )
      deps = 'its own npm ci (package-lock.json differs)'
    }
    // svelte-kit sync + Paraglide, as `npm ci` would via prepare (no .git there: no hooks).
    run(`${tag} npm-prepare`, process.execPath, ['scripts/npm-prepare.mjs'], {
      cwd: releaseDir,
      timeoutMs: 5 * MINUTE,
    })
    for (const f of ['upgrade-rehearsal-release.ts', 'upgrade-rehearsal-smoke.mjs']) {
      copyFileSync(join(root, 'scripts', f), join(releaseDir, 'scripts', f))
    }
    return `${releaseDir}, ${deps}`
  },

  preStart: (side) =>
    side === 'previous' ? preStartIn(releaseDir, 'previous') : preStartIn(root, 'this'),

  seed: async () => {
    const log = releaseRunner('demo seed', 'seed', 'owner@rehearsal.example')
    const line = readFileSync(log, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('[rehearsal] seeded: '))
    if (!line) throw new Error(`the seed exited 0 but reported nothing (log: ${log})`)
    const counts = JSON.parse(line.slice('[rehearsal] seeded: '.length))
    return Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')
  },

  smoke: async (label) => {
    const out = join(logDir, `smoke-${label}.json`)
    releaseRunner(`smoke ${label}`, 'smoke', out)
    return JSON.parse(readFileSync(out, 'utf8'))
  },

  removeWorkdir: async () => {
    rmSync(work, { recursive: true, force: true })
    return `removed ${work}`
  },
})

console.log(`upgrade rehearsal → ${dbName} (logs: ${logDir})\n`)
const report = await runSteps(steps, {
  cleanup,
  onStep: (s) => console.log(`  ${s.status === 'ok' ? 'ok    ' : 'FAILED'} ${s.name}`),
})
console.log(`\n${formatReport(report)}`)
process.exit(report.ok ? 0 : 1)
