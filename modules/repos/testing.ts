import type { DriveSourceId, DriveSourceItem, DriveSourcePort, DriveSourceRoot, DriveSourceBatchItem } from './drive-port'
import type { TarballEntry, TarballHeader, TarballReader } from './tarball'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'fflate'
import { gitBlobSha } from '$lib/server/github/git'
import type {
  Conditional,
  GitHubTokenClient,
  GitHubTokenError,
  GitHubTokenErrorKind,
  RateBudget,
  TokenPermission,
  TokenBranch,
  TokenCommit,
  TokenCompare,
  TokenIdentity,
  TokenPull,
  TokenRepo,
  TokenTreeMode,
} from '$lib/server/github/token-client'

/**
 * Test fakes for the contracts: a GitHub that answers the token client calls
 * from in-memory data (with ETags, a rate budget, real gzipped tarballs and
 * per-blob bytes) and a Drive source writer that keeps the key → item map in
 * memory with a call log, so a sync can be pinned to zero tree writes.
 */

export function tokenError(
  kind: GitHubTokenErrorKind,
  opts: { status?: number | null; path?: string; resumeAt?: Date | null; permission?: TokenPermission | null } = {},
): GitHubTokenError {
  return Object.assign(new Error(`GitHub ${kind}`), {
    kind,
    status: opts.status ?? null,
    path: opts.path ?? '/',
    resumeAt: opts.resumeAt ?? null,
    permission: opts.permission ?? null,
  }) as GitHubTokenError
}

/** A tree entry exactly as the token client's listing reports it (mode included). */
export type FakeTreeEntry = { path: string; sha: string; size: number | null; mode: TokenTreeMode }

export type FakeRepoData = {
  repo: TokenRepo
  branches: TokenBranch[]
  /** Per branch, newest first. */
  commits: Record<string, TokenCommit[]>
  compare?: Record<string, TokenCompare>
  pulls: TokenPull[]
  tree?: { truncated: boolean; entries: FakeTreeEntry[] }
  /** Blob sha → bytes. Tarballs and blob fetches read from here. */
  blobs?: Record<string, Uint8Array>
  /**
   * What `.gitattributes` does to GitHub's archive (never to the tree or the
   * blob API): `exclude` leaves paths (and folders, by prefix) out
   * (export-ignore); `replace` serves other bytes for a path (export-subst,
   * eol filters).
   */
  archive?: { exclude?: string[]; replace?: Record<string, Uint8Array> }
}

const enc = new TextEncoder()
const etagOf = (v: unknown) => `"${createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12)}"`

/** A fixture file: its entry carries the real git blob sha of its bytes, so the sync's integrity check passes. */
export function fakeFile(path: string, content: string | Uint8Array, over: { mode?: TokenTreeMode; size?: number } = {}): { entry: FakeTreeEntry; bytes: Uint8Array } {
  const bytes = typeof content === 'string' ? enc.encode(content) : content
  const sha = gitBlobSha(bytes)
  return { entry: { path, sha, size: over.size ?? bytes.byteLength, mode: over.mode ?? '100644' }, bytes }
}

/** Adds (or replaces) a fixture file in tree and blobs. */
export function setFile(d: FakeRepoData, path: string, content: string | Uint8Array): void {
  const { entry, bytes } = fakeFile(path, content)
  const entries = d.tree!.entries
  const i = entries.findIndex((e) => e.path === path)
  if (i >= 0) entries.splice(i, 1)
  entries.push(entry)
  d.blobs![entry.sha] = bytes
}

/** Removes a fixture file from tree and blobs. */
export function removeFile(d: FakeRepoData, path: string): void {
  d.tree!.entries = d.tree!.entries.filter((e) => e.path !== path)
}

/** A minimal valid PNG: the signature plus junk (never valid UTF-8). */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 'I'.charCodeAt(0), 'H'.charCodeAt(0), 'D'.charCodeAt(0), 'R'.charCodeAt(0)])

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1\noid sha256:3b06e8f8b3d10a26c5a4a8a4a0b1a2c3d4e5f60718293a4b5c6d7e8f9012345\nsize 48151623\n'

