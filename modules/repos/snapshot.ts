import type { BranchSnap, CommitLite, DocSnap, NotCopied, PullSnap, RepoSnapshot } from './snapshot-types'
import type { GitHubTokenClient, TokenCommit, TokenPull, TokenRepo, TokenTreeEntry } from '$lib/server/github/token-client'

/**
 * One sync's reads from GitHub (plan/github-drive.md §3): conditional where
 * the client allows it (repo, branches, pulls), commits only for branches
 * whose head moved, compare only for branches active in the window, the tree
 * only when the default head moved, and a blob only when its sha changed.
 * Below 500 remaining requests the run stops with RatePause and resumes after
 * GitHub's reset.
 */

export const DOC_LIMITS = { files: 300, fileBytes: 256 * 1024, totalBytes: 10 * 1024 * 1024 } as const
export const BUDGET_FLOOR = 500
export const COMMITS_PER_BRANCH = 100
const WINDOW_MS = 30 * 86_400_000

export class RatePause extends Error {
  constructor(readonly resumeAt: Date) {
    super(`GitHub rate limit: paused until ${resumeAt.toISOString()}`)
    this.name = 'RatePause'
  }
}

export type SyncState = {
  fullName: string
  etags: Record<string, string>
  branchHeads: Record<string, string>
  docShas: Record<string, string>
  snapshot: RepoSnapshot | null
}

export type SnapshotResult = {
  snapshot: RepoSnapshot
  etags: Record<string, string>
  branchHeads: Record<string, string>
  docShas: Record<string, string>
  /** Something differs from the previous snapshot (or there was none). */
  changed: boolean
}

const iso = (d: Date) => d.toISOString()
const commitLite = (c: TokenCommit): CommitLite => ({
  sha: c.sha,
  subject: c.subject,
  authorName: c.authorName,
  authorLogin: c.authorLogin,
  date: iso(c.date),
  htmlUrl: c.htmlUrl,
})
const pullSnap = (p: TokenPull): PullSnap => ({
  ...p,
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
  closedAt: p.closedAt ? iso(p.closedAt) : null,
  mergedAt: p.mergedAt ? iso(p.mergedAt) : null,
})
const repoSnap = (r: TokenRepo): RepoSnapshot['repo'] => ({
  id: r.id,
  fullName: r.fullName,
  owner: r.owner,
  name: r.name,
  description: r.description,
  htmlUrl: r.htmlUrl,
  defaultBranch: r.defaultBranch,
  pushedAt: r.pushedAt ? iso(r.pushedAt) : null,
  archived: r.archived,
  private: r.private,
})

/** Markdown docs by file extension (a mechanical filter, like a glob). */
const isDoc = (path: string) => /\.(md|mdx)$/i.test(path)

/** Applies the doc limits: shallow paths first, so the root README always makes it. */
export function pickDocs(entries: TokenTreeEntry[]): { copied: TokenTreeEntry[]; notCopied: NotCopied[] } {
  const depth = (p: string) => p.split('/').length
  const docs = entries.filter((e) => isDoc(e.path)).sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
  const copied: TokenTreeEntry[] = []
  const notCopied: NotCopied[] = []
  let total = 0
  for (const e of docs) {
    if (e.size > DOC_LIMITS.fileBytes) notCopied.push({ path: e.path, size: e.size, reason: 'file_size' })
    else if (copied.length >= DOC_LIMITS.files) notCopied.push({ path: e.path, size: e.size, reason: 'file_count' })
    else if (total + e.size > DOC_LIMITS.totalBytes) notCopied.push({ path: e.path, size: e.size, reason: 'total_size' })
    else {
      copied.push(e)
      total += e.size
    }
  }
  return { copied, notCopied }
}

/** The snapshot without the transient doc texts (what gets stored and compared). */
export function storable(s: RepoSnapshot): RepoSnapshot {
  return { ...s, docs: { ...s.docs, copied: s.docs.copied.map(({ path, sha, size }) => ({ path, sha, size })) } }
}

