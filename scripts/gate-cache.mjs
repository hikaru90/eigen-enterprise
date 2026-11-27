#!/usr/bin/env node
// Content-keyed result cache for the gate steps (scripts/gate-step.sh --cache).
//
//   node scripts/gate-cache.mjs key --gate <g> --step <s> [--extra <text>] -- <command …>
//       prints the step's input hash
//   node scripts/gate-cache.mjs lookup <key>
//       exit 0 + prints "cached: green on <key> at <time> (commit <c>)" when that key ran green, else exit 1
//   node scripts/gate-cache.mjs record <key> --gate <g> --step <s>
//       records a green run of <key>
//
// The key covers everything a step can read, conservatively (a miss only costs time; a wrong hit
// ships a red tree):
//   - the working tree as the gate checks it: tracked files, dirty edits and untracked
//     non-ignored files (a throwaway index, `git add -A`, `git write-tree`);
//   - the gitignored inputs the steps read: every .env / .env.* at the repo root (vite, vitest and
//     playwright load them) and node_modules/.package-lock.json (what npm actually installed);
//   - node's version, platform and arch;
//   - the environment variables that configure the steps (ENV_PREFIXES below);
//   - the gate, the step name, the exact command, and --extra (tag-gate passes the release tags
//     the upgrade rehearsal picks its previous stable release from).
// Excluded: plan/** — owner/agent prose no step except lint reads (lint keeps it: eslint runs on `.`).
// Entries live in <git common dir>/ee-gate/test-cache/<key>.json, shared by every worktree.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ENV_PREFIXES = [
  'EE_',
  'PG',
  'DATABASE',
  'NODE_',
  'CI',
  'VITE_',
  'VITEST',
  'PW_',
  'PLAYWRIGHT',
  'E2E_',
  'MOCK_',
  'PUBLIC_',
  'PRIVATE_',
  'TZ',
  'LANG',
  'LC_',
]
// Bookkeeping of the gate itself, not inputs of a step.
const ENV_IGNORED = new Set(['EE_GATE_RUN', 'EE_GATE_NO_CACHE'])
// Steps that read plan/** (eslint lints the whole repo).
const READS_PLAN = new Set(['lint'])

const cleanEnv = () => {
  const env = { ...process.env }
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_PREFIX']) delete env[k]
  return env
}
const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', env: cleanEnv(), ...opts }).trim()

export function cacheDir() {
  return join(
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    'ee-gate',
    'test-cache',
  )
}

/** The tree id of the working tree as the gate sees it, without touching the real index. */
export function worktreeTree({ excludePlan }) {
  const root = git(['rev-parse', '--show-toplevel'])
  const tmp = mkdtempSync(join(tmpdir(), 'ee-gate-index-'))
  const index = join(tmp, 'index')
  try {
    // Start from the real index so `git add -A` can reuse its stat cache (only changed files are hashed).
    const real = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    if (existsSync(real)) copyFileSync(real, index)
    const env = { ...cleanEnv(), GIT_INDEX_FILE: index }
    git(['add', '-A', '--', '.'], { cwd: root, env })
    if (excludePlan)
      git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', 'plan'], { cwd: root, env })
    return git(['write-tree'], { cwd: root, env })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function ignoredInputs(root) {
  const files = readdirSync(root)
    .filter((f) => f === '.env' || f.startsWith('.env.'))
    .filter((f) => statSync(join(root, f)).isFile())
    .sort()
  files.push('node_modules/.package-lock.json')
  return files.map((f) => {
    const p = join(root, f)
    return [
      f,
      existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'absent',
    ]
  })
}

export function stepKey({ gate, step, command, extra = '' }) {
  const root = git(['rev-parse', '--show-toplevel'])
  const env = Object.keys(process.env)
    .filter((k) => !ENV_IGNORED.has(k) && ENV_PREFIXES.some((p) => k.startsWith(p)))
    .sort()
    .map((k) => [k, process.env[k]])
  const material = {
    v: 1,
    gate,
    step,
    command,
    extra,
    tree: worktreeTree({ excludePlan: !READS_PLAN.has(step) }),
    ignored: ignoredInputs(root),
    node: [process.version, process.platform, process.arch],
    env,
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

const entryFile = (key) => {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`gate-cache: not a key: ${key}`)
  return join(cacheDir(), `${key}.json`)
}

export function lookup(key) {
  const f = entryFile(key)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}

export function record(key, { gate, step }) {
  mkdirSync(cacheDir(), { recursive: true })
  const commit = git(['rev-parse', '--short=12', 'HEAD'])
  const entry = { key, gate, step, commit, at: new Date().toISOString() }
  writeFileSync(entryFile(key), JSON.stringify(entry) + '\n')
  return entry
}

function main(argv) {
  const [cmd, ...rest] = argv
  const dd = rest.indexOf('--')
  const opts = dd === -1 ? rest : rest.slice(0, dd)
  const opt = (name) => {
    const i = opts.indexOf(name)
    if (i === -1) return undefined
    const v = opts[i + 1]
    if (v === undefined) throw new Error(`gate-cache: ${name} needs a value`)
    return v
  }
  const need = (name) =>
    opt(name) ??
    (() => {
      throw new Error(`gate-cache: ${name} is required`)
    })()
  if (cmd === 'key') {
    if (dd === -1 || dd === rest.length - 1) throw new Error('gate-cache key: needs -- <command …>')
    console.log(
      stepKey({
        gate: need('--gate'),
        step: need('--step'),
        extra: opt('--extra') ?? '',
        command: rest.slice(dd + 1),
      }),
    )
    return 0
  }
  if (cmd === 'lookup') {
    const e = lookup(rest[0] ?? '')
    if (!e) return 1
    console.log(`cached: green on ${e.key.slice(0, 12)} at ${e.at} (commit ${e.commit})`)
    return 0
  }
  if (cmd === 'record') {
    record(rest[0] ?? '', { gate: need('--gate'), step: need('--step') })
    return 0
  }
  throw new Error('usage: gate-cache.mjs key|lookup|record …')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exit(main(process.argv.slice(2)))