export class FakeGitHub {
  readonly repos = new Map<string, FakeRepoData>()
  /** token → identity. A token not in here answers 401. */
  readonly identities = new Map<string, Omit<TokenIdentity, 'budget'>>()
  /** token → the repo full names it can see. */
  readonly visible = new Map<string, string[]>()
  /** repo full name → the permissions every token lacks on it (checkAccess). */
  readonly missing = new Map<string, TokenPermission[]>()
  budget: RateBudget = { remaining: 4900, limit: 5000, resetAt: new Date('2026-11-12T15:00:00Z') }
  /** Lowers the budget by this much on every request (to test the 500 floor). */
  costPerCall = 1
  calls: string[] = []
  /** Throw this for the next call matching the method (and repo, when given). */
  failures: Array<{ method: string; fullName?: string; error: GitHubTokenError }> = []

  addRepo(d: FakeRepoData, tokens: string[]): void {
    this.repos.set(d.repo.fullName, d)
    for (const t of tokens) this.visible.set(t, [...(this.visible.get(t) ?? []), d.repo.fullName])
  }

  client(token: string): GitHubTokenClient {
    let last: RateBudget | null = null
    const call = <T>(method: string, fullName: string | null, run: () => T): Promise<T> => {
      this.calls.push(fullName ? `${method} ${fullName}` : method)
      const i = this.failures.findIndex((f) => f.method === method && (!f.fullName || f.fullName === fullName))
      if (i >= 0) {
        const [f] = this.failures.splice(i, 1)
        return Promise.reject(f!.error)
      }
      if (!this.identities.has(token)) return Promise.reject(tokenError('unauthorized', { status: 401, path: method }))
      if (fullName && !(this.visible.get(token) ?? []).includes(fullName)) {
        return Promise.reject(tokenError('no_access', { status: 404, path: `${method} ${fullName}` }))
      }
      this.budget = { ...this.budget, remaining: this.budget.remaining - this.costPerCall }
      last = { ...this.budget }
      // A sync throw inside run() (a missing blob, a missing repo) rejects like any other failure.
      return Promise.resolve().then(run)
    }
    const data = (fullName: string) => {
      const d = this.repos.get(fullName)
      if (!d) throw tokenError('no_access', { status: 404, path: fullName })
      return d
    }
    const conditional = <T>(v: T, etag: string | null): Conditional<T> => {
      const e = etagOf(v)
      return e === etag ? { notModified: true, etag: e } : { notModified: false, etag: e, data: structuredClone(v) }
    }
    const tarballOf = (d: FakeRepoData, commitSha: string): string => {
      // A real gzipped tar archive (below): every regular file of the tree at
      // its repo path under the top folder <owner>-<repo>-<sha>/, like
      // codeload's — over-limit files included (an entry without fixture
      // bytes is served as zeros of its size). .gitattributes effects apply.
      const top = `${d.repo.owner}-${d.repo.name}-${commitSha}`
      const excluded = (p: string) => (d.archive?.exclude ?? []).some((x) => p === x || p.startsWith(`${x}/`))
      const files = (d.tree?.entries ?? [])
        .filter((e) => e.mode !== '160000' && e.mode !== '120000' && e.size !== null && !excluded(e.path))
        .map((e) => ({ path: `${top}/${e.path}`, bytes: d.archive?.replace?.[e.path] ?? d.blobs?.[e.sha] ?? new Uint8Array(e.size!) }))
      const path = join(tmpdir(), `fake-tarball-${randomUUID()}.tar.gz`)
      writeFileSync(path, writeTarGz(files))
      return path
    }
    return {
      identity: () => call('identity', null, () => ({ ...this.identities.get(token)!, budget: { ...this.budget } })),
      repos: () => call('repos', null, () => (this.visible.get(token) ?? []).map((n) => structuredClone(data(n).repo))),
      repo: (fullName, etag) => call('repo', fullName, () => conditional(data(fullName).repo, etag)),
      branches: (fullName, etag) => call('branches', fullName, () => conditional(data(fullName).branches, etag)),
      commits: (fullName, branch, since, limit) =>
        call('commits', fullName, () => (data(fullName).commits[branch] ?? []).filter((c) => c.date >= since).slice(0, limit).map((c) => structuredClone(c))),
      compare: (fullName, base, head) => call('compare', fullName, () => data(fullName).compare?.[`${base}...${head}`] ?? { aheadBy: 0, behindBy: 0 }),
      pulls: (fullName, updatedSince, etag) =>
        call('pulls', fullName, () => conditional(data(fullName).pulls.filter((p) => p.updatedAt >= updatedSince), etag)),
      openPulls: (fullName, etag) =>
        call('openPulls', fullName, () => conditional(data(fullName).pulls.filter((p) => p.state === 'open'), etag)),
      tree: (fullName) => call('tree', fullName, () => structuredClone(data(fullName).tree ?? { entries: [], truncated: false })),
      // The repos sync reads bytes only (blobBytes); a text read is a bug there.
      blobText: () => Promise.reject(new Error('the repos sync never reads blobs as text: use blobBytes')),
      blobBytes: (fullName, sha) =>
        call('blob', fullName, () => {
          const b = data(fullName).blobs?.[sha]
          if (b === undefined) throw new Error(`fake blob ${sha} missing`)
          return b.slice()
        }),
      tarball: (fullName, commitSha) => call('tarball', fullName, () => tarballOf(data(fullName), commitSha)),
      checkAccess: (fullName) => call('checkAccess', fullName, () => [...(this.missing.get(fullName) ?? [])]),
      lastBudget: () => last,
    }
  }
}

