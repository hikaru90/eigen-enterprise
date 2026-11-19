#!/usr/bin/env node
/**
 * The oldest release a box may be moved back to from this one (/ops release target, a downgrade).
 * Written into every release as DOWNGRADE_FLOOR (signed with the rest, scripts/release.sh).
 *
 * Going back is safe only while nothing persistent changed in between: database migrations
 * (drizzle/) are forward-only, so older code would run on a schema it never saw, and ee's state
 * (company repo, workload spec, secrets, journal) is parsed strictly, so an older ee would refuse
 * a field a newer one wrote. And never below 0.5.20, the first ee that installs exactly the
 * release it is told to (`ee upgrade --expect`), not whatever is newest.
 *
 *   node scripts/downgrade-floor.mjs <version>    prints the floor version (CI has the full history)
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const MIN_DOWNGRADE_RELEASE = '0.5.20'

/** What a downgrade could break: forward-only migrations and ee's strictly parsed state. */
export const PERSISTENT_PATHS = ['drizzle', 'ee/src/company-repo.ts', 'ee/src/spec.ts', 'ee/src/secrets.ts', 'ee/src/journal.ts']

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
    .filter((t) => compareVersions(t, version) < 0 && compareVersions(t, MIN_DOWNGRADE_RELEASE) >= 0)
    .sort((a, b) => compareVersions(b, a))
  let floor = version
  for (const t of earlier) {
    if (changedSince(t)) break
    floor = t
  }
  return floor
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2]
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('usage: node scripts/downgrade-floor.mjs <version>')
    process.exit(2)
  }
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' })
  const tags = git(['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*'])
    .split('\n')
    .map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
  const changedSince = (t) => {
    try {
      execFileSync('git', ['diff', '--quiet', `v${t}`, 'HEAD', '--', ...PERSISTENT_PATHS])
      return false
    } catch (err) {
      if (err.status === 1) return true
      throw err
    }
  }
  console.log(downgradeFloor({ version, tags, changedSince }))
}
