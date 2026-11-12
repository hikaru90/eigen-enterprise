/**
 * The read-only GitHub client for a fine-grained personal access token
 * (contract: ./token-client.ts; plan/github-drive.md §1, §3).
 *
 * What GitHub's docs say (checked 2026-11-12), and what this file relies on:
 * - Expiry: `GitHub-Authentication-Token-Expiration` is sent on API responses
 *   to a personal access token (changelog 2021-07-26). No format is documented;
 *   observed values are `YYYY-MM-DD HH:MM:SS UTC` and `YYYY-MM-DD HH:MM:SS +hhmm`
 *   (go-github parses exactly these two). No header = no expiry; anything else
 *   fails loudly.
 * - Classic: `X-OAuth-Scopes` "lists the scopes your token has authorized", an
 *   OAuth/classic concept. Its presence (even empty: a classic token with no
 *   scopes) marks a classic token. Fine-grained tokens use
 *   `X-Accepted-GitHub-Permissions` instead. Absence for fine-grained tokens is
 *   not stated in the docs; S5 confirms it with a real token.
 * - Rate limits (rate-limits-for-the-rest-api): primary and secondary limits
 *   answer 403 or 429. `x-ratelimit-remaining: 0` waits for `x-ratelimit-reset`
 *   (UTC epoch seconds); `retry-after` is seconds to wait; with neither, wait at
 *   least a minute. A 403 for a secondary limit is told apart by its
 *   `documentation_url` (#…secondary-rate-limits), a machine field.
 * - A 304 to a correctly authorised conditional request does not count against
 *   the primary limit (best-practices-for-using-the-rest-api).
 */
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
} from './token-client'

const API = 'https://api.github.com'
const PER_PAGE = 100
/** 50 pages × 100 = 5,000 items; beyond that something is wrong. */
const MAX_PAGES = 50
/** GitHub: with no retry header, wait at least a minute. */
const DEFAULT_BACKOFF_MS = 60_000

export type GitHubTokenConfig = {
  token: string
  fetch: typeof fetch
  timeoutMs: number
}

class TokenRequestError extends Error implements GitHubTokenError {
  constructor(
    readonly kind: GitHubTokenErrorKind,
    readonly status: number | null,
    readonly path: string,
    readonly resumeAt: Date | null,
    message: string,
    cause?: Error,
  ) {
    super(message, cause ? { cause } : undefined)
    this.name = 'GitHubTokenError'
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      status: this.status,
      path: this.path,
      message: this.message,
    }
  }
}

export function isGitHubTokenError(err: unknown): err is GitHubTokenError {
  return err instanceof TokenRequestError
}

type RawResponse = {
  status: number
  headers: Headers
  /** null on a 304. */
  json: unknown
  path: string
}

/** Removes the token from any text that reaches an error. */
function redact(text: string, token: string): string {
  return text.split(token).join('[redacted]')
}

/** A cause that carries GitHub's (or the runtime's) words, never the token, never the request. */
function safeCause(text: string, token: string): Error {
  return new Error(redact(text, token).slice(0, 500))
}

function budgetFrom(headers: Headers): RateBudget | null {
  const remaining = headers.get('x-ratelimit-remaining')
  const limit = headers.get('x-ratelimit-limit')
  const reset = headers.get('x-ratelimit-reset')
  if (remaining === null || limit === null || reset === null) return null
  const out = {
    remaining: Number(remaining),
    limit: Number(limit),
    resetAt: new Date(Number(reset) * 1000),
  }
  if (
    !Number.isFinite(out.remaining) ||
    !Number.isFinite(out.limit) ||
    Number.isNaN(out.resetAt.getTime())
  ) {
    throw new Error(
      `GitHub sent rate-limit headers that are not numbers (${remaining}/${limit}/${reset})`,
    )
  }
  return out
}

/** `documentation_url` of a secondary-limit 403 ends in a #…secondary-rate-limits fragment. */
function isSecondaryLimitDoc(body: unknown): boolean {
  const doc = (body as { documentation_url?: unknown } | null)?.documentation_url
  if (typeof doc !== 'string') return false
  try {
    const url = new URL(doc)
    return url.hash.endsWith('secondary-rate-limits')
  } catch {
    return false
  }
}

/** When to try again, or null if the response is not a rate limit. */
function rateLimitResume(status: number, headers: Headers, body: unknown): Date | null {
  if (status !== 403 && status !== 429) return null
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new Error(`GitHub sent a retry-after header that is not seconds (${retryAfter})`)
    }
    return new Date(Date.now() + seconds * 1000)
  }
  const reset = headers.get('x-ratelimit-reset')
  if (headers.get('x-ratelimit-remaining') === '0' && reset !== null)
    return new Date(Number(reset) * 1000)
  if (status === 429 || isSecondaryLimitDoc(body)) return new Date(Date.now() + DEFAULT_BACKOFF_MS)
  return null
}

