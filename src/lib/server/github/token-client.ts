/**
 * Contract for the read-only GitHub client used with a fine-grained personal
 * access token (plan/github-drive.md §1, §3). S1 implements it here, next to
 * the REST client lifted out of `modules/website/github/` (shared code lives
 * under `$lib`, so the boundary rule allows every module to use it).
 *
 * Rules every implementation keeps:
 * - GET only. Any other method throws before a request is sent.
 * - Every call is conditional: pass the stored ETag, get `notModified` back
 *   on a 304 (GitHub doesn't count it against the rate limit).
 * - Paging follows the `Link` header with a hard cap that fails loudly.
 * - A request timeout; `retry-after` (secondary limits) and an exhausted
 *   primary limit surface as GitHubTokenError with the time to resume.
 * - The token never appears in an error message, a log line or a `cause`.
 */

export type Conditional<T> =
  | { notModified: true; etag: string }
  | { notModified: false; etag: string | null; data: T }

export type RateBudget = {
  remaining: number
  limit: number
  resetAt: Date
}

/** What the live check on paste learns (GET /user + response headers). */
export type TokenIdentity = {
  /** GitHub login of the token's user. */
  login: string
  /** From GitHub's token-expiration response header; null = no expiry set. */
  expiresAt: Date | null
  /** True when GitHub reports classic OAuth scopes: such tokens are refused. */
  classic: boolean
  budget: RateBudget
}

export type TokenRepo = {
  /** GitHub's numeric repo id (stable across renames). */
  id: number
  fullName: string
  owner: string
  name: string
  private: boolean
  archived: boolean
  defaultBranch: string
  description: string | null
  htmlUrl: string
  pushedAt: Date | null
}

export type TokenBranch = { name: string; headSha: string }

export type TokenCommit = {
  sha: string
  /** First line of the message. */
  subject: string
  authorName: string
  authorLogin: string | null
  date: Date
  htmlUrl: string
}

export type TokenCompare = { aheadBy: number; behindBy: number }

export type TokenPull = {
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
  createdAt: Date
  updatedAt: Date
  closedAt: Date | null
  mergedAt: Date | null
  htmlUrl: string
}

export type TokenTreeEntry = { path: string; sha: string; size: number }

export type TokenTree = {
  /** Blob entries only. */
  entries: TokenTreeEntry[]
  /** GitHub cut the recursive tree short. */
  truncated: boolean
}

export type GitHubTokenErrorKind =
  /** 401: the token is wrong, revoked or expired. */
  | 'unauthorized'
  /** 403/404 on a repo the token used to see. */
  | 'no_access'
  /** Primary or secondary rate limit; `resumeAt` says when. */
  | 'rate_limited'
  /** Timeout, network failure, 5xx. */
  | 'unavailable'
  /** A non-GET method was attempted (a bug, never sent). */
  | 'write_refused'

export type GitHubTokenError = Error & {
  readonly kind: GitHubTokenErrorKind
  readonly status: number | null
  readonly path: string
  readonly resumeAt: Date | null
}

export type GitHubTokenClient = {
  identity(): Promise<TokenIdentity>
  /** Repos the token can see (GET /user/repos, all pages). */
  repos(): Promise<TokenRepo[]>
  repo(fullName: string, etag: string | null): Promise<Conditional<TokenRepo>>
  branches(fullName: string, etag: string | null): Promise<Conditional<TokenBranch[]>>
  /** Commits reachable from `branch` since `since`, newest first, at most `limit`. */
  commits(fullName: string, branch: string, since: Date, limit: number): Promise<TokenCommit[]>
  compare(fullName: string, base: string, head: string): Promise<TokenCompare>
  /** All states, sorted by updated desc; stops at the first one updated before `updatedSince`. */
  pulls(fullName: string, updatedSince: Date, etag: string | null): Promise<Conditional<TokenPull[]>>
  tree(fullName: string, commitSha: string): Promise<TokenTree>
  /** A blob's bytes decoded as UTF-8. */
  blobText(fullName: string, blobSha: string): Promise<string>
  /** The budget seen on the last response; null before the first call. */
  lastBudget(): RateBudget | null
}
