/**
 * Response shapes of the GitHub REST endpoints the token client reads,
 * trimmed from GitHub's documented examples (API version 2022-11-28) to the
 * fields that matter plus a few that don't (so mappers prove they ignore
 * extras). S3 fakes GitHub at the transport with these: `fakeGitHub` is a
 * `fetch` stand-in keyed on method + path (query string included).
 */

export const API = 'https://api.github.com'

/** Response headers GitHub sends on an authenticated fine-grained-token call. */
export function rateHeaders(
  remaining = 4987,
  limit = 5000,
  reset = 1762950000,
): Record<string, string> {
  return {
    'x-ratelimit-limit': String(limit),
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(reset),
    'x-ratelimit-used': String(limit - remaining),
    'x-ratelimit-resource': 'core',
  }
}

export const userBody = {
  login: 'octo-owner',
  id: 1001,
  node_id: 'MDQ6VXNlcjEwMDE=',
  type: 'User',
  site_admin: false,
  name: 'Octo Owner',
  html_url: 'https://github.com/octo-owner',
}

export function repoBody(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 500 + n,
    node_id: `R_kgDO${n}`,
    name: `repo-${n}`,
    full_name: `octo-org/repo-${n}`,
    private: n % 2 === 0,
    owner: { login: 'octo-org', id: 9, type: 'Organization' },
    html_url: `https://github.com/octo-org/repo-${n}`,
    description: n === 1 ? 'The first repo' : null,
    fork: false,
    archived: false,
    disabled: false,
    default_branch: 'main',
    pushed_at: '2026-11-10T09:30:00Z',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2026-11-10T09:30:00Z',
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    visibility: n % 2 === 0 ? 'private' : 'public',
    ...overrides,
  }
}

export const branchesBody = [
  {
    name: 'feature/drive',
    commit: { sha: 'b'.repeat(40), url: `${API}/repos/octo-org/repo-1/commits/${'b'.repeat(40)}` },
    protected: false,
  },
  {
    name: 'main',
    commit: { sha: 'a'.repeat(40), url: `${API}/repos/octo-org/repo-1/commits/${'a'.repeat(40)}` },
    protected: true,
  },
]

export function commitBody(n: number, overrides: { author?: unknown } = {}) {
  const sha = String(n).padStart(40, 'c')
  return {
    sha,
    node_id: `C_${n}`,
    commit: {
      author: {
        name: `Dev ${n}`,
        email: `dev${n}@example.com`,
        date: `2026-11-0${(n % 9) + 1}T12:00:00Z`,
      },
      committer: {
        name: 'GitHub',
        email: 'noreply@github.com',
        date: `2026-11-0${(n % 9) + 1}T12:05:00Z`,
      },
      message: `Commit subject ${n}\n\nLonger body that is not the subject.`,
      tree: { sha: 'f'.repeat(40) },
      comment_count: 0,
    },
    author:
      'author' in overrides ? overrides.author : { login: `dev${n}`, id: 2000 + n, type: 'User' },
    committer: { login: 'web-flow', id: 19864447, type: 'User' },
    html_url: `https://github.com/octo-org/repo-1/commit/${sha}`,
    parents: [],
  }
}

export const compareBody = {
  status: 'ahead',
  ahead_by: 3,
  behind_by: 1,
  total_commits: 3,
  base_commit: { sha: 'a'.repeat(40) },
  merge_base_commit: { sha: 'a'.repeat(40) },
  commits: [],
  files: [],
  html_url: 'https://github.com/octo-org/repo-1/compare/main...feature/drive',
}

export function pullBody(n: number, updatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 7000 + n,
    number: n,
    state: 'open',
    locked: false,
    title: `PR ${n}`,
    user: { login: `dev${n}`, id: 2000 + n, type: 'User' },
    body: n === 1 ? 'Adds the Drive folder.' : null,
    labels: [{ id: 1, name: 'enhancement', color: 'a2eeef', default: true }],
    created_at: '2026-11-01T08:00:00Z',
    updated_at: updatedAt,
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    requested_reviewers: [{ login: 'reviewer-a', id: 3001, type: 'User' }],
    requested_teams: [{ slug: 'core', name: 'Core' }],
    head: { label: 'octo-org:feature/drive', ref: 'feature/drive', sha: 'b'.repeat(40) },
    base: { label: 'octo-org:main', ref: 'main', sha: 'a'.repeat(40) },
    draft: false,
    html_url: `https://github.com/octo-org/repo-1/pull/${n}`,
    ...overrides,
  }
}

export const treeBody = {
  sha: 'a'.repeat(40),
  url: `${API}/repos/octo-org/repo-1/git/trees/${'a'.repeat(40)}`,
  tree: [
    { path: 'README.md', mode: '100644', type: 'blob', sha: '1'.repeat(40), size: 1200 },
    { path: 'docs', mode: '040000', type: 'tree', sha: '2'.repeat(40) },
    { path: 'docs/guide.md', mode: '100644', type: 'blob', sha: '3'.repeat(40), size: 640 },
    { path: 'vendor/lib', mode: '160000', type: 'commit', sha: '4'.repeat(40) },
  ],
  truncated: false,
}

export function blobBody(text: string) {
  // GitHub wraps base64 at 60 characters with newlines.
  const b64 = Buffer.from(text, 'utf8').toString('base64')
  return {
    sha: '1'.repeat(40),
    node_id: 'B_1',
    size: Buffer.byteLength(text, 'utf8'),
    url: `${API}/repos/octo-org/repo-1/git/blobs/${'1'.repeat(40)}`,
    content: b64.replace(/(.{60})/g, '$1\n'),
    encoding: 'base64',
  }
}

export type FakeRoute = {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export type FakeCall = {
  method: string
  url: string
  headers: Record<string, string>
}

/**
 * A `fetch` stand-in. Routes are keyed `"GET /path?query"` (path relative to
 * the API root). A route may be a list: each call takes the next entry. An
 * unknown route answers 404 the way GitHub does.
 */
export function fakeGitHub(routes: Record<string, FakeRoute | FakeRoute[]>) {
  const calls: FakeCall[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    calls.push({ method, url, headers })
    const key = `${method} ${url.startsWith(API) ? url.slice(API.length) : url}`
    const entry = routes[key]
    const route = Array.isArray(entry) ? entry.shift() : entry
    if (!route) {
      return new Response(
        JSON.stringify({
          message: 'Not Found',
          documentation_url: 'https://docs.github.com/rest',
          status: '404',
        }),
        { status: 404, headers: { 'content-type': 'application/json', ...rateHeaders() } },
      )
    }
    const body =
      route.status === 304 || route.body === undefined ? null : JSON.stringify(route.body)
    return new Response(body, {
      status: route.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        ...rateHeaders(),
        ...route.headers,
      },
    })
  }) as typeof fetch
  return { calls, impl }
}
