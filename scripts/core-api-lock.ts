/**
 * `npm run contract:lock` (--write) / `npm run contract:check` (--check):
 * the core-api lock, its deprecations and the generated SDK
 * (plan/phase-upgrades.md U1, contracts/gate.ts). Runs under vite-node with
 * the vitest config (the kernel composes like the unit run: in memory, no
 * database, no network).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentContract } from '../contracts/compose'
import { DEPRECATIONS } from '../contracts/deprecations'
import { checkLock, writeLock } from '../contracts/gate'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--write')
    ? 'write'
    : null
if (mode === null) {
  console.error('usage: core-api-lock.ts --write | --check')
  process.exit(2)
}

const release = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }
).version
const input = {
  current: await currentContract(),
  deprecations: DEPRECATIONS,
  release,
  today: new Date().toISOString().slice(0, 10),
  files: {
    read: (path: string) =>
      existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null,
    write: (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    },
  },
}

const result = mode === 'check' ? checkLock(input) : writeLock(input)
const { tools, events, uiSlots, coreApi } = input.current
if (!result.ok) {
  console.error(`core-api ${coreApi}: contract:${mode} failed`)
  for (const problem of result.problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}
const breaking = result.changes.filter((c) => c.kind === 'breaking').length
console.info(
  `core-api ${coreApi}: ${tools.length} tools, ${events.length} events, ${uiSlots.length} UI slots — ` +
    (mode === 'check'
      ? 'lock and SDK current'
      : `lock and SDK written (${result.changes.length} change(s), ${breaking} breaking under ended deprecations)`),
)
// The composed boot keeps background handles (the durable harness retry); the run is done.
process.exit(0)
