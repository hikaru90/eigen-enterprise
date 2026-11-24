/**
 * The pure parts of the upgrade rehearsal (plan/phase-upgrades.md §7 "Core
 * schema", §8 U1): which release is the previous one, the throwaway database,
 * which preStart scripts a box runs, the fail-fast step runner and the report.
 * scripts/upgrade-rehearsal.mjs wires them to git, Postgres and child processes.
 */

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/

/** @param {string} tag */
function semver(tag) {
  const m = STABLE_TAG.exec(tag)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * The newest stable `vMAJOR.MINOR.PATCH` tag that is an ancestor of HEAD, not
 * counting tags on HEAD itself (pushing tag vX at HEAD rehearses the upgrade
 * from the release before it).
 * @param {{ merged: string[], atHead: string[] }} tags `git tag --merged HEAD`, `git tag --points-at HEAD`
 */
export function pickPreviousRelease({ merged, atHead }) {
  const skip = new Set(atHead)
  const candidates = merged
    .filter((t) => !skip.has(t))
    .map((t) => ({ t, v: semver(t) }))
    .filter((c) => c.v !== null)
    .sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2])
  if (candidates.length === 0) {
    throw new Error(
      'no stable v* release tag is an ancestor of HEAD (fetch the tags: git fetch --tags) — there is no previous release to upgrade from',
    )
  }
  return candidates[0].t
}

const DB_NAME = /^[a-z][a-z0-9_]{0,62}$/
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** @param {{ now: Date, random: string }} p */
export function rehearsalDatabaseName({ now, random }) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const name = `ee_rehearsal_${stamp}_${random.toLowerCase()}`
  if (!DB_NAME.test(name)) throw new Error(`not a plain database name: ${name}`)
  return name
}

/**
 * The test DB URL pointed at the throwaway database. Only the local test
 * Postgres: the rehearsal creates and drops databases.
 * @param {string} testUrl @param {string} name
 */
export function rehearsalDatabaseUrl(testUrl, name) {
  if (!DB_NAME.test(name)) throw new Error(`not a plain database name: ${name}`)
  let u
  try {
    u = new URL(testUrl)
  } catch {
    throw new Error(
      'the upgrade rehearsal needs DATABASE_URL pointing at the local test Postgres (npm run db:up, :5433); it is missing or not a URL',
    )
  }
  if (!LOCAL_HOSTS.has(u.hostname)) {
    throw new Error(
      `the upgrade rehearsal only runs against the local test Postgres (it creates and drops databases); DATABASE_URL points at ${u.hostname}`,
    )
  }
  u.searchParams.delete('uselibpqcompat')
  u.pathname = `/${name}`
  return u.toString()
}

/** pg_cron jobs and production secrets: bound to the `eigen` database and NODE_ENV=production, not schema. */
const PRODUCTION_ONLY = new Set(['scripts/bootstrap-production-ops.mjs'])

/**
 * What a box runs before green starts (ee.json preStart), as the rehearsal runs
 * it: every `node scripts/*.mjs` step except the production-only ops bootstrap.
 * @param {{ preStart?: unknown }} eeJson
 * @returns {{ run: string[], skipped: string[] }}
 */
export function preStartForRehearsal(eeJson) {
  if (!Array.isArray(eeJson.preStart) || eeJson.preStart.length === 0) {
    throw new Error('ee.json has no preStart list: cannot tell what a box runs before it starts')
  }
  const run = []
  const skipped = []
  for (const cmd of eeJson.preStart) {
    if (
      !Array.isArray(cmd) ||
      cmd.length !== 2 ||
      cmd[0] !== 'node' ||
      !/^scripts\/[\w.-]+\.mjs$/.test(cmd[1])
    ) {
      throw new Error(
        `ee.json preStart step ${JSON.stringify(cmd)} is not "node scripts/<name>.mjs": the rehearsal cannot run it`,
      )
    }
    ;(PRODUCTION_ONLY.has(cmd[1]) ? skipped : run).push(cmd[1])
  }
  if (!run.includes('scripts/migrate.mjs')) {
    throw new Error(
      'ee.json preStart does not run scripts/migrate.mjs: nothing would migrate the schema',
    )
  }
  return { run, skipped }
}

