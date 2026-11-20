/**
 * What one sync learned about a repo (plan/github-drive.md §3,
 * plan/github-drive-full-mirror.md §3). Plain JSON (dates as ISO strings) so it
 * can be stored in `repo_sources.snapshot` and rendered again when GitHub
 * answers 304. File contents never ride along: the copied file list lives in
 * `repo_source_files`, and bytes only exist inside the run that fetched them.
 */

export type CommitLite = {
  sha: string
  subject: string
  authorName: string
  authorLogin: string | null
  date: string
  htmlUrl: string
}

export type BranchSnap = {
  name: string
  headSha: string
  /** The head commit; null only when GitHub returned no commit for the branch. */
  lastCommit: CommitLite | null
  /** Commits of the last 30 days (newest first, at most 100) as of the last time the head moved. */
  recent: CommitLite[]
  /** Against the default branch; null for the default branch and branches with no recent commits. */
  aheadBy: number | null
  behindBy: number | null
}

export type PullSnap = {
  number: number
  title: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  authorLogin: string | null
  headRef: string
  baseRef: string
  labels: string[]
  requestedReviewers: string[]
  body: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  mergedAt: string | null
  htmlUrl: string
}

/** Which files a repo copies from its default branch (the per-repo setting, §1). */
export type CopyMode = 'all' | 'docs'

/** One file of the default branch the sync copies: path, git blob sha and size. */
export type FileSnap = {
  path: string
  sha: string
  size: number
}

export type NotCopiedReason =
  | 'file_size'
  | 'file_count'
  | 'total_size'
  /** A path segment Drive can't hold (contains `\`, longer than 255, `.` or `..`). */
  | 'name'
  /** A gitlink (tree entry of type commit); `sha` is the pinned commit. */
  | 'submodule'
  /** Tree entry mode 120000. */
  | 'symlink'
  /** A Git LFS pointer file, detected by the pointer format's fixed first line. */
  | 'lfs'

export type NotCopied = {
  path: string
  size: number
  reason: NotCopiedReason
  /**
   * The pinned commit for submodule entries (shown as `path → <sha>`), or the
   * pointer blob's sha for Git LFS skips, so the next sync recognises them
   * again without refetching.
   */
  sha?: string
}

/**
 * What the snapshot keeps about the copied tree: counts and the not-copied
 * list, never the file list (that is `repo_source_files`).
 */
export type TreeSnap = {
  /** The default-branch commit the files were read at. */
  commitSha: string | null
  mode: CopyMode
  /** How many files were copied. */
  count: number
  /** Total size of the copied files. */
  bytes: number
  notCopied: NotCopied[]
  /** GitHub cut the recursive tree short; the tarball's own listing stood in. */
  truncated: boolean
}

export type RepoSnapshot = {
  /** When the snapshot was taken: the 30/90-day windows are measured from here. */
  takenAt: string
  repo: {
    id: number
    fullName: string
    owner: string
    name: string
    description: string | null
    htmlUrl: string
    defaultBranch: string
    pushedAt: string | null
    archived: boolean
    private: boolean
  }
  branches: BranchSnap[]
  pulls: PullSnap[]
  tree: TreeSnap
}

/**
 * A snapshot whose tree section is not final yet: the counts are only known
 * after the file fetch (a Git LFS pointer is only recognisable from its
 * bytes). `tree` is null when there is nothing to do for it.
 */
export type PendingSnapshot = Omit<RepoSnapshot, 'tree'> & { tree: TreeSnap | null }

/**
 * What the sync has to do for the tree after a snapshot: which files the pick
 * kept, which must be fetched (their stored sha differs or they are new),
 * which stored paths are gone, and whether the bytes come from per-blob
 * fetches or the tarball (many changes, a first sync, or a truncated tree).
 */
export type TreePlan = {
  commitSha: string
  mode: CopyMode
  /** The picked entries, limits and static skips applied. */
  picked: FileSnap[]
  /** Picked entries whose stored sha differs or is missing: fetch their bytes. */
  changed: FileSnap[]
  /** Stored paths the pick no longer contains: delete from Drive and repo_source_files. */
  gone: string[]
  notCopied: NotCopied[]
  truncated: boolean
  viaTarball: boolean
}

export const HIGHLIGHT_KINDS = ['branch', 'pr', 'commit', 'release', 'other'] as const
export type HighlightKind = (typeof HIGHLIGHT_KINDS)[number]

/** The assistant's "What's going on": one gateway call after a sync that found changes. */
export type RepoSummary = {
  summary: string
  highlights: Array<{ kind: HighlightKind; text: string; ref: string | null }>
  writtenAt: string
}

/**
 * Why the latest attempt wrote no summary. With a kept summary it is stale.
 * - no_model: the company has no AI model selected, so no call was made.
 * - failed: the call or its answer failed (the message is plain, never the provider's text).
 */
export type SummaryProblem = { kind: 'no_model' | 'failed'; message: string; at: string }

/** What Overview.md shows under "What's going on". */
export type SummaryState = { summary: RepoSummary | null; problem: SummaryProblem | null }
