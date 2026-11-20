/**
 * The mock GitHub's logic (scripts/mock-github.ts serves it) for the
 * "GitHub repos copy every file into Drive" journey
 * (plan/github-drive-full-mirror.md §8 M4). It answers exactly the REST calls
 * the fine-grained-token client makes (src/lib/server/github/token.ts) for one
 * fixture repo, `kindred/shop`, and the codeload download its tarball
 * redirect points at. Pure (no sockets), so it is unit-tested.
 *
 * Like GitHub: one fine-grained token is accepted (any other → 401); every
 * API answer carries the rate-limit headers and the token-expiry header (no
 * `x-oauth-scopes`: not a classic token); git blob shas are real
 * (`sha1("blob <size>\0" + bytes)`), and the tarball is a real gzip'd tar
 * under GitHub's top folder `<owner>-<repo>-<short sha>/`. The tarball
 * redirect carries a one-time `token` query (codeload never sees the API
 * token); codeload refuses anything else.
 */
import { createHash, randomBytes } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { writeTarGz } from '../modules/drive/tar'
import { gitBlobSha } from '../src/lib/server/github/git'

/** The one token the mock accepts (test-only, never a real GitHub token). */
export const MOCK_GITHUB_TOKEN = 'github_pat_e2e_11KINDRED0shop0mock0token0abcdefghijklmnopqrstuvwxyz'
export const MOCK_GITHUB_LOGIN = 'kindred-admin'
export const MOCK_REPO = { owner: 'kindred', name: 'shop', fullName: 'kindred/shop', id: 424242, defaultBranch: 'main' } as const

/** A real w×h PNG (one IHDR, one IDAT, IEND). */
export function tinyPng(w = 8, h = 6): Uint8Array {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = Math.round((x / w) * 255)
      raw[o + 1] = 120
      raw[o + 2] = Math.round((y / h) * 255)
    }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return new Uint8Array(png)
}

const enc = new TextEncoder()

/** The fixture repo's default-branch files, in tree order. */
export const MOCK_FILES: ReadonlyArray<{ path: string; bytes: Uint8Array }> = [
  { path: 'README.md', bytes: enc.encode('# Shop\n\nThe Kindred shop front.\n') },
  { path: 'assets/logo.png', bytes: tinyPng() },
  { path: 'docs/guide.md', bytes: enc.encode('# Guide\n\nRun `npm start` and open the shop.\n') },
  { path: 'package.json', bytes: enc.encode('{\n  "name": "kindred-shop",\n  "version": "1.0.0"\n}\n') },
  { path: 'src/index.ts', bytes: enc.encode("export const greeting = 'Hello from the Kindred shop'\n") },
]

/** The default branch's head: a stable 40-hex commit sha for the fixture. */
export const MOCK_HEAD_SHA = createHash('sha1').update('commit kindred/shop main v1').digest('hex')

export type MockGitHubAnswer = { status: number; headers: Record<string, string>; body: Uint8Array | string }
export type MockGitHubRequest = { at: string; origin: 'api' | 'codeload'; method: string; path: string; status: number }

type Headers = Record<string, string | string[] | undefined>

