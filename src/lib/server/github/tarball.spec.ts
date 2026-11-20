import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitHubTokenClient, sweepTarballs, type GitHubTokenConfig } from './token'
import { API, rateHeaders } from './token-fixtures'

const TOKEN = 'github_pat_11ABCDEFG0123456789_secretsecretsecretsecret'
const SHA = 'a'.repeat(40)
const API_PATH = `/repos/octo-org/repo-1/tarball/${SHA}`
const CODELOAD = `https://codeload.github.com/octo-org/repo-1/legacy.tar.gz/${SHA}`
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'github-token-tarball-'))
  dirs.push(dir)
  return dir
}

function bytes(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

describe('GitHubTokenClient.tarball', () => {
  it('requires an explicit on-disk archive directory', async () => {
    const config = {
      token: TOKEN,
      fetch: (async () => new Response(null, { status: 500 })) as typeof fetch,
      timeoutMs: 1000,
      tarballTimeoutMs: 1000,
      tarballMaxBytes: 1000,
    }
    expect(() => createGitHubTokenClient(config as GitHubTokenConfig)).toThrow(/tarballDir/)
  })

  it('requires an explicit download timeout and size cap', async () => {
    const base = { token: TOKEN, fetch: (async () => new Response(null)) as typeof fetch, timeoutMs: 1000, tarballDir: '/tmp' }
    expect(() => createGitHubTokenClient({ ...base, tarballMaxBytes: 1 } as GitHubTokenConfig)).toThrow(/tarballTimeoutMs/)
    expect(() => createGitHubTokenClient({ ...base, tarballTimeoutMs: 1 } as GitHubTokenConfig)).toThrow(/tarballMaxBytes/)
    expect(() => createGitHubTokenClient({ ...base, tarballTimeoutMs: 0, tarballMaxBytes: 1 })).toThrow(/tarballTimeoutMs/)
    expect(() => createGitHubTokenClient({ ...base, tarballTimeoutMs: 1, tarballMaxBytes: -1 })).toThrow(/tarballMaxBytes/)
  })

  it('manually follows one GET 302 to codeload, streams a unique file, and counts only the API budget response', async () => {
    const dir = await directory()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const archive = Uint8Array.from({ length: 2049 }, (_, i) => i % 256)
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url === `${API}${API_PATH}`) {
        return new Response(null, {
          status: 302,
          headers: { location: CODELOAD, ...rateHeaders(4901) },
        })
      }
      if (url === CODELOAD) {
        return new Response(bytes(archive.slice(0, 17), archive.slice(17)), {
          status: 200,
          // Codeload is not a second logical API request and must not replace the API budget.
          headers: rateHeaders(0),
        })
      }
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch
    const gh = createGitHubTokenClient({ token: TOKEN, fetch, timeoutMs: 1000, tarballDir: dir, tarballTimeoutMs: 1000, tarballMaxBytes: 1024 * 1024 })

    const first = await gh.tarball('octo-org/repo-1', SHA)
    const second = await gh.tarball('octo-org/repo-1', SHA)

    expect(first).not.toBe(second)
    expect(first.startsWith(`${dir}/`)).toBe(true)
    expect(new Uint8Array(await readFile(first))).toEqual(archive)
    expect(new Uint8Array(await readFile(second))).toEqual(archive)
    expect(calls).toHaveLength(4)
    expect(calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(calls[2]!.init).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    for (const call of [calls[1]!, calls[3]!]) {
      expect(call.init).toMatchObject({ method: 'GET', redirect: 'manual' })
      expect(new Headers(call.init?.headers).has('authorization')).toBe(false)
      expect(new Headers(call.init?.headers).has('cookie')).toBe(false)
    }
    expect(gh.lastBudget()).toEqual({
      remaining: 4901,
      limit: 5000,
      resetAt: new Date(1762950000 * 1000),
    })
  })

  it('creates the tarball directory on first use (a fresh box has none yet)', async () => {
    const dir = join(await directory(), 'github-tarballs', 'nested')
    const archive = new Uint8Array([1, 2, 3])
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url === `${API}${API_PATH}`) return new Response(null, { status: 302, headers: { location: CODELOAD, ...rateHeaders(4900) } })
      if (url === CODELOAD) return new Response(archive, { status: 200 })
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch
    const gh = createGitHubTokenClient({ token: TOKEN, fetch, timeoutMs: 1000, tarballDir: dir, tarballTimeoutMs: 1000, tarballMaxBytes: 1024 })
    const file = await gh.tarball('octo-org/repo-1', SHA)
    expect(new Uint8Array(await readFile(file))).toEqual(archive)
  })

  it('refuses a redirect off codeload without sending credentials to that origin', async () => {
    const dir = await directory()
    const calls: string[] = []
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/archive', ...rateHeaders() },
      })
    }) as typeof fetch
    const gh = createGitHubTokenClient({ token: TOKEN, fetch, timeoutMs: 1000, tarballDir: dir, tarballTimeoutMs: 1000, tarballMaxBytes: 1024 * 1024 })

    await expect(gh.tarball('octo-org/repo-1', SHA)).rejects.toThrow(/codeload/)
    expect(calls).toEqual([`${API}${API_PATH}`])
    expect(await readdir(dir)).toEqual([])
  })

  it('removes the partial file when the codeload stream fails', async () => {
    const dir = await directory()
    const fetch = (async (input: string | URL | Request) => {
      if (String(input) === `${API}${API_PATH}`) {
        return new Response(null, { status: 302, headers: { location: CODELOAD, ...rateHeaders() } })
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]))
          controller.error(new Error(`connection reset; do not expose ${TOKEN}`))
        },
      })
      return new Response(body, { status: 200 })
    }) as typeof fetch
    const gh = createGitHubTokenClient({ token: TOKEN, fetch, timeoutMs: 1000, tarballDir: dir, tarballTimeoutMs: 1000, tarballMaxBytes: 1024 * 1024 })

    const error = await gh.tarball('octo-org/repo-1', SHA).catch((err: unknown) => err)
    expect(error).toMatchObject({ kind: 'unavailable', path: API_PATH })
    expect(JSON.stringify(error)).not.toContain(TOKEN)
    expect(String((error as Error).cause)).not.toContain(TOKEN)
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps existing GitHub error and rate-limit behaviour for the API response', async () => {
    const dir = await directory()
    const fetch = (async () =>
      new Response(JSON.stringify({ message: `bad ${TOKEN}` }), {
        status: 403,
        headers: { 'retry-after': '30', ...rateHeaders(0) },
      })) as typeof fetch
    const gh = createGitHubTokenClient({ token: TOKEN, fetch, timeoutMs: 1000, tarballDir: dir, tarballTimeoutMs: 1000, tarballMaxBytes: 1024 * 1024 })

    const error = await gh.tarball('octo-org/repo-1', SHA).catch((err: unknown) => err)
    expect(error).toMatchObject({ kind: 'rate_limited', status: 403, path: API_PATH })
    expect(JSON.stringify(error)).not.toContain(TOKEN)
    expect(String((error as Error).cause)).not.toContain(TOKEN)
    expect(await readdir(dir)).toEqual([])
  })

  it('names the temp file github-tarball-<uuid>.tar.gz', async () => {
    const dir = await directory()
    const gh = client(dir, codeload(() => bytes(Uint8Array.from([1]))))
    const file = await gh.tarball('octo-org/repo-1', SHA)
    expect(file).toMatch(new RegExp(`^${dir}/github-tarball-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.tar\\.gz$`))
  })

  it('follows a 307 exactly like a 302', async () => {
    const dir = await directory()
    const calls: string[] = []
    const gh = client(dir, codeload(() => bytes(Uint8Array.from([9, 8, 7])), 307, calls))
    const file = await gh.tarball('octo-org/repo-1', SHA)
    expect(new Uint8Array(await readFile(file))).toEqual(Uint8Array.from([9, 8, 7]))
    expect(calls).toEqual([`${API}${API_PATH}`, CODELOAD])
  })

  it.each([
    ['missing', undefined],
    ['malformed', 'not a url'],
  ])('fails loud on a %s Location header', async (_, location) => {
    const dir = await directory()
    const fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { ...(location ? { location } : {}), ...rateHeaders() },
      })) as typeof fetch
    const gh = client(dir, fetch)
    const error = await gh.tarball('octo-org/repo-1', SHA).catch((err: unknown) => err)
    expect(error).toMatchObject({ kind: 'unavailable', status: 302, path: API_PATH })
    expect((error as Error).message).toMatch(/Location/)
    expect(await readdir(dir)).toEqual([])
  })

  it('fails loud when codeload answers non-200', async () => {
    const dir = await directory()
    const gh = client(dir, codeload(() => new Response('boom', { status: 502 })))
    const error = await gh.tarball('octo-org/repo-1', SHA).catch((err: unknown) => err)
    expect(error).toMatchObject({ kind: 'unavailable', status: 502, path: API_PATH })
    expect(await readdir(dir)).toEqual([])
  })

  it('does not follow a redirect from codeload', async () => {
    const dir = await directory()
    const calls: string[] = []
    const gh = client(
      dir,
      codeload(() => new Response(null, { status: 302, headers: { location: `${CODELOAD}?again` } }), 302, calls),
    )
    const error = await gh.tarball('octo-org/repo-1', SHA).catch((err: unknown) => err)
    expect(error).toMatchObject({ kind: 'unavailable', status: 302, path: API_PATH })
    expect(calls).toEqual([`${API}${API_PATH}`, CODELOAD])
    expect(await readdir(dir)).toEqual([])
  })

  it('times the download with tarballTimeoutMs, not timeoutMs: a slow but finishing stream succeeds', async () => {
    const dir = await directory()
    const slow = () =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          for (let i = 0; i < 4; i++) {
            await new Promise((r) => setTimeout(r, 15))
            controller.enqueue(Uint8Array.from([i]))
          }
          controller.close()
        },
      })
    const gh = client(dir, codeload(() => new Response(slow(), { status: 200 })), { timeoutMs: 20, tarballTimeoutMs: 2000 })
    const file = await gh.tarball('octo-org/repo-1', SHA)
    expect(new Uint8Array(await readFile(file))).toEqual(Uint8Array.from([0, 1, 2, 3]))
  })

  it('aborts a download that outlives tarballTimeoutMs and removes the partial file', async () => {
    const dir = await directory()
    // A body that sends one chunk and then hangs, ignoring the abort signal.
    const hanging = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.from([1, 2, 3]))
        },
      })
    const gh = client(dir, codeload(() => new Response(hanging(), { status: 200 })), { tarballTimeoutMs: 50 })
    const started = Date.now()
    const error = await gh.tarball('octo-org/repo-1', SHA).catch((err: unknown) => err)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(error).toMatchObject({ kind: 'unavailable', path: API_PATH })
    expect((error as Error).message).toMatch(/50 ms/)
    expect(await readdir(dir)).toEqual([])
  })

  it('aborts a download over tarballMaxBytes and removes the partial file', async () => {
    const dir = await directory()
    let cancelled = false
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(400))
        },
        cancel() {
          cancelled = true
        },
      })
    const gh = client(dir, codeload(() => new Response(endless(), { status: 200 })), { tarballMaxBytes: 1000 })
    const error = await gh.tarball('octo-org/repo-1', SHA).catch((err: unknown) => err)
    expect(error).toMatchObject({ kind: 'too_large', status: null, path: API_PATH })
    expect((error as Error).message).toContain(API_PATH)
    expect((error as Error).message).toContain('1000')
    expect(cancelled).toBe(true)
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses a download whose content-length is over tarballMaxBytes before writing anything', async () => {
    const dir = await directory()
    const gh = client(
      dir,
      codeload(() => new Response(bytes(new Uint8Array(10)), { status: 200, headers: { 'content-length': '5000' } })),
      { tarballMaxBytes: 1000 },
    )
    const error = await gh.tarball('octo-org/repo-1', SHA).catch((err: unknown) => err)
    expect(error).toMatchObject({ kind: 'too_large', path: API_PATH })
    expect(await readdir(dir)).toEqual([])
  })
})

