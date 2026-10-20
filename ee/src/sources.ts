import { loadDeployKey, withDeployKey } from './deploy-keys.ts'
import { PATHS } from './paths.ts'
import type { SecretStore } from './secret-store.ts'
import { mustRun, type RunResult, type System } from './system.ts'

/**
 * Local git mirrors (D12): ee builds only from local git. A source provider
 * (the GitHub module) asks ee to fetch, either over https (public, or with a
 * short-lived token used for that one fetch via an http.extraHeader, never
 * written to disk) or over ssh with a deploy key ee holds sealed (written to a
 * 0600 temp file for that one fetch, pinned GitHub host keys).
 */
export type FetchInput = { name: string; url: string; ref: string; token?: string; deployKeyId?: string }

const SSH_URL = /^git@github\.com:([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\.git$/

export async function fetchSource(sys: System, i: FetchInput, keys?: Pick<SecretStore, 'all'>): Promise<string> {
  const mirror = `${PATHS.company}/sources/${i.name}.git`
  // No --prune: with one explicit refspec and a URL (not a named remote), git
  // prunes the very ref it fetches on every second run, leaving the mirror
  // without the branch (deploys failed "unknown revision" every other time).
  const fetchArgs = ['-C', mirror, 'fetch', '--quiet', '--no-tags', i.url, `+${i.ref}:refs/remotes/origin/${i.ref}`]

  let run: () => Promise<RunResult>
  if (i.deployKeyId !== undefined) {
    if (i.token !== undefined) throw new Error('a fetch uses either a token or a deploy key, not both')
    const m = SSH_URL.exec(i.url)
    if (!m) throw new Error(`a deploy-key fetch needs git@github.com:owner/repo.git, got ${i.url}`)
    if (!keys) throw new Error('a deploy-key fetch needs the secret store')
    const key = loadDeployKey(keys, i.deployKeyId, m[1]!)
    run = () => withDeployKey(sys, key, (env) => sys.run('git', fetchArgs, { env, timeoutMs: 300_000 }))
  } else {
    if (!i.url.startsWith('https://')) throw new Error(`an https fetch needs an https:// url, got ${i.url}`)
    const auth = i.token
      ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${i.token}`).toString('base64')}`]
      : []
    run = () => sys.run('git', [...auth, ...fetchArgs], { timeoutMs: 300_000 })
  }

  if (!(await sys.exists(mirror))) {
    await mustRun(sys, 'git', ['init', '-q', '--bare', mirror])
  }
  const r = await run()
  if (r.code !== 0) {
    // Never echo the auth header back.
    const detail = (r.stderr || r.stdout).replace(/Authorization: Basic [A-Za-z0-9+/=]+/g, 'Authorization: [redacted]')
    throw new Error(`git fetch ${i.url} ${i.ref} failed: ${detail.trim().slice(-1000)}`)
  }
  return (await mustRun(sys, 'git', ['-C', mirror, 'rev-parse', `refs/remotes/origin/${i.ref}`])).trim()
}

/**
 * Bounded reads of a mirror at a pinned rev (for the dashboard's build-form
 * suggestion): a file list and single text files. Private repos are only
 * readable here, since the deploy keys live in ee. Never the network.
 */
export class SourceReadError extends Error {
  constructor(
    readonly status: 400 | 404 | 413 | 415,
    message: string,
  ) {
    super(message)
  }
}

export const TREE_MAX_DEPTH = 4
export const TREE_MAX_ENTRIES = 2000
export const FILE_MAX_BYTES = 64 * 1024

export type TreeEntry = { path: string; type: 'blob' | 'tree'; size: number | null }

async function mirrorPath(sys: System, name: string): Promise<string> {
  const mirror = `${PATHS.company}/sources/${name}.git`
  if (!(await sys.exists(mirror))) throw new SourceReadError(404, `no mirror ${name}`)
  return mirror
}

/** One `ls-tree --long` line: "<mode> <type> <sha> <size>\t<path>". */
function parseLong(line: string): { mode: string; type: string; size: number | null; path: string } | null {
  const tab = line.indexOf('\t')
  if (tab < 0) return null
  const [mode, type, , size] = line.slice(0, tab).trim().split(/\s+/)
  if (!mode || !type) return null
  return { mode, type, size: size === undefined || size === '-' ? null : Number(size), path: line.slice(tab + 1) }
}

export async function readTree(sys: System, name: string, rev: string, depth: number): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const mirror = await mirrorPath(sys, name)
  const out = await mustRun(sys, 'git', ['-C', mirror, 'ls-tree', '-r', '-t', '--long', '--full-tree', rev])
  const entries: TreeEntry[] = []
  let truncated = false
  for (const line of out.split('\n')) {
    const e = parseLong(line)
    if (!e || (e.type !== 'blob' && e.type !== 'tree')) continue
    if (e.path.split('/').length > depth) continue
    if (entries.length >= TREE_MAX_ENTRIES) {
      truncated = true
      break
    }
    entries.push({ path: e.path, type: e.type, size: e.type === 'blob' ? e.size : null })
  }
  return { entries, truncated }
}

/** Repo-relative, no traversal, no .git, no absolute or backslash paths. */
export function safeRepoPath(path: string): string {
  const segments = path.split('/')
  const bad =
    path.length === 0 ||
    path.length > 400 ||
    path.includes('\\') ||
    path.includes('\0') ||
    segments.some((s) => s === '' || s === '.' || s === '..' || s === '.git')
  if (bad) throw new SourceReadError(400, `path must be a plain path inside the repo, got ${JSON.stringify(path)}`)
  return path
}

export async function readRepoFile(sys: System, name: string, rev: string, rawPath: string): Promise<{ path: string; size: number; content: string }> {
  const path = safeRepoPath(rawPath)
  const mirror = await mirrorPath(sys, name)
  const e = parseLong((await mustRun(sys, 'git', ['-C', mirror, 'ls-tree', '--long', rev, '--', path])).split('\n')[0] ?? '')
  if (!e || e.path !== path) throw new SourceReadError(404, `no file ${path} at ${rev.slice(0, 12)}`)
  if (e.type !== 'blob' || e.mode === '120000') throw new SourceReadError(415, `${path} is not a regular file`)
  if (e.size === null || e.size > FILE_MAX_BYTES) throw new SourceReadError(413, `${path} is larger than ${FILE_MAX_BYTES} bytes`)
  const content = await mustRun(sys, 'git', ['-C', mirror, 'cat-file', 'blob', `${rev}:${path}`])
  if (content.includes('\0')) throw new SourceReadError(415, `${path} is not a text file`)
  return { path, size: e.size, content }
}
