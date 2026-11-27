#!/usr/bin/env node
/**
 * `npm run lint`: `eslint .` with a lint cache shared by every checkout of
 * this repo (main checkout, .claude/worktrees/*, release worktrees).
 *
 * ESLint's cache (file-entry-cache 8 / flat-cache 4) keys entries on the
 * file's absolute path and hands a hit back as-is, `filePath` included, so a
 * cache written in one checkout never hits in another. This wrapper keeps one
 * repo-relative copy in `$(git rev-parse --git-common-dir)/ee-gate/eslint-cache/`
 * and maps it to this checkout's absolute paths around the eslint run:
 *
 *   1. seed: shared (relative) → a private ESLint cache file (absolute paths
 *      of this checkout);
 *   2. run `eslint . --cache --cache-strategy content` on that file;
 *   3. store: the file ESLint wrote → relative → merged into the shared copy
 *      (write to a temp file + rename, so a concurrent reader never sees half).
 *
 * Validity is unchanged: ESLint still checks every entry against the file's
 * content hash and the hash of its resolved config (ESLint + Node version,
 * rules, plugins, parser options incl. the svelte.config.js hash — see
 * eslint.config.js). Entries whose result mentions the checkout's own path
 * anywhere but `filePath` are not shared (they'd point at the wrong tree).
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const FORMAT = 1

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`lint: git ${args.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

/** flat-cache exactly as ESLint resolves it (eslint → file-entry-cache → flat-cache). */
export function loadFlatCache(root) {
  const fromRoot = createRequire(path.join(root, 'package.json'))
  const fromEslint = createRequire(fromRoot.resolve('eslint/package.json'))
  const fromFec = createRequire(fromEslint.resolve('file-entry-cache/package.json'))
  return fromFec('flat-cache')
}

/** Absolute-keyed ESLint entries → repo-relative entries (only files under root). */
export function toShared(entries, root) {
  const prefix = root + path.sep
  const out = {}
  for (const [abs, meta] of Object.entries(entries)) {
    if (!abs.startsWith(prefix) || !meta?.hash || !meta.results) continue
    const rel = abs.slice(prefix.length)
    const { filePath, ...rest } = meta.results
    if (filePath !== abs) continue
    if (JSON.stringify(rest).includes(root)) continue
    out[rel] = { ...meta, results: { ...rest, filePath: rel } }
  }
  return out
}

/** Repo-relative shared entries → this checkout's absolute-keyed ESLint entries. */
export function fromShared(entries, root) {
  const out = {}
  for (const [rel, meta] of Object.entries(entries)) {
    if (path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
      throw new Error(`lint: shared cache has a non-relative key: ${rel}`)
    }
    const abs = path.join(root, rel)
    out[abs] = { ...meta, results: { ...meta.results, filePath: abs } }
  }
  return out
}

function readShared(flatCache, dir) {
  const c = flatCache.load('cache.json', dir)
  const all = c.all()
  if (Object.keys(all).length === 0) return {}
  if (all.format !== FORMAT || typeof all.entries !== 'object') {
    throw new Error(`lint: ${path.join(dir, 'cache.json')} is not format ${FORMAT}; delete it`)
  }
  return all.entries
}

function writeShared(flatCache, dir, entries) {
  const tmpId = `cache.json.${process.pid}.tmp`
  const c = flatCache.create(tmpId, dir)
  c.setKey('format', FORMAT)
  c.setKey('entries', entries)
  c.save(true)
  renameSync(path.join(dir, tmpId), path.join(dir, 'cache.json'))
}

function main() {
  const root = git(['rev-parse', '--show-toplevel'], process.cwd())
  const common = path.resolve(root, git(['rev-parse', '--git-common-dir'], root))
  const sharedDir = path.join(common, 'ee-gate', 'eslint-cache')
  mkdirSync(sharedDir, { recursive: true })
  const flatCache = loadFlatCache(root)

  const workDir = mkdtempSync(path.join(tmpdir(), 'ee-lint-'))
  try {
    const local = flatCache.create('eslintcache', workDir)
    for (const [k, v] of Object.entries(fromShared(readShared(flatCache, sharedDir), root)))
      local.setKey(k, v)
    local.save(true)

    const eslintBin = path.join(
      path.dirname(createRequire(path.join(root, 'package.json')).resolve('eslint/package.json')),
      'bin',
      'eslint.js',
    )
    const cacheFile = path.join(workDir, 'eslintcache')
    const r = spawnSync(
      process.execPath,
      [
        eslintBin,
        '.',
        '--cache',
        '--cache-strategy',
        'content',
        '--cache-location',
        cacheFile,
        ...process.argv.slice(2),
      ],
      { cwd: root, stdio: 'inherit' },
    )
    if (r.error) throw r.error

    const written = flatCache.load('eslintcache', workDir).all()
    const merged = { ...readShared(flatCache, sharedDir), ...toShared(written, root) }
    writeShared(flatCache, sharedDir, merged)
    process.exitCode = r.status ?? 1
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
