import type { DriveSourceId, DriveSourceItem, DriveSourcePort, DriveSourceRoot } from './drive-port'
import { createHash } from 'node:crypto'
import type {
  Conditional,
  GitHubTokenClient,
  GitHubTokenError,
  GitHubTokenErrorKind,
  RateBudget,
  TokenBranch,
  TokenCommit,
  TokenCompare,
  TokenIdentity,
  TokenPull,
  TokenRepo,
  TokenTree,
} from '$lib/server/github/token-client'

/**
 * Test fakes for the two S0 contracts: a GitHub that answers the token client
 * calls from in-memory data (with ETags and a rate budget), and a Drive source
 * writer that keeps the key → item map in memory.
 */

export function tokenError(kind: GitHubTokenErrorKind, opts: { status?: number | null; path?: string; resumeAt?: Date | null } = {}): GitHubTokenError {
  return Object.assign(new Error(`GitHub ${kind}`), {
    kind,
    status: opts.status ?? null,
    path: opts.path ?? '/',
    resumeAt: opts.resumeAt ?? null,
  }) as GitHubTokenError
}

export type FakeRepoData = {
  repo: TokenRepo
  branches: TokenBranch[]
  /** Per branch, newest first. */
  commits: Record<string, TokenCommit[]>
  compare?: Record<string, TokenCompare>
  pulls: TokenPull[]
  tree?: TokenTree
  blobs?: Record<string, string>
}

const etagOf = (v: unknown) => `"${createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12)}"`

export class FakeGitHub {
  readonly repos = new Map<string, FakeRepoData>()
  /** token → identity. A token not in here answers 401. */
  readonly identities = new Map<string, Omit<TokenIdentity, 'budget'>>()
  /** token → the repo full names it can see. */
  readonly visible = new Map<string, string[]>()
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
      return Promise.resolve(run())
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
      tree: (fullName) => call('tree', fullName, () => structuredClone(data(fullName).tree ?? { entries: [], truncated: false })),
      blobText: (fullName, sha) =>
        call('blob', fullName, () => {
          const t = data(fullName).blobs?.[sha]
          if (t === undefined) throw new Error(`fake blob ${sha} missing`)
          return t
        }),
      lastBudget: () => last,
    }
  }
}

export class FakeDrivePort implements DriveSourcePort {
  readonly roots = new Map<DriveSourceId, DriveSourceRoot>()
  readonly items = new Map<string, DriveSourceItem & { name: string; content?: string }>()
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
    if (name.includes('/')) throw new Error(`folder name ${name} contains /`)
    this.requireParent(source, parentKey)
    const cur = this.items.get(this.k(source, key))
    const item = { key, kind: 'folder' as const, itemId: cur?.itemId ?? this.id('folder'), parentKey, contentSha: null, name }
    this.items.set(this.k(source, key), item)
    return item.itemId
  }
  async upsertText(source: DriveSourceId, key: string, parentKey: string | null, name: string, content: string) {
    if (name.includes('/')) throw new Error(`file name ${name} contains /`)
    this.requireParent(source, parentKey)
    const sha = createHash('sha256').update(content, 'utf8').digest('hex')
    const cur = this.items.get(this.k(source, key))
    const changed = cur?.contentSha !== sha
    if (changed) this.writes += 1
    const item = { key, kind: 'file' as const, itemId: cur?.itemId ?? this.id('file'), parentKey, contentSha: sha, name, content }
    this.items.set(this.k(source, key), item)
    return { fileId: item.itemId, changed }
  }
  async remove(source: DriveSourceId, keyPrefix: string) {
    let n = 0
    for (const [k, v] of this.items) {
      if (k.startsWith(`${source}\u0000`) && (v.key === keyPrefix || v.key.startsWith(`${keyPrefix}/`))) {
        this.items.delete(k)
        n += 1
      }
    }
    return n
  }
  async list(source: DriveSourceId) {
    return [...this.items.entries()]
      .filter(([k]) => k.startsWith(`${source}\u0000`))
      .map(([, v]) => ({ key: v.key, kind: v.kind, itemId: v.itemId, parentKey: v.parentKey, contentSha: v.contentSha }))
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

/** A small repo: main, an active feature branch, a quiet branch, two PRs and docs. */
export function sampleRepo(): FakeRepoData {
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
    tree: {
      truncated: false,
      entries: [
        { path: 'README.md', sha: 'r1', size: 20 },
        { path: 'docs/guide/intro.mdx', sha: 'g1', size: 30 },
        { path: 'src/index.ts', sha: 's1', size: 999 },
        { path: 'docs/huge.md', sha: 'h1', size: 300 * 1024 },
      ],
    },
    blobs: { r1: '# Shop\n\nHello.\n', g1: '# Intro\n' },
  }
}
