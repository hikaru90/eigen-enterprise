#!/usr/bin/env node
/**
 * UPGRADE.json, the signed upgrade metadata of a release (plan/phase-upgrades.md §6.4 step 1):
 * ee checks it on the box before it changes anything (ee/src/release-meta.ts).
 *
 *   downgradeFloor  the oldest release a box may go back to from this one (scripts/downgrade-floor.mjs)
 *   minFrom         the oldest release that may upgrade straight to this one (MIN_UPGRADE_FROM)
 *   capabilities    the system programs the os workload needs (ee.json `capabilities`)
 *
 * scripts/release.sh writes it next to DOWNGRADE_FLOOR and lists it in SHA256SUMS, which the
 * release workflow signs. A release since 0.5.40 without it is refused by ee.
 *
 *   node scripts/upgrade-meta.mjs <release name> <downgrade floor>    prints UPGRADE.json
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The oldest release that may upgrade straight to the newest one: 0.5.20 is the first ee that
 * installs exactly the release it is told to (`ee upgrade --expect`). Raise it when a release can
 * no longer be reached in one step from older ones (a reader of an old format dropped, a
 * migration that needs an earlier release's to have run): such a box installs a release in between.
 */
export const MIN_UPGRADE_FROM = '0.5.20'

const RELEASE_NAME = /^eigenenterprise-(\d+\.\d+\.\d+)-[0-9a-f]{12}$/
const VERSION = /^\d+\.\d+\.\d+$/

/**
 * @param {{ release: string, downgradeFloor: string, eeJson: { capabilities?: string[] } }} input
 * @returns {{ release: string, downgradeFloor: string, minFrom: string, capabilities: string[] }}
 */
export function upgradeMeta({ release, downgradeFloor, eeJson }) {
  if (!RELEASE_NAME.test(release)) throw new Error(`"${release}" is not a release name (eigenenterprise-<version>-<12-hex sha>)`)
  if (!VERSION.test(downgradeFloor)) throw new Error(`the downgrade floor "${downgradeFloor}" is not a version`)
  const capabilities = eeJson.capabilities ?? []
  if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === 'string' && c.length > 0)) {
    throw new Error('ee.json capabilities must be a list of names')
  }
  return { release, downgradeFloor, minFrom: MIN_UPGRADE_FROM, capabilities }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [release, floor] = process.argv.slice(2)
  if (!release || !floor) {
    console.error('usage: node scripts/upgrade-meta.mjs <release name> <downgrade floor>')
    process.exit(2)
  }
  const eeJson = JSON.parse(readFileSync(new URL('../ee.json', import.meta.url), 'utf8'))
  process.stdout.write(JSON.stringify(upgradeMeta({ release, downgradeFloor: floor, eeJson }), null, 2) + '\n')
}