describe('sweepTarballs', () => {
  it('finds nothing to sweep when no tarball was ever downloaded (the directory does not exist yet)', async () => {
    const dir = join(await directory(), 'never-created')
    await expect(sweepTarballs(dir, 0, new Date())).resolves.toEqual([])
  })

  it('deletes only leftover github-tarball-*.tar.gz files older than the threshold', async () => {
    const dir = await directory()
    const now = new Date('2026-11-20T12:00:00Z')
    const old = 'github-tarball-11111111-1111-4111-8111-111111111111.tar.gz'
    const fresh = 'github-tarball-22222222-2222-4222-8222-222222222222.tar.gz'
    const other = 'notes.tar.gz'
    for (const name of [old, fresh, other]) await writeFile(join(dir, name), 'x')
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000)
    const minuteAgo = new Date(now.getTime() - 60 * 1000)
    await utimes(join(dir, old), hourAgo, hourAgo)
    await utimes(join(dir, other), hourAgo, hourAgo)
    await utimes(join(dir, fresh), minuteAgo, minuteAgo)

    const removed = await sweepTarballs(dir, 10 * 60 * 1000, now)

    expect(removed).toEqual([join(dir, old)])
    expect((await readdir(dir)).sort()).toEqual([fresh, other].sort())
  })
})