/**
 * @typedef {{ name: string, run: () => Promise<string | undefined | void> }} Step
 * @typedef {{ name: string, status: 'ok' | 'failed' | 'not run', detail: string, error?: string, ms: number }} StepResult
 * @typedef {{ ok: boolean, steps: StepResult[], cleanup: StepResult }} Report
 */

/** @param {unknown} err */
function message(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Run the steps in order, stop at the first failure (the rest are "not run"),
 * then always run cleanup. A failed cleanup fails the rehearsal.
 * @param {Step[]} steps
 * @param {{ cleanup: () => Promise<string | undefined | void>, clock?: () => number, onStep?: (r: StepResult) => void }} opts
 * @returns {Promise<Report>}
 */
export async function runSteps(steps, { cleanup, clock = Date.now, onStep = () => {} }) {
  /** @type {StepResult[]} */
  const results = []
  let failed = false
  for (const step of steps) {
    if (failed) {
      results.push({ name: step.name, status: 'not run', detail: '', ms: 0 })
      continue
    }
    const start = clock()
    try {
      const detail = (await step.run()) ?? ''
      results.push({ name: step.name, status: 'ok', detail, ms: clock() - start })
    } catch (err) {
      failed = true
      results.push({
        name: step.name,
        status: 'failed',
        detail: '',
        error: message(err),
        ms: clock() - start,
      })
    }
    onStep(results[results.length - 1])
  }
  const start = clock()
  /** @type {StepResult} */
  let cleanupResult
  try {
    cleanupResult = {
      name: 'cleanup',
      status: 'ok',
      detail: (await cleanup()) ?? '',
      ms: clock() - start,
    }
  } catch (err) {
    cleanupResult = {
      name: 'cleanup',
      status: 'failed',
      detail: '',
      error: message(err),
      ms: clock() - start,
    }
  }
  return { ok: !failed && cleanupResult.status === 'ok', steps: results, cleanup: cleanupResult }
}

/**
 * @typedef {{ tool: string, ok: boolean, summary?: string, error?: string }} SmokeResult
 * @param {SmokeResult[]} results
 */
export function smokeFailures(results) {
  if (results.length === 0) return ['the smoke ran no tools']
  return results
    .filter((r) => !r.ok)
    .map((r) => `${r.tool}: ${r.error ?? 'failed without an error'}`)
}

/**
 * What changed for the old app between its baseline (its own schema) and the
 * run after this tree's migrations: a read that fails now, or returns another
 * shape or count. Both runs come from the same smoke list.
 * @param {SmokeResult[]} baseline @param {SmokeResult[]} after
 */
export function smokeRegressions(baseline, after) {
  const now = new Map(after.map((r) => [r.tool, r]))
  return baseline.flatMap((before) => {
    const r = now.get(before.tool)
    if (!r) return [`${before.tool}: did not run after the migrations`]
    if (!r.ok) return [`${r.tool}: ${r.error ?? 'failed without an error'}`]
    if (r.summary !== before.summary) {
      return [`${r.tool}: returned "${r.summary}", before the migrations "${before.summary}"`]
    }
    return []
  })
}

/** @param {number} ms */
function duration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** @param {StepResult} r @param {string} label */
function line(r, label) {
  if (r.status === 'not run') return `${label} — not run`
  const head = `${label} — ${r.status === 'ok' ? 'ok' : 'FAILED'} (${duration(r.ms)})`
  if (r.status === 'ok') return r.detail ? `${head}: ${r.detail}` : head
  return `${head}\n${(r.error ?? '').replace(/^/gm, '     ')}`
}

/** @param {Report} report */
export function formatReport(report) {
  const lines = report.steps.map((s, i) => line(s, `${i + 1}. ${s.name}`))
  lines.push(line(report.cleanup, '   cleanup'))
  const failedAt = report.steps.find((s) => s.status === 'failed')
  const verdict = report.ok
    ? 'upgrade rehearsal: GREEN'
    : failedAt
      ? `upgrade rehearsal: FAILED at "${failedAt.name}"`
      : 'upgrade rehearsal: FAILED at cleanup'
  return `${lines.join('\n')}\n\n${verdict}`
}

/**
 * @typedef {{
 *   previousRelease: () => Promise<{ tag: string, sha: string }>,
 *   createDatabase: () => Promise<string>,
 *   dropDatabase: () => Promise<string>,
 *   checkoutRelease: (tag: string) => Promise<string>,
 *   preStart: (side: 'previous' | 'this') => Promise<{ run: string[], skipped: string[] }>,
 *   seed: () => Promise<string>,
 *   smoke: (label: 'baseline' | 'after') => Promise<SmokeResult[]>,
 *   removeWorkdir: () => Promise<string>,
 * }} RehearsalDeps
 */

/** @param {string[]} scripts */
const bare = (scripts) => scripts.map((s) => s.replace(/^scripts\//, '')).join(', ')

/** @param {{ run: string[], skipped: string[] }} p */
function ranScripts(p) {
  return p.skipped.length ? `${bare(p.run)} (skipped: ${bare(p.skipped)})` : bare(p.run)
}

/**
 * The rehearsal as steps (plan/phase-upgrades.md §8 U1): the previous stable
 * release's schema plus the demo seed, then this tree's migrations, then the
 * previous release's read smoke against the new schema — compared with the
 * same smoke on its own schema first, so a smoke that was already broken is
 * told apart from an upgrade that breaks the old app.
 * @param {RehearsalDeps} deps
 * @returns {{ steps: Step[], cleanup: () => Promise<string> }}
 */
export function planRehearsal(deps) {
  /** @type {{ tag: string, sha: string } | null} */
  let previous = null
  /** @type {SmokeResult[]} */
  let baseline = []
  const tag = () => {
    if (!previous) throw new Error('no previous release picked')
    return previous.tag
  }
  return {
    steps: [
      {
        name: 'previous stable release',
        run: async () => {
          previous = await deps.previousRelease()
          return `${previous.tag} (${previous.sha.slice(0, 12)})`
        },
      },
      { name: 'throwaway database', run: () => deps.createDatabase() },
      { name: 'previous release checkout', run: () => deps.checkoutRelease(tag()) },
      {
        name: 'previous release schema (its own preStart)',
        run: async () => ranScripts(await deps.preStart('previous')),
      },
      { name: 'demo seed (previous release code)', run: () => deps.seed() },
      {
        name: 'previous release read smoke on its own schema (baseline)',
        run: async () => {
          baseline = await deps.smoke('baseline')
          const failed = smokeFailures(baseline)
          if (failed.length) {
            throw new Error(
              `the smoke already fails on ${tag()}'s own schema — fix the smoke list (scripts/upgrade-rehearsal-smoke.mjs), not the migrations:\n${failed.join('\n')}`,
            )
          }
          return `${baseline.length} read tools ok`
        },
      },
      {
        name: "this tree's migrations (HEAD preStart)",
        run: async () => ranScripts(await deps.preStart('this')),
      },
      {
        name: 'previous release read smoke on the new schema',
        run: async () => {
          const after = await deps.smoke('after')
          const broken =
            after.length === 0 ? smokeFailures(after) : smokeRegressions(baseline, after)
          if (broken.length) {
            throw new Error(
              `${tag()} breaks on this tree's schema (blue/green would fail):\n${broken.join('\n')}`,
            )
          }
          return `${after.length} read tools ok, same results as before the migrations`
        },
      },
    ],
    cleanup: async () => {
      // Both always run; a failure is reported after the other one ran.
      const done = []
      const errors = []
      for (const fn of [deps.dropDatabase, deps.removeWorkdir]) {
        try {
          done.push(await fn())
        } catch (err) {
          errors.push(message(err))
        }
      }
      if (errors.length) throw new Error(errors.join('\n'))
      return done.filter(Boolean).join('; ')
    },
  }
}