const header = (headers: Headers, name: string): string | undefined => {
  const v = headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

/** `YYYY-MM-DD HH:MM:SS UTC`, the expiry format GitHub sends. */
function githubExpiry(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`
}

export type MockGitHubOptions = {
  /** Where the tarball redirect points (the codeload server's origin). */
  codeloadOrigin: string
  now?: () => number
}

/** One mock GitHub's state and handlers (pure: no sockets). */
export function createMockGitHub(opts: MockGitHubOptions) {
  const now = opts.now ?? Date.now
  const startedAt = now()
  const requests: MockGitHubRequest[] = []
  const downloadTokens = new Set<string>()
  const blobs = new Map(MOCK_FILES.map((f) => [gitBlobSha(f.bytes), f.bytes]))
  let tarball: Promise<Uint8Array> | null = null

  const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const { owner, name, fullName, id, defaultBranch } = MOCK_REPO
  const shortSha = MOCK_HEAD_SHA.slice(0, 7)

  const rate = () => ({
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': String(5000 - Math.min(requests.length + 1, 4999)),
    'x-ratelimit-used': String(Math.min(requests.length + 1, 4999)),
    'x-ratelimit-reset': String(Math.floor(now() / 1000) + 3600),
    'x-ratelimit-resource': 'core',
    'x-github-api-version-selected': '2022-11-28',
    'github-authentication-token-expiration': githubExpiry(new Date(startedAt + 30 * 24 * 3600 * 1000)),
  })
  const json = (status: number, body: unknown, extra: Record<string, string> = {}): MockGitHubAnswer => ({
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...rate(), ...extra },
    body: JSON.stringify(body),
  })

  const repoBody = () => ({
    id,
    node_id: 'R_kgDOkindredshop',
    name,
    full_name: fullName,
    private: true,
    visibility: 'private',
    owner: { login: owner, id: 7001, type: 'Organization' },
    html_url: `https://github.com/${fullName}`,
    description: 'The Kindred shop front',
    fork: false,
    archived: false,
    disabled: false,
    default_branch: defaultBranch,
    pushed_at: iso(startedAt - 3600_000),
    created_at: '2025-01-01T00:00:00Z',
    updated_at: iso(startedAt - 3600_000),
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
  })
  const commitBody = () => ({
    sha: MOCK_HEAD_SHA,
    node_id: 'C_kwDOmock',
    html_url: `https://github.com/${fullName}/commit/${MOCK_HEAD_SHA}`,
    author: { login: MOCK_GITHUB_LOGIN, id: 1001 },
    committer: { login: MOCK_GITHUB_LOGIN, id: 1001 },
    commit: {
      message: 'Add the shop front\n\nREADME, guide, code and logo.',
      author: { name: 'Kindred Admin', email: 'admin@kindred.test', date: iso(startedAt - 3600_000) },
      committer: { name: 'Kindred Admin', email: 'admin@kindred.test', date: iso(startedAt - 3600_000) },
    },
  })
  const treeBody = () => {
    const dirs = new Set<string>()
    for (const f of MOCK_FILES) {
      const parts = f.path.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
    const tree = [
      ...[...dirs].map((path) => ({ path, mode: '040000', type: 'tree', sha: createHash('sha1').update(`tree ${path}`).digest('hex') })),
      ...MOCK_FILES.map((f) => ({ path: f.path, mode: '100644', type: 'blob', sha: gitBlobSha(f.bytes), size: f.bytes.byteLength })),
    ].sort((a, b) => a.path.localeCompare(b.path))
    return { sha: MOCK_HEAD_SHA, url: `https://api.github.com/repos/${fullName}/git/trees/${MOCK_HEAD_SHA}`, tree, truncated: false }
  }

  async function buildTarball(): Promise<Uint8Array> {
    const top = `${owner}-${name}-${shortSha}`
    const chunks: Uint8Array[] = []
    await writeTarGz(
      MOCK_FILES.map((f) => ({ path: `${top}/${f.path}`, size: f.bytes.byteLength, mtime: new Date(startedAt), read: async () => f.bytes })),
      async (c) => {
        chunks.push(c)
      },
    )
    return new Uint8Array(Buffer.concat(chunks))
  }
  const tarballBytes = () => (tarball ??= buildTarball())

  const record = (origin: MockGitHubRequest['origin'], method: string, path: string, a: MockGitHubAnswer) => {
    requests.push({ at: new Date(now()).toISOString(), origin, method, path, status: a.status })
    return a
  }

  /** The api.github.com stand-in. `url` is the request path with its query. */
  function api(method: string, url: string, headers: Headers): MockGitHubAnswer {
    const u = new URL(url, 'http://mock')
    const path = u.pathname
    const done = (a: MockGitHubAnswer) => record('api', method, path, a)
    if (method !== 'GET') return done(json(404, { message: 'Not Found' }))
    if (header(headers, 'authorization') !== `Bearer ${MOCK_GITHUB_TOKEN}`) {
      return done({
        status: 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' }),
      })
    }
    if (path === '/user') return done(json(200, { login: MOCK_GITHUB_LOGIN, id: 1001, type: 'User', name: 'Kindred Admin' }))
    if (path === '/user/repos') return done(json(200, [repoBody()]))

    const base = `/repos/${owner}/${name}`
    if (path === base) return done(json(200, repoBody(), { etag: `W/"repo-${shortSha}"` }))
    if (!path.startsWith(`${base}/`)) return done(json(404, { message: 'Not Found' }))
    const rest = path.slice(base.length + 1)

    if (rest === 'branches') return done(json(200, [{ name: defaultBranch, commit: { sha: MOCK_HEAD_SHA, url: '' }, protected: false }]))
    if (rest === 'commits') {
      const ref = u.searchParams.get('sha')
      if (ref !== null && ref !== defaultBranch && ref !== MOCK_HEAD_SHA) return done(json(404, { message: 'No commit found for SHA' }))
      const since = u.searchParams.get('since')
      const c = commitBody()
      const keep = since === null || new Date(c.commit.author.date) >= new Date(since)
      return done(json(200, keep ? [c] : []))
    }
    if (rest.startsWith('compare/')) return done(json(200, { status: 'identical', ahead_by: 0, behind_by: 0, total_commits: 0, commits: [] }))
    if (rest === 'pulls') return done(json(200, []))
    if (rest === `git/trees/${MOCK_HEAD_SHA}`) return done(json(200, treeBody()))
    const blob = /^git\/blobs\/([0-9a-f]{40})$/.exec(rest)
    if (blob) {
      const bytes = blobs.get(blob[1]!)
      if (!bytes) return done(json(404, { message: 'Not Found' }))
      const b64 = Buffer.from(bytes).toString('base64').replace(/.{60}/g, '$&\n')
      return done(json(200, { sha: blob[1], node_id: 'B_mock', size: bytes.byteLength, url: '', content: b64, encoding: 'base64' }))
    }
    if (rest === `tarball/${MOCK_HEAD_SHA}`) {
      const once = randomBytes(16).toString('hex')
      downloadTokens.add(once)
      return done({
        status: 302,
        headers: { ...rate(), location: `${opts.codeloadOrigin}/${owner}/${name}/legacy.tar.gz/${MOCK_HEAD_SHA}?token=${once}`, 'content-length': '0' },
        body: '',
      })
    }
    return done(json(404, { message: 'Not Found' }))
  }

  /** The codeload.github.com stand-in: no credentials, one-time token in the query. */
  async function codeload(method: string, url: string, headers: Headers): Promise<MockGitHubAnswer> {
    const u = new URL(url, 'http://mock')
    const done = (a: MockGitHubAnswer) => record('codeload', method, u.pathname, a)
    const notFound = (): MockGitHubAnswer => ({ status: 404, headers: { 'content-type': 'text/plain' }, body: '404: Not Found' })
    if (method !== 'GET' || header(headers, 'authorization') !== undefined) return done(notFound())
    if (u.pathname !== `/${owner}/${name}/legacy.tar.gz/${MOCK_HEAD_SHA}`) return done(notFound())
    const once = u.searchParams.get('token')
    if (once === null || !downloadTokens.delete(once)) return done(notFound())
    const bytes = await tarballBytes()
    return done({
      status: 200,
      headers: {
        'content-type': 'application/x-gzip',
        'content-length': String(bytes.byteLength),
        'content-disposition': `attachment; filename=${owner}-${name}-${shortSha}.tar.gz`,
      },
      body: bytes,
    })
  }

  return { api, codeload, requests, tarballBytes }
}
