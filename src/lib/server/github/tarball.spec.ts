import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitHubTokenClient, type GitHubTokenConfig } from './token'
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
    }
    expect(() => createGitHubTokenClient(config as GitHubTokenConfig)).toThrow(/tarballDir/)
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
    const gh = createGitHubTokenClient({ token: TOKEN, fetch, timeoutMs: 1000, tarballDir: dir })

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
    const gh = createGitHubTokenClient({ token: TOKEN, fetch, timeoutMs: 1000, tarballDir: dir })

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
    const gh = createGitHubTokenClient({ token: TOKEN, fetch, timeoutMs: 1000, tarballDir: dir })

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
    const gh = createGitHubTokenClient({ token: TOKEN, fetch, timeoutMs: 1000, tarballDir: dir })

    const error = await gh.tarball('octo-org/repo-1', SHA).catch((err: unknown) => err)
    expect(error).toMatchObject({ kind: 'rate_limited', status: 403, path: API_PATH })
    expect(JSON.stringify(error)).not.toContain(TOKEN)
    expect(String((error as Error).cause)).not.toContain(TOKEN)
    expect(await readdir(dir)).toEqual([])
  })
})