// ── a real gzipped tar archive, for the tarball path ──────────────────────────
// Test-only writer and reader (the production tar writer is
// modules/drive/tar.ts and the production reader src/lib/server/github/tar.ts;
// the module boundary keeps this fake from importing the writer). Regular
// files, ustar headers, pax `path` records for paths over 100 bytes — like
// git archive writes them — gzip through fflate.

const BLOCK = 512

const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, '0') + '\0'

function tarHeader(name: Uint8Array, size: number, type: '0' | 'x'): Uint8Array {
  if (name.byteLength > 100) throw new Error('tarHeader: name over 100 bytes (use a pax record)')
  const h = new Uint8Array(BLOCK)
  h.set(name, 0)
  h.set(enc.encode(octal(0o644, 8)), 100)
  h.set(enc.encode(octal(0, 8)), 108)
  h.set(enc.encode(octal(0, 8)), 116)
  h.set(enc.encode(octal(size, 12)), 124)
  h.set(enc.encode(octal(0, 12)), 136)
  h.set(enc.encode('        '), 148)
  h.set(enc.encode(type), 156)
  h.set(enc.encode('ustar\0'), 257)
  h.set(enc.encode('00'), 263)
  let sum = 0
  for (const b of h) sum += b
  h.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148)
  return h
}

