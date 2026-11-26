// Test cache, the git + file system part (scripts/test-cache/README.md).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const common = path.resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim())
/** Shared by every worktree, like the gate stamps. */
export const cacheDir = path.join(common, 'ee-gate', 'test-cache')

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

export function head() {
  return git(['rev-parse', 'HEAD']).trim()
}

/** True when nothing differs from HEAD, untracked files included: only then a green run vouches for HEAD. */
export function treeClean() {
  return git(['status', '--porcelain']).trim() === ''
}

export function isCommit(sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

/** Every file that differs between `base` and the working tree (both sides of a rename), untracked included. */
export function changedSince(base) {
  const lines = [
    ...git(['diff', '--name-only', '--no-renames', base]).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard']).split('\n'),
  ]
  return [...new Set(lines.map((l) => l.trim()).filter(Boolean))].sort()
}

export function readState(suite) {
  const file = path.join(cacheDir, `${suite}.json`)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function writeState(suite, state) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const file = path.join(cacheDir, `${suite}.json`)
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(state)}\n`)
  fs.renameSync(`${file}.tmp`, file)
}

/** One line per suite run, for `npm run gate:times`. */
export function noteSelection({ suite, base, selected, total, reason }) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const row = [process.env.EE_GATE_RUN ?? '', head().slice(0, 12), suite, base ? base.slice(0, 12) : '', selected, total, reason.replace(/\s+/g, ' ')]
  fs.appendFileSync(path.join(cacheDir, 'selections.tsv'), `${row.join('\t')}\n`)
}

export function readJsonl(dir, prefix) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
}

/** Full run for everything: EE_GATE_FULL=1 (or `npm run push -- --full …`). */
export function forcedFull() {
  return process.env.EE_GATE_FULL === '1'
}
