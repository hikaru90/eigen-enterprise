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
  TokenPermission,
  RateBudget,
  TokenBranch,
  TokenCommit,
  TokenCompare,
  TokenIdentity,
  TokenPull,
  TokenRepo,
  TokenTree,
  TokenTreeEntry,
} from './token-client'
import { randomUUID } from 'node:crypto'
import { open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

const API = 'https://api.github.com'
const PER_PAGE = 100
/** 50 pages × 100 = 5,000 items; beyond that something is wrong. */
const MAX_PAGES = 50
/** GitHub: with no retry header, wait at least a minute. */
const DEFAULT_BACKOFF_MS = 60_000

export type GitHubTokenConfig = {
  token: string
  fetch: typeof fetch
  /** Every api.github.com request, including the tarball's redirecting one. */
  timeoutMs: number
  /** The Drive storage temp directory `tarball` streams archives into. */
  tarballDir: string
  /** The whole codeload download (response and stream) must finish within this. */
  tarballTimeoutMs: number
  /** A download past this many bytes is aborted and its partial file removed. */
  tarballMaxBytes: number
}

class TokenRequestError extends Error implements GitHubTokenError {
  constructor(
    readonly kind: GitHubTokenErrorKind,
    readonly status: number | null,
    readonly path: string,
    readonly resumeAt: Date | null,
    message: string,
    cause?: Error,
    readonly permission: TokenPermission | null = null,
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
      permission: this.permission,
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

/** The headers every api.github.com request carries. */
function authHeaders(token: string, etag: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'eigenEnterprise',
    authorization: `Bearer ${token}`,
  }
  if (etag !== null) headers['if-none-match'] = etag
  return headers
}

/** The error thrown when the request never produced a response. */
function networkFailure(
  path: string,
  timeoutMs: number,
  timedOut: boolean,
  err: unknown,
  token: string,
): TokenRequestError {
  return new TokenRequestError(
    'unavailable',
    null,
    path,
    null,
    timedOut ? `GitHub ${path} did not answer within ${timeoutMs} ms` : `GitHub ${path} could not be reached`,
    safeCause(err instanceof Error ? `${err.name}: ${err.message}` : String(err), token),
  )
}

/** Maps a non-2xx, non-304 API response to the error it throws. */
function failWith(
  res: Response,
  text: string,
  json: unknown,
  path: string,
  token: string,
  permission: TokenPermission | null,
): never {
  const githubMessage =
    typeof (json as { message?: unknown } | null)?.message === 'string'
      ? (json as { message: string }).message
      : text.slice(0, 300)
  const cause = safeCause(`GitHub said: ${githubMessage}`, token)
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
  // A 403 on a read beyond metadata: the token sees the repo (its metadata
  // read passed) but lacks this permission. The status + which endpoint we
  // called decide it, never GitHub's message text.
  if (res.status === 403 && permission !== null && permission !== 'metadata') {
    throw new TokenRequestError(
      'missing_permission',
      403,
      path,
      null,
      `GitHub ${path} → 403 (missing_permission: ${permission}; GitHub accepts ${res.headers.get('x-accepted-github-permissions') ?? 'n/a'})`,
      cause,
      permission,
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
    permission,
  )
}

/**
 * The one place a request is made. GET only: any other method throws
 * `write_refused` before anything is sent.
 */
export async function tokenRequest(
  config: Pick<GitHubTokenConfig, 'token' | 'fetch' | 'timeoutMs'>,
  method: string,
  pathOrUrl: string,
  etag: string | null,
  onBudget?: (b: RateBudget) => void,
  permission: TokenPermission | null = null,
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
  const headers = authHeaders(config.token, etag)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  let res: Response
  let text: string
  try {
    res = await config.fetch(url, { method: 'GET', headers, signal: controller.signal })
    text = res.status === 304 ? '' : await res.text()
  } catch (err) {
    throw networkFailure(path, config.timeoutMs, controller.signal.aborted, err, config.token)
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

  failWith(res, text, json, path, config.token, permission)
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
  if (!config.tarballDir)
    throw new Error('createGitHubTokenClient needs tarballDir (the Drive storage temp directory)')
  if (!(config.tarballTimeoutMs > 0))
    throw new Error('createGitHubTokenClient needs a positive tarballTimeoutMs (the codeload download limit)')
  if (!(config.tarballMaxBytes > 0))
    throw new Error('createGitHubTokenClient needs a positive tarballMaxBytes (the codeload download size cap)')

  let budget: RateBudget | null = null
  const budgetSeen = (b: RateBudget) => {
    budget = b
  }
  const get = (path: string, etag: string | null = null, permission: TokenPermission | null = null) =>
    tokenRequest(config, 'GET', path, etag, budgetSeen, permission)

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
    permission: TokenPermission | null = null,
  ): Promise<
    | { notModified: true; etag: string }
    | { notModified: false; etag: string | null; items: G[]; pages: number }
  > {
    const items: G[] = []
    let url: string | null = first
    let firstEtag: string | null = null
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await get(url, page === 1 ? etag : null, permission)
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
      const res = await get(base, etag, 'metadata')
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
        Infinity,
        'metadata',
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
      const out = await paged<GhCommit>(`${base}/commits?${q}`, null, () => true, limit, 'contents')
      if (out.notModified)
        throw new Error(`GitHub answered 304 to an unconditional commits request`)
      return out.items.map(toCommit)
    },

    async compare(fullName, baseRef, headRef): Promise<TokenCompare> {
      const { base } = splitFullName(fullName)
      const res = await get(
        `${base}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}?per_page=1`,
        null,
        'contents',
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
        Infinity,
        'pull_requests',
      )
      if (out.notModified) return out
      return { notModified: false, etag: out.etag, data: out.items.map(toPull) }
    },

    async openPulls(fullName, etag): Promise<Conditional<TokenPull[]>> {
      const { base } = splitFullName(fullName)
      const out = await paged<GhPull>(
        `${base}/pulls?state=open&sort=created&direction=desc&per_page=${PER_PAGE}`,
        etag,
        () => true,
        Infinity,
        'pull_requests',
      )
      if (out.notModified) return out
      // Page 1's ETag can't vouch for later pages (a PR closed there would go unseen).
      return { notModified: false, etag: out.pages === 1 ? out.etag : null, data: out.items.map(toPull) }
    },

    async tree(fullName, commitSha): Promise<TokenTree> {
      const { base } = splitFullName(fullName)
      const res = await get(`${base}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`, null, 'contents')
      const body = res.json as {
        tree: Array<{ path: string; mode: string; type: string; sha: string; size?: number }>
        truncated: boolean
      }
      return {
        entries: body.tree.flatMap((e): TokenTreeEntry[] => {
          if (e.type === 'tree') return []
          if (e.type === 'blob') {
            if (e.mode !== '100644' && e.mode !== '100755' && e.mode !== '120000') {
              throw new Error(`GitHub tree blob ${e.path} has mode ${e.mode}, not 100644/100755/120000`)
            }
            if (typeof e.size !== 'number') throw new Error(`GitHub tree blob ${e.path} has no size`)
            return [{ path: e.path, mode: e.mode, sha: e.sha, size: e.size }]
          }
          if (e.type === 'commit') {
            if (e.mode !== '160000') {
              throw new Error(`GitHub tree commit ${e.path} has mode ${e.mode}, not 160000`)
            }
            return [{ path: e.path, mode: '160000', sha: e.sha, size: null }]
          }
          throw new Error(`GitHub tree entry ${e.path} has type ${e.type}; expected blob, tree or commit`)
        }),
        truncated: body.truncated === true,
      }
    },

    async blobText(fullName, blobSha): Promise<string> {
      const { base } = splitFullName(fullName)
      const res = await get(`${base}/git/blobs/${encodeURIComponent(blobSha)}`, null, 'contents')
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

    async blobBytes(fullName, blobSha): Promise<Uint8Array> {
      const { base } = splitFullName(fullName)
      const res = await get(`${base}/git/blobs/${encodeURIComponent(blobSha)}`, null, 'contents')
      const body = res.json as { content: string; encoding: string; size?: number }
      if (body.encoding !== 'base64') {
        throw new Error(`GitHub blob ${blobSha} came as ${body.encoding}, expected base64`)
      }
      const compact = body.content.replace(/\s+/g, '')
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
        throw new Error(`GitHub blob ${blobSha} is not base64 data`)
      }
      const buffer = Buffer.from(compact, 'base64')
      if (typeof body.size === 'number' && body.size !== buffer.byteLength) {
        throw new Error(
          `GitHub blob ${blobSha} says ${body.size} bytes but its base64 decodes to ${buffer.byteLength}`,
        )
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    },

    async tarball(fullName, commitSha): Promise<string> {
      const { base } = splitFullName(fullName)
      const path = `${base}/tarball/${encodeURIComponent(commitSha)}`
      // One logical request, two physical ones: the API call is made here
      // (not through tokenRequest) because its 302 body is not JSON and the
      // codeload download must never see the token or touch the budget —
      // only the api.github.com response counts against it.
      const target = await tarballRedirect(config, path, budgetSeen)
      return downloadTarball(config, path, target)
    },

    async checkAccess(fullName): Promise<TokenPermission[]> {
      const { base } = splitFullName(fullName)
      // Metadata first: a 403/404 here means the token can't see the repo (no_access, thrown).
      await get(base, null, 'metadata')
      const missing: TokenPermission[] = []
      const probes: Array<[TokenPermission, string]> = [
        ['contents', `${base}/commits?per_page=1`],
        ['pull_requests', `${base}/pulls?state=open&per_page=1`],
      ]
      for (const [permission, path] of probes) {
        try {
          await get(path, null, permission)
        } catch (err) {
          if (err instanceof TokenRequestError && err.kind === 'missing_permission') missing.push(permission)
          // 409: an empty repo has no commits; the read was allowed.
          else if (!(err instanceof TokenRequestError && err.status === 409)) throw err
        }
      }
      return missing
    },

    lastBudget: () => budget,
  }
}

const TARBALL_FILE = /^github-tarball-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar\.gz$/

/**
 * The API half of `tarball`: GET /tarball/{sha} under `timeoutMs`, expecting a
 * 302/307 to codeload.github.com. Returns the codeload URL; anything else
 * throws the error the API response maps to.
 */
async function tarballRedirect(
  config: GitHubTokenConfig,
  path: string,
  budgetSeen: (b: RateBudget) => void,
): Promise<URL> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    let res: Response
    try {
      res = await config.fetch(`${API}${path}`, {
        method: 'GET',
        redirect: 'manual',
        headers: authHeaders(config.token, null),
        signal: controller.signal,
      })
    } catch (err) {
      throw networkFailure(path, config.timeoutMs, controller.signal.aborted, err, config.token)
    }
    const budget = budgetFrom(res.headers)
    // The codeload response that follows is not a second logical API
    // request: its headers are never read, so they cannot poison this.
    if (budget) budgetSeen(budget)

    if (res.status === 302 || res.status === 307) {
      void res.body?.cancel().catch(() => {})
      const location = res.headers.get('location')
      let target: URL
      try {
        if (location === null) throw new Error('no Location')
        target = new URL(location)
      } catch {
        throw new TokenRequestError(
          'unavailable',
          res.status,
          path,
          null,
          `GitHub ${path} → ${res.status} without a parsable Location header`,
        )
      }
      if (target.origin !== 'https://codeload.github.com') {
        throw new TokenRequestError(
          'unavailable',
          res.status,
          path,
          null,
          `GitHub ${path} redirects to ${target.origin}, not https://codeload.github.com; refusing to follow`,
        )
      }
      return target
    }
    if (res.status >= 200 && res.status < 300) {
      void res.body?.cancel().catch(() => {})
      throw new TokenRequestError(
        'unavailable',
        res.status,
        path,
        null,
        `GitHub ${path} → ${res.status}: expected a redirect to codeload.github.com`,
      )
    }
    let text: string
    try {
      text = res.status === 304 ? '' : await res.text()
    } catch (err) {
      throw networkFailure(path, config.timeoutMs, controller.signal.aborted, err, config.token)
    }
    let json: unknown = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    failWith(res, text, json, path, config.token, 'contents')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The codeload half of `tarball`: no credentials, no redirects followed, one
 * `tarballTimeoutMs` timer over the response and the whole stream, and a
 * `tarballMaxBytes` cap. Any failure removes the partial file.
 */
async function downloadTarball(config: GitHubTokenConfig, path: string, target: URL): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.tarballTimeoutMs)
  const timedOut = (received: number) =>
    new TokenRequestError(
      'unavailable',
      null,
      path,
      null,
      `the codeload download for ${path} did not finish within ${config.tarballTimeoutMs} ms (${received} bytes so far)`,
    )
  const tooLarge = (bytes: number, exact: boolean) =>
    new TokenRequestError(
      'too_large',
      null,
      path,
      null,
      `the codeload download for ${path} is over the ${config.tarballMaxBytes}-byte limit (${exact ? '' : 'at least '}${bytes} bytes)`,
    )
  try {
    let dl: Response
    try {
      dl = await config.fetch(target.href, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'application/x-gzip', 'user-agent': 'eigenEnterprise' },
        signal: controller.signal,
      })
    } catch (err) {
      if (controller.signal.aborted) throw timedOut(0)
      throw networkFailure(path, config.tarballTimeoutMs, false, err, config.token)
    }
    if (dl.status !== 200) {
      const text = await dl.text().catch(() => '')
      throw new TokenRequestError(
        'unavailable',
        dl.status,
        path,
        null,
        `the codeload download for ${path} answered ${dl.status}`,
        safeCause(text.slice(0, 300), config.token),
      )
    }
    if (!dl.body) {
      throw new TokenRequestError('unavailable', 200, path, null, `the codeload download for ${path} sent no body`)
    }
    const declared = dl.headers.get('content-length')
    if (declared !== null && Number(declared) > config.tarballMaxBytes) {
      void dl.body.cancel().catch(() => {})
      throw tooLarge(Number(declared), true)
    }

    const reader = dl.body.getReader()
    // A body that ignores the abort signal must still stop: cancel it ourselves.
    const onAbort = () => void reader.cancel().catch(() => {})
    controller.signal.addEventListener('abort', onAbort, { once: true })
    const file = join(config.tarballDir, `github-tarball-${randomUUID()}.tar.gz`)
    const handle = await open(file, 'wx', 0o600)
    let received = 0
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch (err) {
          if (controller.signal.aborted) throw timedOut(received)
          throw new TokenRequestError(
            'unavailable',
            null,
            path,
            null,
            `the codeload download for ${path} failed after ${received} bytes`,
            safeCause(err instanceof Error ? `${err.name}: ${err.message}` : String(err), config.token),
          )
        }
        // A cancelled read resolves as done: that is the timeout, not the end.
        if (controller.signal.aborted) throw timedOut(received)
        if (chunk.done) break
        received += chunk.value.byteLength
        if (received > config.tarballMaxBytes) {
          void reader.cancel().catch(() => {})
          throw tooLarge(received, false)
        }
        await handle.write(chunk.value)
      }
      await handle.close()
    } catch (err) {
      await handle.close().catch(() => {})
      await rm(file, { force: true })
      throw err
    } finally {
      controller.signal.removeEventListener('abort', onAbort)
    }
    return file
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Deletes leftover `github-tarball-<uuid>.tar.gz` files in `dir` last
 * modified more than `olderThanMs` before `now` (a crash between download
 * and cleanup leaves them behind). Other files are never touched. Returns
 * the removed paths.
 */
export async function sweepTarballs(dir: string, olderThanMs: number, now: Date): Promise<string[]> {
  if (!(olderThanMs >= 0)) throw new Error(`sweepTarballs needs a non-negative olderThanMs, got ${olderThanMs}`)
  const cutoff = now.getTime() - olderThanMs
  const removed: string[] = []
  for (const name of await readdir(dir)) {
    if (!TARBALL_FILE.test(name)) continue
    const file = join(dir, name)
    const info = await stat(file).catch((err: NodeJS.ErrnoException) => {
      // Removed concurrently (the sync finished with it): nothing to sweep.
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (info === null || !info.isFile() || info.mtimeMs >= cutoff) continue
    await rm(file, { force: true })
    removed.push(file)
  }
  return removed
}