function kindFor(status: number): GitHubTokenErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 403 || status === 404) return 'no_access'
  // 5xx, and statuses the contract has no word for (409 empty repo, 422):
  // the caller still has `status` to tell them apart.
  return 'unavailable'
}

/** `path` is relative to the API root, or an absolute `Link` URL on the API root. */
function resolve(path: string): { url: string; path: string } {
  if (path.startsWith('/')) return { url: `${API}${path}`, path }
  if (path.startsWith(`${API}/`)) return { url: path, path: path.slice(API.length) }
  throw new Error(`refusing to send the GitHub token outside ${API}: ${path.split('?')[0]}`)
}

/**
 * The one place a request is made. GET only: any other method throws
 * `write_refused` before anything is sent.
 */
export async function tokenRequest(
  config: GitHubTokenConfig,
  method: string,
  pathOrUrl: string,
  etag: string | null,
  onBudget?: (b: RateBudget) => void,
): Promise<RawResponse> {
  const { url, path } = resolve(pathOrUrl)
  if (method !== 'GET') {
    throw new TokenRequestError(
      'write_refused',
      null,
      path,
      null,
      `GitHub ${method} ${path} refused: the token client only reads`,
    )
  }
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'eigenEnterprise',
    authorization: `Bearer ${config.token}`,
  }
  if (etag !== null) headers['if-none-match'] = etag

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  let res: Response
  let text: string
  try {
    res = await config.fetch(url, { method: 'GET', headers, signal: controller.signal })
    text = res.status === 304 ? '' : await res.text()
  } catch (err) {
    const timedOut = controller.signal.aborted
    throw new TokenRequestError(
      'unavailable',
      null,
      path,
      null,
      timedOut
        ? `GitHub ${path} did not answer within ${config.timeoutMs} ms`
        : `GitHub ${path} could not be reached`,
      safeCause(err instanceof Error ? `${err.name}: ${err.message}` : String(err), config.token),
    )
  } finally {
    clearTimeout(timer)
  }

  const budget = budgetFrom(res.headers)
  if (budget) onBudget?.(budget)

  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }

  if (res.status === 304) return { status: 304, headers: res.headers, json: null, path }
  if (res.status >= 200 && res.status < 300) {
    if (json === null) throw new Error(`GitHub ${path} → ${res.status} sent no JSON body`)
    return { status: res.status, headers: res.headers, json, path }
  }

  const githubMessage =
    typeof (json as { message?: unknown } | null)?.message === 'string'
      ? (json as { message: string }).message
      : text.slice(0, 300)
  const cause = safeCause(`GitHub said: ${githubMessage}`, config.token)
  const resumeAt = rateLimitResume(res.status, res.headers, json)
  if (resumeAt) {
    throw new TokenRequestError(
      'rate_limited',
      res.status,
      path,
      resumeAt,
      `GitHub ${path} → ${res.status}: rate limited until ${resumeAt.toISOString()}`,
      cause,
    )
  }
  const kind = kindFor(res.status)
  throw new TokenRequestError(
    kind,
    res.status,
    path,
    null,
    `GitHub ${path} → ${res.status} (${kind})`,
    cause,
  )
}

/** The `rel="next"` URL of a `Link` header, or null on the last page. */
function nextLink(headers: Headers): string | null {
  const link = headers.get('link')
  if (!link) return null
  for (const part of link.split(',')) {
    const m = /^\s*<([^>]+)>\s*;(.*)$/.exec(part)
    if (m && /(^|;)\s*rel="?next"?\s*(;|$)/.test(m[2])) return m[1]
  }
  return null
}

/** GitHub's token-expiration header → Date (see the note at the top). */
function parseExpiry(value: string): Date {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(value.trim())
  const iso = m
    ? `${m[1]}T${m[2]}${m[3] === 'UTC' ? 'Z' : `${m[3].slice(0, 3)}:${m[3].slice(3)}`}`
    : ''
  const date = new Date(iso)
  if (!m || Number.isNaN(date.getTime())) {
    throw new Error(
      `GitHub's token expiration header has a format this client does not know: ${value}`,
    )
  }
  return date
}