export async function takeSnapshot(client: GitHubTokenClient, state: SyncState, now: Date): Promise<SnapshotResult> {
  const prev = state.snapshot
  // Without a previous snapshot a 304 would leave nothing to render: fetch everything.
  const etag = (k: string) => (prev ? (state.etags[k] ?? null) : null)
  const guard = () => {
    const b = client.lastBudget()
    if (b && b.remaining < BUDGET_FLOOR) throw new RatePause(b.resetAt)
  }
  const etags: Record<string, string> = {}
  const keep = (k: string, e: string | null) => {
    if (e) etags[k] = e
  }
  const since = new Date(now.getTime() - WINDOW_MS)
  const sinceIso = iso(since)

  guard()
  const r = await client.repo(state.fullName, etag('repo'))
  keep('repo', r.etag)
  const repo = r.notModified ? prev!.repo : repoSnap(r.data)
  const fullName = repo.fullName

  guard()
  const b = await client.branches(fullName, etag('branches'))
  keep('branches', b.etag)
  const heads = b.notModified ? prev!.branches.map((x) => ({ name: x.name, headSha: x.headSha })) : b.data

  const prevBranch = new Map((prev?.branches ?? []).map((x) => [x.name, x]))
  const moved = (name: string, head: string) => state.branchHeads[name] !== head || !prevBranch.has(name)
  const defaultHead = heads.find((h) => h.name === repo.defaultBranch)?.headSha ?? null
  const defaultMoved = defaultHead !== null && moved(repo.defaultBranch, defaultHead)

  const branches: BranchSnap[] = []
  for (const h of heads) {
    const old = prevBranch.get(h.name)
    let snap: BranchSnap
    if (old && !moved(h.name, h.headSha)) snap = { ...old }
    else {
      guard()
      const recent = (await client.commits(fullName, h.name, since, COMMITS_PER_BRANCH)).map(commitLite)
      let lastCommit = recent[0] ?? null
      if (!lastCommit) {
        guard()
        lastCommit = (await client.commits(fullName, h.name, new Date(0), 1)).map(commitLite)[0] ?? null
      }
      snap = { name: h.name, headSha: h.headSha, lastCommit, recent, aheadBy: null, behindBy: null }
    }
    const active = snap.recent.some((c) => c.date >= sinceIso)
    if (h.name === repo.defaultBranch || !active || defaultHead === null) {
      snap.aheadBy = null
      snap.behindBy = null
    } else if (!old || moved(h.name, h.headSha) || defaultMoved || snap.aheadBy === null) {
      guard()
      const c = await client.compare(fullName, repo.defaultBranch, h.name)
      snap.aheadBy = c.aheadBy
      snap.behindBy = c.behindBy
    }
    branches.push(snap)
  }

  guard()
  const p = await client.pulls(fullName, since, etag('pulls'))
  keep('pulls', p.etag)
  const pulls = p.notModified ? prev!.pulls : p.data.map(pullSnap)

  let docs: RepoSnapshot['docs']
  const docShas: Record<string, string> = {}
  if (defaultHead === null) docs = { commitSha: null, copied: [], notCopied: [], truncated: false }
  else if (prev && prev.docs.commitSha === defaultHead) {
    docs = storable(prev).docs
    for (const d of docs.copied) docShas[d.path] = d.sha
  } else {
    guard()
    const tree = await client.tree(fullName, defaultHead)
    const picked = pickDocs(tree.entries)
    const copied: DocSnap[] = []
    for (const e of picked.copied) {
      docShas[e.path] = e.sha
      if (state.docShas[e.path] === e.sha) copied.push({ path: e.path, sha: e.sha, size: e.size })
      else {
        guard()
        copied.push({ path: e.path, sha: e.sha, size: e.size, text: await client.blobText(fullName, e.sha) })
      }
    }
    docs = { commitSha: defaultHead, copied, notCopied: picked.notCopied, truncated: tree.truncated }
  }

  const snapshot: RepoSnapshot = { takenAt: iso(now), repo, branches, pulls, docs }
  const comparable = (s: RepoSnapshot) => JSON.stringify({ ...storable(s), takenAt: null })
  const changed = !prev || comparable(prev) !== comparable(snapshot) || docs.copied.some((d) => d.text !== undefined)
  return {
    snapshot,
    etags,
    branchHeads: Object.fromEntries(heads.map((h) => [h.name, h.headSha])),
    docShas,
    changed,
  }
}
