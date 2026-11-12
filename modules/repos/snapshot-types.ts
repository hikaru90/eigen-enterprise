/**
 * What one sync learned about a repo (plan/github-drive.md §3). Plain JSON
 * (dates as ISO strings) so it can be stored in `repo_sources.snapshot` and
 * rendered again when GitHub answers 304. Doc texts are never stored: they
 * ride along only for the run that fetched them.
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

export type DocSnap = {
  path: string
  sha: string
  size: number
  /** The text, only when it was fetched in this run (its sha changed). */
  text?: string
}

export type NotCopied = { path: string; size: number; reason: 'file_size' | 'file_count' | 'total_size' }

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
  docs: {
    /** The default-branch commit the docs were read at. */
    commitSha: string | null
    copied: DocSnap[]
    notCopied: NotCopied[]
    truncated: boolean
  }
}

/** The assistant's "What's going on" (S4 writes it; S3 renders a placeholder without it). */
export type RepoSummary = {
  summary: string
  highlights: Array<{ kind: string; text: string; ref: string | null }>
  writtenAt: string
}