function splitFullName(fullName: string): { owner: string; name: string; base: string } {
  const parts = fullName.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`expected a GitHub repo as owner/name, got ${JSON.stringify(fullName)}`)
  }
  const [owner, name] = parts
  return { owner, name, base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` }
}

function date(value: unknown, field: string): Date {
  const d = typeof value === 'string' ? new Date(value) : new Date(NaN)
  if (Number.isNaN(d.getTime())) throw new Error(`GitHub sent no valid ${field}`)
  return d
}

function dateOrNull(value: unknown, field: string): Date | null {
  return value === null || value === undefined ? null : date(value, field)
}

type GhRepo = {
  id: number
  full_name: string
  name: string
  owner: { login: string }
  private: boolean
  archived: boolean
  default_branch: string
  description: string | null
  html_url: string
  pushed_at: string | null
}

function toRepo(r: GhRepo): TokenRepo {
  return {
    id: r.id,
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    archived: r.archived,
    defaultBranch: r.default_branch,
    description: r.description,
    htmlUrl: r.html_url,
    pushedAt: dateOrNull(r.pushed_at, 'pushed_at'),
  }
}

type GhCommit = {
  sha: string
  html_url: string
  author: { login: string } | null
  commit: {
    message: string
    author: { name: string; date: string } | null
    committer: { name: string; date: string } | null
  }
}

function toCommit(c: GhCommit): TokenCommit {
  const who = c.commit.author ?? c.commit.committer
  if (!who) throw new Error(`GitHub commit ${c.sha} has neither author nor committer`)
  return {
    sha: c.sha,
    subject: c.commit.message.split('\n')[0],
    authorName: who.name,
    authorLogin: c.author?.login ?? null,
    date: date(who.date, `date of commit ${c.sha}`),
    htmlUrl: c.html_url,
  }
}

type GhPull = {
  number: number
  title: string
  state: 'open' | 'closed'
  draft?: boolean
  user: { login: string } | null
  head: { ref: string }
  base: { ref: string }
  labels: Array<{ name: string }>
  requested_reviewers: Array<{ login: string }> | null
  body: string | null
  created_at: string
  updated_at: string
  closed_at: string | null
  merged_at: string | null
  html_url: string
}

function toPull(p: GhPull): TokenPull {
  const mergedAt = dateOrNull(p.merged_at, `merged_at of #${p.number}`)
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    merged: mergedAt !== null,
    draft: p.draft === true,
    authorLogin: p.user?.login ?? null,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    labels: p.labels.map((l) => l.name),
    requestedReviewers: (p.requested_reviewers ?? []).map((r) => r.login),
    body: p.body,
    createdAt: date(p.created_at, `created_at of #${p.number}`),
    updatedAt: date(p.updated_at, `updated_at of #${p.number}`),
    closedAt: dateOrNull(p.closed_at, `closed_at of #${p.number}`),
    mergedAt,
    htmlUrl: p.html_url,
  }
}

