import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readTarGz } from '../src/lib/server/github/tar'
import { createGitHubTokenClient } from '../src/lib/server/github/token'
import { MOCK_FILES, MOCK_GITHUB_TOKEN, MOCK_HEAD_SHA, createMockGitHub } from './mock-github-core'

const API = 'http://127.0.0.1:5197'
const CODELOAD = 'http://127.0.0.1:5196'
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** The mock behind a `fetch`: what the harness app's token client sees over the sockets. */
function mockFetch() {
  const gh = createMockGitHub({ codeloadOrigin: CODELOAD })
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const target = `${url.pathname}${url.search}`
    const out =
      url.origin === API
        ? gh.api(init?.method ?? 'GET', target, headers)
        : url.origin === CODELOAD
          ? await gh.codeload(init?.method ?? 'GET', target, headers)
          : null
    if (!out) throw new Error(`unexpected origin ${url.origin}`)
    return new Response(out.status === 302 ? null : (out.body as BodyInit), { status: out.status, headers: out.headers })
  }) as typeof fetch
  return { gh, fetch }
}

async function client(token = MOCK_GITHUB_TOKEN) {
  const dir = await mkdtemp(join(tmpdir(), 'mock-github-'))
  dirs.push(dir)
  const { gh, fetch } = mockFetch()
  return {
    gh,
    dir,
    client: createGitHubTokenClient({
      token,
      fetch,
      timeoutMs: 1000,
      tarballDir: dir,
      tarballTimeoutMs: 5000,
      tarballMaxBytes: 1024 * 1024,
      apiBase: API,
      codeloadOrigin: CODELOAD,
    }),
  }
}

const gitSha = (bytes: Uint8Array) =>
  createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')

describe('mock GitHub (e2e) through the real token client', () => {
  it('answers identity as a fine-grained token with an expiry and a rate budget', async () => {
    const { client: gh } = await client()
    const id = await gh.identity()
    expect(id.login).toBe('kindred-admin')
    expect(id.classic).toBe(false)
    expect(id.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 7 * 24 * 3600 * 1000)
    expect(id.budget.limit).toBe(5000)
  })

  it('refuses any other token with 401', async () => {
    const { client: gh } = await client('github_pat_not_the_e2e_token')
    await expect(gh.identity()).rejects.toMatchObject({ kind: 'unauthorized', status: 401 })
  })

  it('lists kindred/shop (private, main) and passes checkAccess with nothing missing', async () => {
    const { client: gh } = await client()
    const [repo, ...more] = await gh.repos()
    expect(more).toEqual([])
    expect(repo).toMatchObject({ fullName: 'kindred/shop', private: true, defaultBranch: 'main', archived: false })
    expect(await gh.checkAccess('kindred/shop')).toEqual([])
    const branches = await gh.branches('kindred/shop', null)
    expect(branches).toMatchObject({ notModified: false, data: [{ name: 'main', headSha: MOCK_HEAD_SHA }] })
    expect(await gh.commits('kindred/shop', 'main', new Date(Date.now() - 86_400_000), 30)).toHaveLength(1)
    expect(await gh.pulls('kindred/shop', new Date(0), null)).toMatchObject({ data: [] })
    expect(await gh.openPulls('kindred/shop', null)).toMatchObject({ data: [] })
    expect(await gh.compare('kindred/shop', 'main', 'main')).toEqual({ aheadBy: 0, behindBy: 0 })
  })

  it('serves a tree whose blob shas are real git shas, and blobs that match them', async () => {
    const { client: gh } = await client()
    const tree = await gh.tree('kindred/shop', MOCK_HEAD_SHA)
    expect(tree.truncated).toBe(false)
    expect(tree.entries.map((e) => e.path)).toEqual(['assets/logo.png', 'docs/guide.md', 'package.json', 'README.md', 'src/index.ts'])
    for (const e of tree.entries) {
      const file = MOCK_FILES.find((f) => f.path === e.path)!
      expect(e.sha).toBe(gitSha(file.bytes))
      expect(e.size).toBe(file.bytes.byteLength)
      expect(await gh.blobBytes('kindred/shop', e.sha)).toEqual(file.bytes)
    }
    const png = MOCK_FILES.find((f) => f.path === 'assets/logo.png')!.bytes
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('redirects the tarball to codeload once; the archive parses with GitHub top folder and real bytes', async () => {
    const { client: gh, gh: mock } = await client()
    const file = await gh.tarball('kindred/shop', MOCK_HEAD_SHA)
    const seen: Array<{ path: string; bytes: Uint8Array }> = []
    for await (const e of readTarGz(file, { want: () => true })) seen.push({ path: e.path, bytes: e.bytes })
    const top = `kindred-shop-${MOCK_HEAD_SHA.slice(0, 7)}/`
    expect(seen.map((e) => e.path)).toEqual(MOCK_FILES.map((f) => `${top}${f.path}`))
    for (const e of seen) expect(e.bytes).toEqual(MOCK_FILES.find((f) => `${top}${f.path}` === e.path)!.bytes)
    expect(mock.requests.filter((r) => r.origin === 'codeload').map((r) => r.status)).toEqual([200])
  })

  it('codeload refuses a reused or missing download token, and any Authorization header', async () => {
    const gh = createMockGitHub({ codeloadOrigin: CODELOAD })
    const redirect = gh.api('GET', `/repos/kindred/shop/tarball/${MOCK_HEAD_SHA}`, { authorization: `Bearer ${MOCK_GITHUB_TOKEN}` })
    expect(redirect.status).toBe(302)
    const target = new URL(redirect.headers.location!)
    expect(target.origin).toBe(CODELOAD)
    const path = `${target.pathname}${target.search}`
    expect((await gh.codeload('GET', path, { authorization: `Bearer ${MOCK_GITHUB_TOKEN}` })).status).toBe(404)
    expect((await gh.codeload('GET', path, {})).status).toBe(200)
    expect((await gh.codeload('GET', path, {})).status).toBe(404)
    expect((await gh.codeload('GET', target.pathname, {})).status).toBe(404)
  })
})