/** One pax record, `"<len> path=<value>\n"`, where <len> counts the whole record including itself. */
function paxRecord(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`
  const bodyLen = enc.encode(body).byteLength
  let len = bodyLen + 1
  while (String(len).length + bodyLen !== len) len += 1
  return enc.encode(`${len}${body}`)
}

const pad = (n: number) => new Uint8Array((BLOCK - (n % BLOCK)) % BLOCK)

/** A gzipped tar archive of regular files, like codeload's (pax `path` records for long paths). */
export function writeTarGz(files: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const out: Uint8Array[] = []
  for (const f of files) {
    const name = enc.encode(f.path)
    if (name.byteLength > 100) {
      const pax = paxRecord('path', f.path)
      out.push(tarHeader(enc.encode('PaxHeader'), pax.byteLength, 'x'), pax, pad(pax.byteLength))
      // The ustar name field keeps a whole-character prefix (the pax record wins).
      let short = f.path.slice(0, 100)
      while (enc.encode(short).byteLength > 100) short = short.slice(0, -1)
      out.push(tarHeader(enc.encode(short), f.bytes.byteLength, '0'), f.bytes, pad(f.bytes.byteLength))
    } else {
      out.push(tarHeader(name, f.bytes.byteLength, '0'), f.bytes, pad(f.bytes.byteLength))
    }
  }
  out.push(new Uint8Array(2 * BLOCK))
  const total = out.reduce((n, b) => n + b.byteLength, 0)
  const tar = new Uint8Array(total)
  let at = 0
  for (const b of out) {
    tar.set(b, at)
    at += b.byteLength
  }
  return gzipSync(tar)
}

const field = (h: Uint8Array, from: number, len: number) => {
  const f = h.subarray(from, from + len)
  const end = f.indexOf(0)
  return new TextDecoder().decode(end === -1 ? f : f.subarray(0, end))
}

/**
 * The reader contract M1 ships (`readTarGz(path, { want })`), over the fake's
 * own archives: `want` sees each regular file's header, and only wanted
 * entries are yielded — an unwanted entry's bytes are never handed out.
 * Logs what was offered and what was yielded, so a test can pin that a
 * 21 MB file or an unchanged file is never read.
 */
export class FakeTarReader {
  /** Every regular file's path as offered to `want` (top folder included). */
  offered: string[] = []
  /** The paths whose bytes were yielded. */
  yielded: string[] = []

  readonly read: TarballReader = (filePath, opts) => this.entries(filePath, opts.want)

  private async *entries(filePath: string, want: (h: TarballHeader) => boolean): AsyncGenerator<TarballEntry, void, void> {
    const tar = gunzipSync(readFileSync(filePath))
    let at = 0
    let paxPath: string | null = null
    while (at + BLOCK <= tar.byteLength) {
      const h = tar.subarray(at, at + BLOCK)
      if (h.every((b) => b === 0)) return
      const size = parseInt(field(h, 124, 12).trim() || '0', 8)
      const type = String.fromCharCode(h[156]!)
      const body = at + BLOCK
      at = body + size + pad(size).byteLength
      if (type === 'x') {
        const text = new TextDecoder().decode(tar.subarray(body, body + size))
        for (const rec of text.split('\n')) {
          const m = /^\d+ path=(.*)$/.exec(rec)
          if (m) paxPath = m[1]!
        }
        continue
      }
      const path = paxPath ?? field(h, 0, 100)
      paxPath = null
      if (type !== '0' && type !== '\0') continue
      const header = { path, size, mode: parseInt(field(h, 100, 8).trim() || '0', 8) }
      this.offered.push(path)
      if (!want(header)) continue
      this.yielded.push(path)
      yield { path, mode: header.mode, bytes: tar.slice(body, body + size) }
    }
    throw new Error('fake tar: archive ended without the zero-block end marker')
  }
}

// ── the Drive source port ─────────────────────────────────────────────────────

/** Every port write, in order (reads and idempotent no-ops are not writes). */
export type DriveCall = { op: 'upsertFolder' | 'upsertText' | 'upsertBytes' | 'upsertMany' | 'remove'; key: string; n?: number }

/** Drive's own name rule, as modules/drive/source-writer.ts `checkName` enforces it: the fake refuses what Drive refuses. */
function checkName(name: string): void {
  if (!name || name !== name.trim() || name.length > 255 || /[/\\]/.test(name) || name === '.' || name === '..')
    throw new Error(`drive source item name refused: ${JSON.stringify(name.slice(0, 40))}`)
}

export class FakeDrivePort implements DriveSourcePort {
  /** Every list() call's prefix (undefined = the whole source). */
  lists: Array<string | undefined> = []
  /** Make the n-th upsertMany call (1-based, counting every call so far: see manyCalls) fail and roll back. */
  failManyAt: number | null = null
  manyCalls = 0
  readonly roots = new Map<DriveSourceId, DriveSourceRoot>()
  /** Not readonly: an upsertMany rollback restores the previous map wholesale. */
  items = new Map<string, DriveSourceItem & { name: string; content?: string; bytes?: Uint8Array; mime?: string }>()
  calls: DriveCall[] = []
  writes = 0
  private seq = 0

  private id(kind: string) {
    this.seq += 1
    return `${kind}-${this.seq}`
  }
  private k(source: string, key: string) {
    return `${source}\u0000${key}`
  }
  private requireParent(source: string, parentKey: string | null) {
    if (parentKey !== null && !this.items.has(this.k(source, parentKey))) throw new Error(`parent ${parentKey} missing`)
  }

  async ensureRoot(source: DriveSourceId, name: string) {
    const r = this.roots.get(source) ?? { source, folderId: this.id('root'), name }
    r.name = name
    this.roots.set(source, r)
    return { ...r }
  }

  async upsertFolder(source: DriveSourceId, key: string, parentKey: string | null, name: string) {
    checkName(name)
    this.requireParent(source, parentKey)
    const cur = this.items.get(this.k(source, key))
    if (!cur || cur.name !== name || cur.parentKey !== parentKey) this.calls.push({ op: 'upsertFolder', key })
    const item = { key, kind: 'folder' as const, itemId: cur?.itemId ?? this.id('folder'), parentKey, contentSha: null, name }
    this.items.set(this.k(source, key), item)
    return item.itemId
  }

  async upsertText(source: DriveSourceId, key: string, parentKey: string | null, name: string, content: string) {
    checkName(name)
    this.requireParent(source, parentKey)
    const sha = createHash('sha256').update(content, 'utf8').digest('hex')
    const cur = this.items.get(this.k(source, key))
    const changed = cur?.contentSha !== sha
    if (changed) {
      this.calls.push({ op: 'upsertText', key })
      this.writes += 1
    }
    const item = { key, kind: 'file' as const, itemId: cur?.itemId ?? this.id('file'), parentKey, contentSha: sha, name, content }
    this.items.set(this.k(source, key), item)
    return { fileId: item.itemId, changed }
  }

  async upsertBytes(source: DriveSourceId, key: string, parentKey: string | null, name: string, bytes: Uint8Array, mime: string) {
    checkName(name)
    this.requireParent(source, parentKey)
    const sha = createHash('sha256').update(bytes).digest('hex')
    const cur = this.items.get(this.k(source, key))
    const changed = cur?.contentSha !== sha
    if (changed) {
      this.calls.push({ op: 'upsertBytes', key })
      this.writes += 1
    }
    const item = { key, kind: 'file' as const, itemId: cur?.itemId ?? this.id('file'), parentKey, contentSha: sha, name, bytes: bytes.slice(), mime }
    this.items.set(this.k(source, key), item)
    return { fileId: item.itemId, changed }
  }

  async upsertMany(source: DriveSourceId, items: DriveSourceBatchItem[]) {
    // The port's contract: one batch, one transaction — any failure rolls back
    // the whole batch (items, ids, write counts and the call log with it).
    const backupItems = new Map(this.items)
    const backupCalls = [...this.calls]
    const backupWrites = this.writes
    const backupSeq = this.seq
    this.manyCalls += 1
    try {
      if (this.failManyAt === this.manyCalls) throw new Error(`fake drive: upsertMany #${this.manyCalls} failed`)
      for (const i of items) {
        if (i.kind === 'folder') await this.upsertFolder(source, i.key, i.parentKey, i.name)
        else if (i.kind === 'text') await this.upsertText(source, i.key, i.parentKey, i.name, i.content)
        else await this.upsertBytes(source, i.key, i.parentKey, i.name, i.bytes, i.mime)
      }
    } catch (err) {
      this.items = backupItems
      this.calls = backupCalls
      this.writes = backupWrites
      this.seq = backupSeq
      throw err
    }
    if (items.length > 0) this.calls.push({ op: 'upsertMany', key: items[0]!.key, n: items.length })
  }

  async remove(source: DriveSourceId, keyPrefix: string) {
    let n = 0
    for (const [k, v] of this.items) {
      if (k.startsWith(`${source}\u0000`) && (v.key === keyPrefix || v.key.startsWith(`${keyPrefix}/`))) {
        this.items.delete(k)
        n += 1
      }
    }
    if (n > 0) this.calls.push({ op: 'remove', key: keyPrefix, n })
    return n
  }

  async list(source: DriveSourceId, keyPrefix?: string) {
    this.lists.push(keyPrefix)
    return [...this.items.entries()]
      .filter(([k]) => k.startsWith(`${source}\u0000`))
      .map(([, v]) => v)
      .filter((v) => !keyPrefix || v.key === keyPrefix || v.key.startsWith(`${keyPrefix}/`))
      .map((v) => ({ key: v.key, kind: v.kind, itemId: v.itemId, parentKey: v.parentKey, contentSha: v.contentSha }))
  }

  /** Test helper: the file at a key. */
  file(source: string, key: string) {
    return this.items.get(this.k(source, key))
  }
  keys(source: string) {
    return [...this.items.entries()]
      .filter(([k]) => k.startsWith(`${source}\u0000`))
      .map(([, v]) => v.key)
      .sort()
  }
  /** Test helper: every write call whose key sits under `prefix`. */
  writesUnder(prefix: string): DriveCall[] {
    return this.calls.filter((c) => c.key === prefix || c.key.startsWith(`${prefix}/`))
  }
}

