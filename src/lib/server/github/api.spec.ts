import { describe, expect, it } from 'vitest'
import { GitHubApi, GitHubApiError } from './api'

type Call = { url: string; auth: string | null; method: string }

function fakeFetch(
  routes: Record<string, { status: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, auth: headers.authorization ?? null, method: init?.method ?? 'GET' })
    const route = routes[url.replace('https://api.github.com', '')]
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: route.headers,
    })
  }) as typeof fetch
  return { calls, impl }
}

const repoBody = {
  id: 42,
  full_name: 'kindred/site',
  default_branch: 'main',
  private: false,
  clone_url: 'https://github.com/kindred/site.git',
  html_url: 'https://github.com/kindred/site',
}

describe('GitHubApi: public repositories need no auth', () => {
  it('reads a public repo without an authorization header', async () => {
    const { calls, impl } = fakeFetch({ '/repos/kindred/site': { status: 200, body: repoBody } })
    const repo = await new GitHubApi(impl).repo('kindred', 'site', null)
    expect(repo).toMatchObject({
      id: 42,
      full_name: 'kindred/site',
      private: false,
      default_branch: 'main',
    })
    expect(calls[0].auth).toBeNull()
  })

  it('a missing repo is a GitHubApiError with status 404', async () => {
    const { impl } = fakeFetch({})
    const err = await new GitHubApi(impl).repo('kindred', 'nope', null).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubApiError)
    expect((err as GitHubApiError).status).toBe(404)
  })

  it('a used-up rate limit carries the reset time', async () => {
    const { impl } = fakeFetch({
      '/repos/kindred/site': {
        status: 403,
        body: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1760000000' },
      },
    })
    const err = (await new GitHubApi(impl)
      .repo('kindred', 'site', null)
      .catch((e: unknown) => e)) as GitHubApiError
    expect(err.rateLimited).toBe(true)
    expect(err.rateLimitReset?.toISOString()).toBe(new Date(1760000000 * 1000).toISOString())
  })

  it('lists every branch across pages', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `b${i}` }))
    const { impl } = fakeFetch({
      '/repos/kindred/site/branches?per_page=100&page=1': { status: 200, body: page1 },
      '/repos/kindred/site/branches?per_page=100&page=2': { status: 200, body: [{ name: 'main' }] },
    })
    const branches = await new GitHubApi(impl).branches('kindred', 'site', null)
    expect(branches).toHaveLength(101)
    expect(branches.at(-1)).toBe('main')
  })

  it('reads the last commit of a branch', async () => {
    const { impl } = fakeFetch({
      '/repos/kindred/site/commits/main': {
        status: 200,
        body: {
          sha: 'a'.repeat(40),
          commit: { message: 'Fix header\n\nlong body', author: { date: '2026-10-01T10:00:00Z' } },
        },
      },
    })
    expect(await new GitHubApi(impl).lastCommit('kindred', 'site', 'main', 'tok')).toEqual({
      sha: 'a'.repeat(40),
      message: 'Fix header',
      date: '2026-10-01T10:00:00Z',
    })
  })
})

describe('GitHubApi: installation repositories', () => {
  it('pages through /installation/repositories with the installation token', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      ...repoBody,
      id: i,
      full_name: `kindred/r${i}`,
      private: true,
    }))
    const { calls, impl } = fakeFetch({
      '/installation/repositories?per_page=100&page=1': {
        status: 200,
        body: { total_count: 101, repositories: page1 },
      },
      '/installation/repositories?per_page=100&page=2': {
        status: 200,
        body: {
          total_count: 101,
          repositories: [{ ...repoBody, id: 500, full_name: 'kindred/last', private: true }],
        },
      },
    })
    const repos = await new GitHubApi(impl).installationRepos('inst-tok')
    expect(repos).toHaveLength(101)
    expect(repos.at(-1)?.full_name).toBe('kindred/last')
    expect(calls.every((c) => c.auth === 'token inst-tok')).toBe(true)
  })
})