type Limits = { timeoutMs?: number; tarballTimeoutMs?: number; tarballMaxBytes?: number }

function client(dir: string, fetch: typeof globalThis.fetch, limits: Limits = {}) {
  return createGitHubTokenClient({
    token: TOKEN,
    fetch,
    timeoutMs: limits.timeoutMs ?? 1000,
    tarballDir: dir,
    tarballTimeoutMs: limits.tarballTimeoutMs ?? 1000,
    tarballMaxBytes: limits.tarballMaxBytes ?? 1024 * 1024,
  })
}

/** The API answers `status` to codeload; codeload answers with `download()`. */
function codeload(
  download: () => Response | ReadableStream<Uint8Array>,
  status = 302,
  calls: string[] = [],
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url === `${API}${API_PATH}`) {
      return new Response(null, { status, headers: { location: CODELOAD, ...rateHeaders() } })
    }
    if (url === CODELOAD) {
      const out = download()
      return out instanceof Response ? out : new Response(out, { status: 200 })
    }
    throw new Error(`unexpected URL ${url}`)
  }) as typeof fetch
}

describe('GitHubTokenClient with configured bases (the e2e mock GitHub seam)', () => {
  const MOCK_API = 'http://127.0.0.1:5197'
  const MOCK_CODELOAD = 'http://localhost:5197'

  it('sends every API request, Link pages and the tarball to apiBase, never to api.github.com', async () => {
    const dir = await directory()
    const calls: string[] = []
    const archive = Uint8Array.from([7, 8, 9])
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      calls.push(url)
      if (url === `${MOCK_API}/user`) {
        return new Response(JSON.stringify({ login: 'octo' }), { status: 200, headers: rateHeaders() })
      }
      if (url === `${MOCK_API}/user/repos?page=2`) return new Response('[]', { status: 200, headers: rateHeaders() })
      if (url.startsWith(`${MOCK_API}/user/repos?`)) {
        return new Response('[]', {
          status: 200,
          headers: { link: `<${MOCK_API}/user/repos?page=2>; rel="next"`, ...rateHeaders() },
        })
      }
      if (url === `${MOCK_API}${API_PATH}`) {
        return new Response(null, { status: 302, headers: { location: `${MOCK_CODELOAD}/x.tar.gz`, ...rateHeaders() } })
      }
      if (url === `${MOCK_CODELOAD}/x.tar.gz`) return new Response(archive, { status: 200 })
      throw new Error(`unexpected URL ${url}`)
    }) as typeof fetch
    const gh = createGitHubTokenClient({
      token: TOKEN,
      fetch,
      timeoutMs: 1000,
      tarballDir: dir,
      tarballTimeoutMs: 1000,
      tarballMaxBytes: 1024,
      apiBase: `${MOCK_API}/`,
      codeloadOrigin: MOCK_CODELOAD,
    })

    expect((await gh.identity()).login).toBe('octo')
    expect(await gh.repos()).toEqual([])
    expect(new Uint8Array(await readFile(await gh.tarball('octo-org/repo-1', SHA)))).toEqual(archive)
    expect(calls).toContain(`${MOCK_API}/user/repos?page=2`)
    expect(calls.some((url) => url.startsWith(API))).toBe(false)
  })

  it('refuses a redirect to anything but codeloadOrigin, the real codeload included', async () => {
    for (const location of [
      'https://codeload.github.com/x.tar.gz',
      `${MOCK_API}/x.tar.gz`,
      'http://localhost:5198/x.tar.gz',
    ]) {
      const dir = await directory()
      const calls: string[] = []
      const fetch = (async (input: string | URL | Request) => {
        calls.push(String(input))
        return new Response(null, { status: 302, headers: { location, ...rateHeaders() } })
      }) as typeof fetch
      const gh = createGitHubTokenClient({
        token: TOKEN,
        fetch,
        timeoutMs: 1000,
        tarballDir: dir,
        tarballTimeoutMs: 1000,
        tarballMaxBytes: 1024,
        apiBase: MOCK_API,
        codeloadOrigin: MOCK_CODELOAD,
      })
      await expect(gh.tarball('octo-org/repo-1', SHA)).rejects.toThrow(/refusing to follow/)
      expect(calls).toEqual([`${MOCK_API}${API_PATH}`])
      expect(await readdir(dir)).toEqual([])
    }
  })

  it('refuses a Link page outside apiBase (the token stays on the configured root)', async () => {
    const fetch = (async () =>
      new Response('[]', {
        status: 200,
        headers: { link: `<${API}/user/repos?page=2>; rel="next"`, ...rateHeaders() },
      })) as typeof fetch
    const gh = createGitHubTokenClient({
      token: TOKEN,
      fetch,
      timeoutMs: 1000,
      tarballDir: '/tmp',
      tarballTimeoutMs: 1000,
      tarballMaxBytes: 1024,
      apiBase: MOCK_API,
      codeloadOrigin: MOCK_CODELOAD,
    })
    await expect(gh.repos()).rejects.toThrow(/refusing to send the GitHub token outside/)
  })

  it('fails loud on a malformed apiBase or a codeloadOrigin that is not a bare origin', () => {
    const base = {
      token: TOKEN,
      fetch: (async () => new Response(null)) as typeof fetch,
      timeoutMs: 1000,
      tarballDir: '/tmp',
      tarballTimeoutMs: 1,
      tarballMaxBytes: 1,
    }
    expect(() => createGitHubTokenClient({ ...base, apiBase: 'api.github.com' })).toThrow(/apiBase/)
    expect(() => createGitHubTokenClient({ ...base, codeloadOrigin: 'http://localhost:5197/' })).toThrow(/codeloadOrigin/)
    expect(() => createGitHubTokenClient({ ...base, codeloadOrigin: 'nope' })).toThrow(/codeloadOrigin/)
  })
})