const T = (iso: string) => new Date(iso)

export const commit = (sha: string, subject: string, date: string, author = 'ada'): TokenCommit => ({
  sha: sha.padEnd(40, '0'),
  subject,
  authorName: author.toUpperCase(),
  authorLogin: author,
  date: T(date),
  htmlUrl: `https://github.com/kindred/shop/commit/${sha.padEnd(40, '0')}`,
})

export const pull = (over: Partial<TokenPull> & Pick<TokenPull, 'number' | 'title'>): TokenPull => ({
  state: 'open',
  merged: false,
  draft: false,
  authorLogin: 'ada',
  headRef: 'feature/cart',
  baseRef: 'main',
  labels: [],
  requestedReviewers: [],
  body: null,
  createdAt: T('2026-11-01T09:00:00Z'),
  updatedAt: T('2026-11-10T09:00:00Z'),
  closedAt: null,
  mergedAt: null,
  htmlUrl: `https://github.com/kindred/shop/pull/${over.number}`,
  ...over,
})

/**
 * A small repo: main, an active feature branch, a quiet branch, two PRs and a
 * default branch with docs, code, a PNG, a submodule, a symlink, a Git LFS
 * pointer, a path Drive can't hold and one file over the 20 MB limit — so a
 * first sync exercises every skip reason (plan/github-drive-full-mirror.md §8).
 */
