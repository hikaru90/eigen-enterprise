import type { BranchSnap, CommitLite, CopyMode, FileSnap, NotCopied, PendingSnapshot, PullSnap, RepoSnapshot, TreePlan, TreeSnap } from './snapshot-types'
import type { GitHubTokenClient, TokenCommit, TokenPull, TokenRepo } from '$lib/server/github/token-client'
import { extensionOf, MIME_BY_EXT } from './mime'
import { isDriveName } from './names'

/**
 * One sync's reads from GitHub (plan/github-drive.md §3,
 * plan/github-drive-full-mirror.md §3): conditional where the client allows it
 * (repo, branches, pulls), commits only for branches whose head moved, compare
 * only for branches active in the window, the tree only when the default head
 * or the copy mode moved. File bytes are fetched by the sync (sync.ts), not
 * here: the tarball path has to stream them straight into Drive, one file at a
 * time. Below 500 remaining requests the run stops with RatePause and resumes
 * after GitHub's reset.
 */

/** The full-mirror limits (plan/github-drive-full-mirror.md §2.4), replacing DOC_LIMITS. */
export const FILE_LIMITS = { files: 50_000, fileBytes: 20 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024 } as const
/** Up to this many changed blobs are fetched one by one; more (or a first sync, or a truncated tree) takes the tarball. */
export const SMALL_BLOB_LIMIT = 50
/**
 * Files the tarball lacks or serves differently from the tree (.gitattributes
 * export-ignore, export-subst, eol filters) are fetched one by one, at most
 * this many per sync; the rest are listed as `archive_filtered` and retried
 * on the next sync.
 */
export const MAX_ARCHIVE_RECOVERIES = 2_000
export const BUDGET_FLOOR = 500
export const COMMITS_PER_BRANCH = 100
const WINDOW_MS = 30 * 86_400_000

export class RatePause extends Error {
  constructor(readonly resumeAt: Date) {
    super(`GitHub rate limit: paused until ${resumeAt.toISOString()}`)
    this.name = 'RatePause'
  }
}

/** The rate guard shared by every GitHub request, the tarball and per-blob fetches included. */
export function guardOf(client: GitHubTokenClient): () => void {
  return () => {
    const b = client.lastBudget()
    if (b && b.remaining < BUDGET_FLOOR) throw new RatePause(b.resetAt)
  }
}

export type SyncState = {
  fullName: string
  etags: Record<string, string>
  branchHeads: Record<string, string>
  copyMode: CopyMode
  /** The stored file rows (repo_source_files): what the last sync copied, per path. */
  storedFiles: FileSnap[]
  /** A snapshot from before the full mirror may still carry `docs` instead of `tree`; guards treat that as "no tree". */
  snapshot: RepoSnapshot | null
}

export type SnapshotResult = {
  snapshot: PendingSnapshot
  /**
   * The plan when the tree must be (re)read: the default head or the copy mode
   * moved, or there is no stored tree yet. Null when neither moved — then the
   * caller only reconciles Drive against the stored file rows.
   */
  tree: TreePlan | null
  etags: Record<string, string>
  branchHeads: Record<string, string>
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

/**
 * A tree entry as the picker needs it: the tree API's shape (mode included,
 * size null for submodules) or a truncated-tree fallback listing from the
 * tarball (path and size only, regular files only).
 */
export type PickableEntry = { path: string; size: number | null; sha?: string; mode?: string }

/** A path segment Drive can't hold as a name (Drive's own checkName rule, see names.ts). */
const badSegment = (s: string) => !isDriveName(s)

/**
 * Applies the copy mode and the full-mirror limits (§2.4, §2.5): shallow paths
 * first, so the root files always make it. Submodules (mode 160000), symlinks
 * (mode 120000) and names Drive can't hold are listed as not copied; a Git LFS
 * pointer is only recognisable from its bytes, so the sync appends those while
 * fetching. Everything in `copied` has a real size.
 */
export function pickFiles<T extends PickableEntry>(entries: T[], mode: CopyMode): { copied: Array<T & { size: number }>; notCopied: NotCopied[] } {
  const depth = (p: string) => p.split('/').length
  const inScope = mode === 'all' ? () => true : (e: T) => isDoc(e.path)
  const ordered = entries.filter(inScope).sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
  const copied: Array<T & { size: number }> = []
  const notCopied: NotCopied[] = []
  let total = 0
  for (const e of ordered) {
    if (e.mode === '160000') notCopied.push({ path: e.path, size: e.size ?? 0, reason: 'submodule', ...(e.sha ? { sha: e.sha } : {}) })
    else if (e.mode === '120000') notCopied.push({ path: e.path, size: e.size ?? 0, reason: 'symlink' })
    else if (e.size === null) throw new Error(`repos: tree entry "${e.path}" has no size outside submodule entries; refusing to guess`)
    else if (e.path.split('/').some(badSegment)) notCopied.push({ path: e.path, size: e.size, reason: 'name' })
    else if (e.size > FILE_LIMITS.fileBytes) notCopied.push({ path: e.path, size: e.size, reason: 'file_size' })
    else if (copied.length >= FILE_LIMITS.files) notCopied.push({ path: e.path, size: e.size, reason: 'file_count' })
    else if (total + e.size > FILE_LIMITS.totalBytes) notCopied.push({ path: e.path, size: e.size, reason: 'total_size' })
    else {
      // The branch above proved e.size is a number; the generic can't express that narrowing.
      copied.push(e as T & { size: number })
      total += e.size
    }
  }
  return { copied, notCopied }
}

const LFS_POINTER_FIRST_LINE = 'version https://git-lfs.github.com/spec/v1\n'

/**
 * A Git LFS pointer file, by the pointer format's fixed first line (format
 * parsing, not meaning — plan §2.5).
 */
export function isLfsPointer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < LFS_POINTER_FIRST_LINE.length) return false
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, LFS_POINTER_FIRST_LINE.length))
  return head === LFS_POINTER_FIRST_LINE
}

