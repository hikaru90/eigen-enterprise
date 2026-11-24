#!/usr/bin/env node
/**
 * The oldest release a box may be moved back to from this one (/ops release target, a downgrade).
 * Written into every release as DOWNGRADE_FLOOR (signed with the rest, scripts/release.sh).
 *
 * Going back is safe only while nothing persistent changed in between that the older release
 * cannot live with:
 *   - Database migrations (drizzle/) are forward-only. Since the expand/contract lint
 *     (scripts/check-migrations.mjs) an ordinary migration only adds, and the older release runs
 *     on the expanded schema (that is what blue/green relies on too). What moves the floor: a
 *     `-- ee:contract` migration (it drops, renames or tightens — the floor becomes the first
 *     release containing it), a migration from before the lint (baselined, never checked to only
 *     add), and any change to an existing migration file or a journal that did more than append.
 *   - ee's state (company repo, workload spec, secrets, journal) is parsed strictly, so an older
 *     ee would refuse a field a newer one wrote: any change there moves the floor.
 * And never below 0.5.20, the first ee that installs exactly the release it is told to
 * (`ee upgrade --expect`), not whatever is newest.
 *
 *   node scripts/downgrade-floor.mjs <version>    prints the floor version (CI has the full history)
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BASELINED_MIGRATIONS, migrationMarker } from './check-migrations.mjs'

export const MIN_DOWNGRADE_RELEASE = '0.5.20'

/** ee's strictly parsed state: any change moves the floor. */
export const EE_STATE_PATHS = [
  'ee/src/company-repo.ts',
  'ee/src/spec.ts',
  'ee/src/secrets.ts',
  'ee/src/journal.ts',
]

const JOURNAL = 'drizzle/meta/_journal.json'
const MIGRATION_FILE = /^drizzle\/(\d{4}_[^/]+)\.sql$/

const parts = (v) => v.split('.').map(Number)
export function compareVersions(a, b) {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/**
 * Walks the earlier releases newest first; each one with no persistent change since is reachable.
 * @param {{ version: string, tags: string[], changedSince: (version: string) => boolean }} input
 */
export function downgradeFloor({ version, tags, changedSince }) {
  const earlier = tags
    .filter(
      (t) => compareVersions(t, version) < 0 && compareVersions(t, MIN_DOWNGRADE_RELEASE) >= 0,
    )
    .sort((a, b) => compareVersions(b, a))
  let floor = version
  for (const t of earlier) {
    if (changedSince(t)) break
    floor = t
  }
  return floor
}

/**
 * Why the drizzle/ changes between an older release and HEAD stop that release from running on
 * HEAD's schema, or null when they don't (only expand migrations were added).
 * @param {{
 *   changes: { status: string, path: string }[],   // `git diff --name-status --no-renames <old> HEAD -- drizzle`
 *   readHead: (path: string) => string,            // a file at HEAD
 *   readAt: (path: string) => string,              // a file at the older release
 * }} input
 * @returns {string | null}
 */
export function drizzleChangeMovesFloor({ changes, readHead, readAt }) {
  const baselined = new Set(BASELINED_MIGRATIONS)
  for (const { status, path } of changes) {
    if (path === JOURNAL && status === 'M') {
      const before = JSON.parse(readAt(JOURNAL)).entries
      const after = JSON.parse(readHead(JOURNAL)).entries
      const appended =
        before.length <= after.length &&
        before.every((e, i) => JSON.stringify(e) === JSON.stringify(after[i]))
      if (!appended) return `${JOURNAL}: the journal changed other than by appending`
      continue
    }
    const file = MIGRATION_FILE.exec(path)
    if (file && status === 'A') {
      const tag = file[1]
      if (baselined.has(tag))
        return `${tag} predates the expand/contract lint (baselined, never checked to only add)`
      if (migrationMarker(readHead(path)) === 'contract')
        return `${tag} is a \`-- ee:contract\` migration`
      continue
    }
    return `${path} changed (${status})`
  }
  return null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('usage: node scripts/downgrade-floor.mjs <version>')
    process.exit(2)
  }
  const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const tags = git(['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*'])
    .split('\n')
    .map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
  const changedSince = (t) => {
    try {
      execFileSync('git', ['diff', '--quiet', `v${t}`, 'HEAD', '--', ...EE_STATE_PATHS])
    } catch (err) {
      if (err.status === 1) return true
      throw err
    }
    const changes = git(['diff', '--name-status', '--no-renames', `v${t}`, 'HEAD', '--', 'drizzle'])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split('\t')
        return { status, path }
      })
    return (
      drizzleChangeMovesFloor({
        changes,
        readHead: (p) => git(['show', `HEAD:${p}`]),
        readAt: (p) => git(['show', `v${t}:${p}`]),
      }) !== null
    )
  }
  console.log(downgradeFloor({ version, tags, changedSince }))
}