export function sampleRepo(): FakeRepoData {
  const files = [
    fakeFile('README.md', '# Shop\n\nHello.\n'),
    fakeFile('docs/guide/intro.mdx', '# Intro\n'),
    fakeFile('docs/huge.md', `${'# Big\n\n'}${'x'.repeat(300 * 1024)}`),
    fakeFile('src/index.ts', 'export const shop = 1\n'),
    fakeFile('src/util/format.ts', 'export const money = (n: number) => `€${n.toFixed(2)}`\n'),
    fakeFile('package.json', '{"name":"shop","version":"1.2.0"}\n'),
    fakeFile('assets/logo.png', PNG_BYTES),
    fakeFile('assets/video.mp4', LFS_POINTER),
    fakeFile('docs/weird\\name.md', '# A path Drive cannot hold\n'),
    fakeFile('docs/top.md', '../README.md', { mode: '120000' }), // a symlink
  ]
  const entries: FakeTreeEntry[] = files.map((f) => f.entry)
  // A submodule gitlink (no size) and one file over the 20 MB per-file limit (never fetched).
  entries.push({ path: 'vendor/lib', sha: '5ub5h45h'.padEnd(40, 'f'), size: null, mode: '160000' })
  entries.push({ path: 'media/iso.bin', sha: 'f'.padEnd(40, '0'), size: 21 * 1024 * 1024, mode: '100644' })
  return {
    repo: {
      id: 4242,
      fullName: 'kindred/shop',
      owner: 'kindred',
      name: 'shop',
      private: true,
      archived: false,
      defaultBranch: 'main',
      description: 'The online shop.',
      htmlUrl: 'https://github.com/kindred/shop',
      pushedAt: T('2026-11-11T16:20:00Z'),
    },
    branches: [
      { name: 'main', headSha: 'a1'.padEnd(40, '0') },
      { name: 'feature/cart', headSha: 'b2'.padEnd(40, '0') },
      { name: 'old/spike', headSha: 'c3'.padEnd(40, '0') },
    ],
    commits: {
      main: [commit('a1', 'Release 1.2', '2026-11-11T16:20:00Z'), commit('a0', 'Fix | price rounding', '2026-11-03T10:00:00Z', 'grace')],
      'feature/cart': [commit('b2', 'Cart totals', '2026-11-10T12:00:00Z', 'grace'), commit('a0', 'Fix | price rounding', '2026-11-03T10:00:00Z', 'grace')],
      'old/spike': [commit('c3', 'Try a spike', '2026-05-01T08:00:00Z')],
    },
    compare: { 'main...feature/cart': { aheadBy: 1, behindBy: 1 } },
    pulls: [
      pull({ number: 7, title: 'Cart totals', draft: true, labels: ['cart'], requestedReviewers: ['ada'], body: 'Adds totals.\n\nCloses #3' }),
      pull({
        number: 5,
        title: 'Old checkout',
        state: 'closed',
        merged: true,
        headRef: 'checkout',
        closedAt: T('2026-11-05T10:00:00Z'),
        mergedAt: T('2026-11-05T10:00:00Z'),
      }),
    ],
    tree: { truncated: false, entries },
    blobs: Object.fromEntries(files.map((f) => [f.entry.sha, f.bytes])),
  }
}