export function createGitHubTokenClient(config: GitHubTokenConfig): GitHubTokenClient {
  if (!config.token) throw new Error('createGitHubTokenClient needs a token')
  if (!(config.timeoutMs > 0)) throw new Error('createGitHubTokenClient needs a positive timeoutMs')

  let budget: RateBudget | null = null
  const get = (path: string, etag: string | null = null) =>
    tokenRequest(config, 'GET', path, etag, (b) => {
      budget = b
    })

  /**
   * Pages through `Link: rel="next"`. `keep` decides per item whether to go on
   * (false stops paging); `max` caps the item count. Only the first page is
   * conditional.
   */
  async function paged<G>(
    first: string,
    etag: string | null,
    keep: (item: G) => boolean,
    max = Infinity,
  ): Promise<
    | { notModified: true; etag: string }
    | { notModified: false; etag: string | null; items: G[]; pages: number }
  > {
    const items: G[] = []
    let url: string | null = first
    let firstEtag: string | null = null
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await get(url, page === 1 ? etag : null)
      if (res.status === 304) {
        return { notModified: true, etag: res.headers.get('etag') ?? (etag as string) }
      }
      if (page === 1) firstEtag = res.headers.get('etag')
      if (!Array.isArray(res.json)) throw new Error(`GitHub ${res.path} did not send a list`)
      for (const item of res.json as G[]) {
        if (items.length >= max || !keep(item)) {
          return { notModified: false, etag: firstEtag, items, pages: page }
        }
        items.push(item)
      }
      url = nextLink(res.headers)
      if (url === null || items.length >= max)
        return { notModified: false, etag: firstEtag, items, pages: page }
    }
    throw new Error(
      `GitHub ${first.split('?')[0]} has more than ${MAX_PAGES} pages; refusing to read further`,
    )
  }

  async function all<G>(first: string): Promise<G[]> {
    const out = await paged<G>(first, null, () => true)
    if (out.notModified) throw new Error(`GitHub answered 304 to ${first} without an ETag`)
    return out.items
  }

  return {
    async identity(): Promise<TokenIdentity> {
      const res = await get('/user')
      const expiry = res.headers.get('github-authentication-token-expiration')
      const seen = budgetFrom(res.headers)
      if (!seen)
        throw new Error('GitHub /user sent no rate-limit headers; is this really api.github.com?')
      return {
        login: (res.json as { login: string }).login,
        expiresAt: expiry === null ? null : parseExpiry(expiry),
        classic: res.headers.has('x-oauth-scopes'),
        budget: seen,
      }
    },

    async repos(): Promise<TokenRepo[]> {
      const q = new URLSearchParams({
        per_page: String(PER_PAGE),
        visibility: 'all',
        affiliation: 'owner,collaborator,organization_member',
        sort: 'full_name',
      })
      return (await all<GhRepo>(`/user/repos?${q}`)).map(toRepo)
    },

    async repo(fullName, etag): Promise<Conditional<TokenRepo>> {
      const { base } = splitFullName(fullName)
      const res = await get(base, etag)
      if (res.status === 304)
        return { notModified: true, etag: res.headers.get('etag') ?? (etag as string) }
      return { notModified: false, etag: res.headers.get('etag'), data: toRepo(res.json as GhRepo) }
    },

    async branches(fullName, etag): Promise<Conditional<TokenBranch[]>> {
      const { base } = splitFullName(fullName)
      const out = await paged<{ name: string; commit: { sha: string } }>(
        `${base}/branches?per_page=${PER_PAGE}`,
        etag,
        () => true,
      )
      if (out.notModified) return out
      return {
        notModified: false,
        // Page 1's ETag can't vouch for page 2 (branches are sorted by name).
        etag: out.pages === 1 ? out.etag : null,
        data: out.items.map((b) => ({ name: b.name, headSha: b.commit.sha })),
      }
    },

    async commits(fullName, branch, since, limit): Promise<TokenCommit[]> {
      const { base } = splitFullName(fullName)
      if (!Number.isInteger(limit) || limit < 1)
        throw new Error(`commits limit must be a positive integer, got ${limit}`)
      const q = new URLSearchParams({
        sha: branch,
        since: since.toISOString(),
        per_page: String(Math.min(limit, PER_PAGE)),
      })
      const out = await paged<GhCommit>(`${base}/commits?${q}`, null, () => true, limit)
      if (out.notModified)
        throw new Error(`GitHub answered 304 to an unconditional commits request`)
      return out.items.map(toCommit)
    },

    async compare(fullName, baseRef, headRef): Promise<TokenCompare> {
      const { base } = splitFullName(fullName)
      const res = await get(
        `${base}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}?per_page=1`,
      )
      const body = res.json as { ahead_by: number; behind_by: number }
      return { aheadBy: body.ahead_by, behindBy: body.behind_by }
    },

    async pulls(fullName, updatedSince, etag): Promise<Conditional<TokenPull[]>> {
      const { base } = splitFullName(fullName)
      const out = await paged<GhPull>(
        `${base}/pulls?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}`,
        etag,
        (p) => date(p.updated_at, `updated_at of #${p.number}`) >= updatedSince,
      )
      if (out.notModified) return out
      return { notModified: false, etag: out.etag, data: out.items.map(toPull) }
    },

    async tree(fullName, commitSha): Promise<TokenTree> {
      const { base } = splitFullName(fullName)
      const res = await get(`${base}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`)
      const body = res.json as {
        tree: Array<{ path: string; type: string; sha: string; size?: number }>
        truncated: boolean
      }
      return {
        entries: body.tree
          .filter((e) => e.type === 'blob')
          .map((e) => {
            if (typeof e.size !== 'number')
              throw new Error(`GitHub tree blob ${e.path} has no size`)
            return { path: e.path, sha: e.sha, size: e.size }
          }),
        truncated: body.truncated === true,
      }
    },

    async blobText(fullName, blobSha): Promise<string> {
      const { base } = splitFullName(fullName)
      const res = await get(`${base}/git/blobs/${encodeURIComponent(blobSha)}`)
      const body = res.json as { content: string; encoding: string }
      if (body.encoding !== 'base64') {
        throw new Error(`GitHub blob ${blobSha} came as ${body.encoding}, expected base64`)
      }
      const bytes = Buffer.from(body.content.replace(/\s+/g, ''), 'base64')
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error(`GitHub blob ${blobSha} is not valid UTF-8 text`)
      }
    },

    lastBudget: () => budget,
  }
}