/**
 * The MIME type a copied file is written with (§2.8 — a byte-format check,
 * never a semantic one): Drive's extension table first (copied in mime.ts);
 * with no entry, text that decodes as strict UTF-8 is `text/plain;
 * charset=utf-8` (code previews, drive.read), anything else
 * `application/octet-stream`.
 */
export function mimeForFile(name: string, bytes: Uint8Array): string {
  const byExt = MIME_BY_EXT[extensionOf(name)]
  if (byExt) return byExt
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'text/plain; charset=utf-8'
  } catch {
    return 'application/octet-stream'
  }
}

/**
 * The 30-day fetch (recently merged/closed) plus every open PR, however long
 * ago it was updated. A PR in both lists keeps its most recently updated copy;
 * newest updated first, as GitHub sorts the 30-day list.
 */
export function mergePulls(recent: PullSnap[], open: PullSnap[]): PullSnap[] {
  const byNumber = new Map<number, PullSnap>()
  for (const x of [...recent, ...open]) {
    const cur = byNumber.get(x.number)
    if (!cur || x.updatedAt > cur.updatedAt) byNumber.set(x.number, x)
  }
  return [...byNumber.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number)
}

/** A snapshot stored before migration 0161 has `docs` and no `tree`: read as "no tree". */
export function treeOf(snapshot: RepoSnapshot | null): TreeSnap | null {
  return snapshot?.tree ?? null
}

export async function takeSnapshot(client: GitHubTokenClient, state: SyncState, now: Date): Promise<SnapshotResult> {
  const prev = state.snapshot
  // Without a previous snapshot a 304 would leave nothing to render: fetch everything.
  const etag = (k: string) => (prev ? (state.etags[k] ?? null) : null)
  const guard = guardOf(client)
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
  const recentPulls = p.notModified ? prev!.pulls.filter((x) => x.updatedAt >= sinceIso) : p.data.map(pullSnap)

  guard()
  const o = await client.openPulls(fullName, etag('openPulls'))
  keep('openPulls', o.etag)
  const open = o.notModified ? prev!.pulls.filter((x) => x.state === 'open') : o.data.map(pullSnap)
  const pulls = mergePulls(recentPulls, open)

  const prevTree = treeOf(prev)
  let tree: TreePlan | null = null
  let treeSnap: TreeSnap | null
  if (defaultHead === null) {
    treeSnap = { commitSha: null, mode: state.copyMode, count: 0, bytes: 0, notCopied: [], truncated: false }
  } else if (
    prevTree !== null &&
    prevTree.commitSha === defaultHead &&
    prevTree.mode === state.copyMode &&
    (state.storedFiles.length > 0 || prevTree.count === 0) &&
    !prevTree.notCopied.some((n) => n.reason === 'archive_filtered')
  ) {
    // Neither the head nor the copy mode moved, the stored rows are there and
    // nothing waits for a retry: keep the tree as it stands (the caller
    // reconciles Drive against the rows). Files left out as archive_filtered
    // have no row, so re-reading the tree makes them "changed" again.
    treeSnap = { ...prevTree }
  } else {
    guard()
    const treeResp = await client.tree(fullName, defaultHead)
    const picked = pickFiles(treeResp.entries, state.copyMode)
    const stored = new Map(state.storedFiles.map((f) => [f.path, f.sha]))
    // A Git LFS pointer the last sync already detected (by sha) is skipped
    // again without a refetch; its not-copied line is carried forward.
    const prevLfs = new Map((prevTree?.notCopied ?? []).filter((n) => n.reason === 'lfs' && n.sha).map((n) => [n.path, n.sha!]))
    const stillLfs = picked.copied.filter((e) => prevLfs.get(e.path) === e.sha)
    const changed = picked.copied
      .filter((e) => stored.get(e.path) !== e.sha && prevLfs.get(e.path) !== e.sha)
      .map((e) => ({ path: e.path, sha: e.sha, size: e.size }))
    const pickedPaths = new Set(picked.copied.map((e) => e.path))
    const gone = state.storedFiles.filter((f) => !pickedPaths.has(f.path)).map((f) => f.path)
    // A first sync (or the upgrade from doc_shas) has no stored rows: the tarball is one request against thousands.
    const firstSync = state.storedFiles.length === 0 && picked.copied.length > 0
    tree = {
      commitSha: defaultHead,
      mode: state.copyMode,
      // A known LFS pointer is listed (notCopied), not copied: it never counts as picked.
      picked: picked.copied.filter((e) => prevLfs.get(e.path) !== e.sha).map((e) => ({ path: e.path, sha: e.sha, size: e.size })),
      changed,
      gone,
      notCopied: [...picked.notCopied, ...stillLfs.map((e) => ({ path: e.path, size: e.size, reason: 'lfs' as const, sha: e.sha }))],
      truncated: treeResp.truncated,
      viaTarball: treeResp.truncated || changed.length > SMALL_BLOB_LIMIT || firstSync,
    }
    treeSnap = null // the sync finalises it once the bytes are in Drive
  }

  const snapshot: PendingSnapshot = { takenAt: iso(now), repo, branches, pulls, tree: treeSnap }
  return {
    snapshot,
    etags,
    branchHeads: Object.fromEntries(heads.map((h) => [h.name, h.headSha])),
    tree,
  }
}
