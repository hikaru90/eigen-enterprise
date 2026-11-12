import type { GitHubTokenError } from './token-client'
import { describe, expect, it } from 'vitest'
import { createGitHubTokenClient, isGitHubTokenError, tokenRequest } from './token'
import {
  API,
  blobBody,
  branchesBody,
  commitBody,
  compareBody,
  fakeGitHub,
  pullBody,
  rateHeaders,
  repoBody,
  treeBody,
  userBody,
} from './token-fixtures'

const TOKEN = 'github_pat_11ABCDEFG0123456789_secretsecretsecretsecret'

function client(routes: Parameters<typeof fakeGitHub>[0], timeoutMs = 5000) {
  const fake = fakeGitHub(routes)
  return { ...fake, gh: createGitHubTokenClient({ token: TOKEN, fetch: fake.impl, timeoutMs }) }
}

async function failure(p: Promise<unknown>): Promise<GitHubTokenError> {
  const err = await p.then(
    () => {
      throw new Error('expected a failure')
    },
    (e: unknown) => e,
  )
  if (!isGitHubTokenError(err)) throw new Error(`not a GitHubTokenError: ${String(err)}`)
  return err
}

function linkTo(path: string, rel = 'next') {
  return { link: `<${API}${path}>; rel="${rel}", <${API}/x?page=99>; rel="last"` }
}

describe('token client: requests', () => {
  it('sends the token as a Bearer header with the API version, GET only', async () => {
    const { gh, calls } = client({ 'GET /user': { status: 200, body: userBody } })
    await gh.identity()
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe(`${API}/user`)
    expect(calls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(calls[0].headers['x-github-api-version']).toBe('2022-11-28')
    expect(calls[0].headers.accept).toBe('application/vnd.github+json')
  })

  it('refuses every non-GET method before anything is sent', async () => {
    const fake = fakeGitHub({})
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
      const err = await failure(
        tokenRequest({ token: TOKEN, fetch: fake.impl, timeoutMs: 1000 }, method, '/user', null),
      )
      expect(err.kind).toBe('write_refused')
      expect(err.status).toBeNull()
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('needs a token and a positive timeout', () => {
    const { impl } = fakeGitHub({})
    expect(() => createGitHubTokenClient({ token: '', fetch: impl, timeoutMs: 1000 })).toThrow()
    expect(() => createGitHubTokenClient({ token: TOKEN, fetch: impl, timeoutMs: 0 })).toThrow()
  })

  it('rejects a repo name that is not owner/name', async () => {
    const { gh, calls } = client({})
    await expect(gh.repo('just-a-name', null)).rejects.toThrow(/owner\/name/)
    await expect(gh.repo('a/b/c', null)).rejects.toThrow(/owner\/name/)
    expect(calls).toHaveLength(0)
  })
})

describe('token client: conditional requests', () => {
  it('sends If-None-Match and reports a 304 as notModified', async () => {
    const { gh, calls } = client({
      'GET /repos/octo-org/repo-1': { status: 304, headers: { etag: 'W/"abc"' } },
    })
    const out = await gh.repo('octo-org/repo-1', 'W/"abc"')
    expect(out).toEqual({ notModified: true, etag: 'W/"abc"' })
    expect(calls[0].headers['if-none-match']).toBe('W/"abc"')
  })

  it('sends no If-None-Match without a stored ETag and returns the new one', async () => {
    const { gh, calls } = client({
      'GET /repos/octo-org/repo-1': { status: 200, body: repoBody(1), headers: { etag: '"v2"' } },
    })
    const out = await gh.repo('octo-org/repo-1', null)
    expect(calls[0].headers['if-none-match']).toBeUndefined()
    expect(out.notModified).toBe(false)
    if (out.notModified) return
    expect(out.etag).toBe('"v2"')
    expect(out.data).toEqual({
      id: 501,
      fullName: 'octo-org/repo-1',
      owner: 'octo-org',
      name: 'repo-1',
      private: false,
      archived: false,
      defaultBranch: 'main',
      description: 'The first repo',
      htmlUrl: 'https://github.com/octo-org/repo-1',
      pushedAt: new Date('2026-11-10T09:30:00Z'),
    })
  })

  it('branches: one page keeps the ETag; several pages drop it (page 1 alone cannot vouch for the rest)', async () => {
    const one = client({
      'GET /repos/octo-org/repo-1/branches?per_page=100': {
        status: 200,
        body: branchesBody,
        headers: { etag: '"b1"' },
      },
    })
    const single = await one.gh.branches('octo-org/repo-1', null)
    expect(single).toEqual({
      notModified: false,
      etag: '"b1"',
      data: [
        { name: 'feature/drive', headSha: 'b'.repeat(40) },
        { name: 'main', headSha: 'a'.repeat(40) },
      ],
    })

    const two = client({
      'GET /repos/octo-org/repo-1/branches?per_page=100': {
        status: 200,
        body: branchesBody.slice(0, 1),
        headers: { etag: '"b1"', ...linkTo('/repositories/501/branches?per_page=100&page=2') },
      },
      'GET /repositories/501/branches?per_page=100&page=2': {
        status: 200,
        body: branchesBody.slice(1),
      },
    })
    const paged = await two.gh.branches('octo-org/repo-1', '"old"')
    expect(paged.notModified).toBe(false)
    if (paged.notModified) return
    expect(paged.etag).toBeNull()
    expect(paged.data.map((b) => b.name)).toEqual(['feature/drive', 'main'])
    expect(two.calls[0].headers['if-none-match']).toBe('"old"')
    expect(two.calls[1].headers['if-none-match']).toBeUndefined()
  })
})

describe('token client: paging', () => {
  it('follows Link rel="next" for repos (all pages, fine-grained params)', async () => {
    const { gh, calls } = client({
      'GET /user/repos?per_page=100&visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name':
        {
          status: 200,
          body: [repoBody(1), repoBody(2)],
          headers: linkTo('/user/repos?per_page=100&page=2'),
        },
      'GET /user/repos?per_page=100&page=2': {
        status: 200,
        body: [repoBody(3, { archived: true })],
      },
    })
    const repos = await gh.repos()
    expect(repos.map((r) => r.fullName)).toEqual([
      'octo-org/repo-1',
      'octo-org/repo-2',
      'octo-org/repo-3',
    ])
    expect(repos[1].private).toBe(true)
    expect(repos[2].archived).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('an empty list is an empty list (an org that has not approved the token yet)', async () => {
    const { gh } = client({
      'GET /user/repos?per_page=100&visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name':
        { status: 200, body: [] },
    })
    expect(await gh.repos()).toEqual([])
  })

  it('fails loudly past the page cap', async () => {
    const routes: Record<
      string,
      { status: number; body: unknown; headers: Record<string, string> }
    > = {
      'GET /user/repos?per_page=100&visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name':
        { status: 200, body: [repoBody(0)], headers: linkTo('/user/repos?page=2') },
    }
    for (let p = 2; p <= 60; p++) {
      routes[`GET /user/repos?page=${p}`] = {
        status: 200,
        body: [repoBody(p)],
        headers: linkTo(`/user/repos?page=${p + 1}`),
      }
    }
    const { gh, calls } = client(routes)
    await expect(gh.repos()).rejects.toThrow(/more than 50 pages/)
    expect(calls).toHaveLength(50)
  })

  it('never follows a next link off the GitHub API (the token would go with it)', async () => {
    const { gh, calls } = client({
      'GET /user/repos?per_page=100&visibility=all&affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name':
        {
          status: 200,
          body: [repoBody(1)],
          headers: { link: '<https://evil.example.com/user/repos?page=2>; rel="next"' },
        },
    })
    await expect(gh.repos()).rejects.toThrow(/outside https:\/\/api\.github\.com/)
    expect(calls).toHaveLength(1)
  })
})

describe('token client: errors', () => {
  it('401 is unauthorized', async () => {
    const { gh } = client({
      'GET /user': { status: 401, body: { message: 'Bad credentials', status: '401' } },
    })
    const err = await failure(gh.identity())
    expect(err.kind).toBe('unauthorized')
    expect(err.status).toBe(401)
    expect(err.path).toBe('/user')
    expect(err.resumeAt).toBeNull()
  })

  it('403 and 404 are no_access', async () => {
    const { gh } = client({
      'GET /repos/octo-org/gone': {
        status: 403,
        body: { message: 'Resource not accessible by personal access token' },
        headers: { 'x-accepted-github-permissions': 'metadata=read' },
      },
    })
    expect((await failure(gh.repo('octo-org/gone', null))).kind).toBe('no_access')
    expect((await failure(gh.repo('octo-org/missing', null))).kind).toBe('no_access')
  })

  it('a 403 on a read beyond metadata is missing_permission, naming the permission (a private repo without Pull requests: read)', async () => {
    const denied = (accepted: string) => ({
      status: 403,
      body: { message: 'Resource not accessible by personal access token' },
      headers: { 'x-accepted-github-permissions': accepted },
    })
    const { gh } = client({
      'GET /repos/octo-org/private/pulls?state=all&sort=updated&direction=desc&per_page=100': denied('pull_requests=read'),
      'GET /repos/octo-org/private/pulls?state=open&sort=created&direction=desc&per_page=100': denied('pull_requests=read'),
      'GET /repos/octo-org/private/git/trees/abc?recursive=1': denied('contents=read'),
    })
    const pulls = await failure(gh.pulls('octo-org/private', new Date('2026-10-01T00:00:00Z'), null))
    expect(pulls).toMatchObject({ kind: 'missing_permission', permission: 'pull_requests', status: 403 })
    expect(await failure(gh.openPulls('octo-org/private', null))).toMatchObject({ kind: 'missing_permission', permission: 'pull_requests' })
    expect(await failure(gh.tree('octo-org/private', 'abc'))).toMatchObject({ kind: 'missing_permission', permission: 'contents' })
    // A 404 stays no_access: GitHub hides what the token can't see.
    expect(await failure(gh.tree('octo-org/private', 'nope'))).toMatchObject({ kind: 'no_access', permission: 'contents' })
  })

  it('checkAccess lists the permissions the token lacks on a repo; an unseen repo is no_access', async () => {
    const ok = { status: 200, body: [] }
    const repoBody = { status: 200, body: { id: 1 } }
    const { gh } = client({
      'GET /repos/octo-org/private': repoBody,
      'GET /repos/octo-org/private/commits?per_page=1': ok,
      'GET /repos/octo-org/private/pulls?state=open&per_page=1': {
        status: 403,
        body: { message: 'Resource not accessible by personal access token' },
      },
      'GET /repos/octo-org/full': repoBody,
      'GET /repos/octo-org/full/commits?per_page=1': { status: 409, body: { message: 'Git Repository is empty.' } },
      'GET /repos/octo-org/full/pulls?state=open&per_page=1': ok,
    })
    expect(await gh.checkAccess('octo-org/private')).toEqual(['pull_requests'])
    expect(await gh.checkAccess('octo-org/full')).toEqual([])
    expect((await failure(gh.checkAccess('octo-org/unseen'))).kind).toBe('no_access')
  })

  it('an exhausted primary limit is rate_limited until the reset', async () => {
    const { gh } = client({
      'GET /user': {
        status: 403,
        body: { message: 'API rate limit exceeded for user ID 1001.' },
        headers: rateHeaders(0, 5000, 1762953600),
      },
    })
    const err = await failure(gh.identity())
    expect(err.kind).toBe('rate_limited')
    expect(err.resumeAt).toEqual(new Date(1762953600 * 1000))
    expect(gh.lastBudget()).toEqual({
      remaining: 0,
      limit: 5000,
      resetAt: new Date(1762953600 * 1000),
    })
  })

  it('a secondary limit honours retry-after (403 or 429)', async () => {
    for (const status of [403, 429]) {
      const { gh } = client({
        'GET /user': {
          status,
          body: {
            message: 'You have exceeded a secondary rate limit.',
            documentation_url:
              'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits',
          },
          headers: { 'retry-after': '120' },
        },
      })
      const before = Date.now()
      const err = await failure(gh.identity())
      expect(err.kind).toBe('rate_limited')
      expect(err.resumeAt!.getTime()).toBeGreaterThanOrEqual(before + 120_000)
      expect(err.resumeAt!.getTime()).toBeLessThan(before + 125_000)
    }
  })

  it('a 429 without retry-after waits at least a minute (GitHub docs)', async () => {
    const { gh } = client({ 'GET /user': { status: 429, body: { message: 'slow down' } } })
    const before = Date.now()
    const err = await failure(gh.identity())
    expect(err.kind).toBe('rate_limited')
    expect(err.resumeAt!.getTime()).toBeGreaterThanOrEqual(before + 60_000)
  })

  it('5xx is unavailable', async () => {
    const { gh } = client({ 'GET /user': { status: 502, body: { message: 'Server Error' } } })
    const err = await failure(gh.identity())
    expect(err.kind).toBe('unavailable')
    expect(err.status).toBe(502)
  })

  it('a network failure is unavailable', async () => {
    const gh = createGitHubTokenClient({
      token: TOKEN,
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
      timeoutMs: 1000,
    })
    const err = await failure(gh.identity())
    expect(err.kind).toBe('unavailable')
    expect(err.status).toBeNull()
  })

  it('a request that outlives the timeout is aborted and unavailable', async () => {
    let signal: AbortSignal | undefined
    const gh = createGitHubTokenClient({
      token: TOKEN,
      fetch: ((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        })
      }) as typeof fetch,
      timeoutMs: 20,
    })
    const err = await failure(gh.identity())
    expect(err.kind).toBe('unavailable')
    expect(err.message).toMatch(/20 ms/)
    expect(signal?.aborted).toBe(true)
  })

  it('other statuses (409 empty repo, 422) are unavailable with the status kept for the caller', async () => {
    const { gh } = client({
      'GET /repos/octo-org/empty/commits?sha=main&since=2026-10-13T00%3A00%3A00.000Z&per_page=100':
        {
          status: 409,
          body: { message: 'Git Repository is empty.' },
        },
    })
    const err = await failure(
      gh.commits('octo-org/empty', 'main', new Date('2026-10-13T00:00:00Z'), 100),
    )
    expect(err.kind).toBe('unavailable')
    expect(err.status).toBe(409)
  })
})

describe('token client: the token never leaks', () => {
  it('no error message, stack, cause or JSON carries the token', async () => {
    const echo = `Bad credentials for ${TOKEN}`
    const errors: unknown[] = []
    const scenarios: Array<Parameters<typeof fakeGitHub>[0]> = [
      { 'GET /user': { status: 401, body: { message: echo } } },
      { 'GET /user': { status: 403, body: { message: echo } } },
      { 'GET /user': { status: 500, body: echo } },
      { 'GET /user': { status: 429, body: { message: echo }, headers: { 'retry-after': '5' } } },
    ]
    for (const routes of scenarios) {
      const { gh } = client(routes)
      errors.push(await gh.identity().catch((e: unknown) => e))
    }
    const network = createGitHubTokenClient({
      token: TOKEN,
      fetch: (async (_u: string, init?: RequestInit) => {
        throw new Error(`connect failed with ${new Headers(init?.headers).get('authorization')}`)
      }) as typeof fetch,
      timeoutMs: 1000,
    })
    errors.push(await network.identity().catch((e: unknown) => e))
    errors.push(
      await tokenRequest(
        { token: TOKEN, fetch: fakeGitHub({}).impl, timeoutMs: 10 },
        'DELETE',
        '/x',
        null,
      ).catch((e: unknown) => e),
    )

    expect(errors).toHaveLength(6)
    for (const err of errors) {
      expect(isGitHubTokenError(err)).toBe(true)
      const e = err as Error
      const cause = (e as { cause?: unknown }).cause
      const dump = [
        e.message,
        e.stack ?? '',
        String(e),
        JSON.stringify(e),
        String(cause),
        cause instanceof Error ? (cause.stack ?? '') : '',
        JSON.stringify(cause ?? null),
      ].join('\n')
      expect(dump).not.toContain(TOKEN)
      expect(dump).not.toContain('secretsecret')
    }
  })
})

describe('token client: identity', () => {
  it('reads the login, the expiry header and the budget; a fine-grained token is not classic', async () => {
    const { gh } = client({
      'GET /user': {
        status: 200,
        body: userBody,
        headers: { 'github-authentication-token-expiration': '2027-02-10 08:15:00 UTC' },
      },
    })
    expect(gh.lastBudget()).toBeNull()
    const id = await gh.identity()
    expect(id).toEqual({
      login: 'octo-owner',
      expiresAt: new Date('2027-02-10T08:15:00Z'),
      classic: false,
      budget: { remaining: 4987, limit: 5000, resetAt: new Date(1762950000 * 1000) },
    })
    expect(gh.lastBudget()).toEqual(id.budget)
  })

  it('reads an expiry given with a numeric offset', async () => {
    const { gh } = client({
      'GET /user': {
        status: 200,
        body: userBody,
        headers: { 'github-authentication-token-expiration': '2027-02-10 09:15:00 +0100' },
      },
    })
    expect((await gh.identity()).expiresAt).toEqual(new Date('2027-02-10T08:15:00Z'))
  })

  it('no expiry header means no expiry', async () => {
    const { gh } = client({ 'GET /user': { status: 200, body: userBody } })
    expect((await gh.identity()).expiresAt).toBeNull()
  })

  it('an expiry header it cannot read fails loudly', async () => {
    const { gh } = client({
      'GET /user': {
        status: 200,
        body: userBody,
        headers: { 'github-authentication-token-expiration': 'next tuesday' },
      },
    })
    await expect(gh.identity()).rejects.toThrow(/expiration header/)
  })

  it('x-oauth-scopes marks a classic token, even when it is empty', async () => {
    for (const scopes of ['repo, workflow', '']) {
      const { gh } = client({
        'GET /user': { status: 200, body: userBody, headers: { 'x-oauth-scopes': scopes } },
      })
      expect((await gh.identity()).classic).toBe(true)
    }
  })

  it('a response without rate-limit headers fails loudly (identity needs the budget)', async () => {
    const gh = createGitHubTokenClient({
      token: TOKEN,
      fetch: (async () =>
        new Response(JSON.stringify(userBody), { status: 200 })) as unknown as typeof fetch,
      timeoutMs: 1000,
    })
    await expect(gh.identity()).rejects.toThrow(/rate-limit headers/)
  })
})

describe('token client: activity endpoints', () => {
  const since = new Date('2026-10-13T00:00:00Z')

  it('commits: branch + since, first line as subject, a null GitHub author keeps the git name', async () => {
    const { gh } = client({
      'GET /repos/octo-org/repo-1/commits?sha=feature%2Fdrive&since=2026-10-13T00%3A00%3A00.000Z&per_page=3':
        { status: 200, body: [commitBody(1), commitBody(2, { author: null }), commitBody(3)] },
    })
    const commits = await gh.commits('octo-org/repo-1', 'feature/drive', since, 3)
    expect(commits).toHaveLength(3)
    expect(commits[0]).toEqual({
      sha: commitBody(1).sha,
      subject: 'Commit subject 1',
      authorName: 'Dev 1',
      authorLogin: 'dev1',
      date: new Date('2026-11-02T12:00:00Z'),
      htmlUrl: commitBody(1).html_url,
    })
    expect(commits[1].authorLogin).toBeNull()
    expect(commits[1].authorName).toBe('Dev 2')
  })

  it('commits: pages until the limit, never past it', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => commitBody(i))
    const { gh, calls } = client({
      'GET /repos/octo-org/repo-1/commits?sha=main&since=2026-10-13T00%3A00%3A00.000Z&per_page=100':
        {
          status: 200,
          body: page1,
          headers: linkTo('/repositories/501/commits?page=2'),
        },
      'GET /repositories/501/commits?page=2': {
        status: 200,
        body: [commitBody(100), commitBody(101), commitBody(102)],
        headers: linkTo('/repositories/501/commits?page=3'),
      },
    })
    const commits = await gh.commits('octo-org/repo-1', 'main', since, 102)
    expect(commits).toHaveLength(102)
    expect(calls).toHaveLength(2)
  })

  it('compare: ahead/behind of base...head', async () => {
    const { gh } = client({
      'GET /repos/octo-org/repo-1/compare/main...feature%2Fdrive?per_page=1': {
        status: 200,
        body: compareBody,
      },
    })
    expect(await gh.compare('octo-org/repo-1', 'main', 'feature/drive')).toEqual({
      aheadBy: 3,
      behindBy: 1,
    })
  })

  it('pulls: all states by updated desc, stopping at the first one updated before the cutoff', async () => {
    const { gh, calls } = client({
      'GET /repos/octo-org/repo-1/pulls?state=all&sort=updated&direction=desc&per_page=100': {
        status: 200,
        body: [
          pullBody(1, '2026-11-11T10:00:00Z', { draft: true }),
          pullBody(2, '2026-11-01T10:00:00Z', {
            state: 'closed',
            closed_at: '2026-11-01T10:00:00Z',
            merged_at: '2026-11-01T10:00:00Z',
          }),
        ],
        headers: { etag: '"p1"', ...linkTo('/repositories/501/pulls?page=2') },
      },
      'GET /repositories/501/pulls?page=2': {
        status: 200,
        body: [
          pullBody(3, '2026-10-20T10:00:00Z', {
            state: 'closed',
            closed_at: '2026-10-20T10:00:00Z',
          }),
          pullBody(4, '2026-09-01T10:00:00Z'),
          pullBody(5, '2026-11-12T10:00:00Z'),
        ],
        headers: linkTo('/repositories/501/pulls?page=3'),
      },
    })
    const out = await gh.pulls('octo-org/repo-1', since, null)
    expect(calls).toHaveLength(2)
    expect(out.notModified).toBe(false)
    if (out.notModified) return
    expect(out.etag).toBe('"p1"')
    expect(out.data.map((p) => p.number)).toEqual([1, 2, 3])
    expect(out.data[0]).toEqual({
      number: 1,
      title: 'PR 1',
      state: 'open',
      merged: false,
      draft: true,
      authorLogin: 'dev1',
      headRef: 'feature/drive',
      baseRef: 'main',
      labels: ['enhancement'],
      requestedReviewers: ['reviewer-a'],
      body: 'Adds the Drive folder.',
      createdAt: new Date('2026-11-01T08:00:00Z'),
      updatedAt: new Date('2026-11-11T10:00:00Z'),
      closedAt: null,
      mergedAt: null,
      htmlUrl: 'https://github.com/octo-org/repo-1/pull/1',
    })
    expect(out.data[1]).toMatchObject({ state: 'closed', merged: true })
    expect(out.data[2]).toMatchObject({ state: 'closed', merged: false })
  })

  it('pulls: a 304 on the first page is notModified', async () => {
    const { gh } = client({
      'GET /repos/octo-org/repo-1/pulls?state=all&sort=updated&direction=desc&per_page=100': {
        status: 304,
        headers: { etag: '"p1"' },
      },
    })
    expect(await gh.pulls('octo-org/repo-1', since, '"p1"')).toEqual({
      notModified: true,
      etag: '"p1"',
    })
  })

  it('openPulls: every open pull request, all pages, however long ago it was updated', async () => {
    const { gh, calls } = client({
      'GET /repos/octo-org/repo-1/pulls?state=open&sort=created&direction=desc&per_page=100': {
        status: 200,
        body: [pullBody(9, '2026-11-11T10:00:00Z'), pullBody(7, '2025-01-01T10:00:00Z')],
        headers: { etag: '"o1"', ...linkTo('/repositories/501/pulls?page=2') },
      },
      'GET /repositories/501/pulls?page=2': {
        status: 200,
        body: [pullBody(2, '2024-03-01T10:00:00Z')],
      },
    })
    const out = await gh.openPulls('octo-org/repo-1', null)
    expect(calls).toHaveLength(2)
    expect(out.notModified).toBe(false)
    if (out.notModified) return
    expect(out.data.map((p) => p.number)).toEqual([9, 7, 2])
    expect(out.data.every((p) => p.state === 'open')).toBe(true)
    // Page 1's ETag can't vouch for page 2 (a PR closed there would go unseen).
    expect(out.etag).toBeNull()
  })

  it('openPulls: one page keeps its ETag, and a 304 is notModified', async () => {
    const one = client({
      'GET /repos/octo-org/repo-1/pulls?state=open&sort=created&direction=desc&per_page=100': {
        status: 200,
        body: [pullBody(9, '2026-11-11T10:00:00Z')],
        headers: { etag: '"o1"' },
      },
    })
    const out = await one.gh.openPulls('octo-org/repo-1', null)
    expect(out).toMatchObject({ notModified: false, etag: '"o1"' })
    const again = client({
      'GET /repos/octo-org/repo-1/pulls?state=open&sort=created&direction=desc&per_page=100': {
        status: 304,
        headers: { etag: '"o1"' },
      },
    })
    expect(await again.gh.openPulls('octo-org/repo-1', '"o1"')).toEqual({ notModified: true, etag: '"o1"' })
    expect(again.calls[0].headers['if-none-match']).toBe('"o1"')
  })

  it('tree: recursive, blobs only, truncated flag', async () => {
    const { gh } = client({
      [`GET /repos/octo-org/repo-1/git/trees/${'a'.repeat(40)}?recursive=1`]: {
        status: 200,
        body: { ...treeBody, truncated: true },
      },
    })
    expect(await gh.tree('octo-org/repo-1', 'a'.repeat(40))).toEqual({
      entries: [
        { path: 'README.md', sha: '1'.repeat(40), size: 1200 },
        { path: 'docs/guide.md', sha: '3'.repeat(40), size: 640 },
      ],
      truncated: true,
    })
  })

  it('blobText: base64 (with GitHub line breaks) decoded as UTF-8', async () => {
    const text = `# Hello\n\nÜmlaut, emoji \u{1F680}, ${'long line '.repeat(20)}\n`
    const { gh } = client({
      [`GET /repos/octo-org/repo-1/git/blobs/${'1'.repeat(40)}`]: {
        status: 200,
        body: blobBody(text),
      },
    })
    expect(await gh.blobText('octo-org/repo-1', '1'.repeat(40))).toBe(text)
  })

  it('blobText: bytes that are not UTF-8 fail loudly', async () => {
    const { gh } = client({
      [`GET /repos/octo-org/repo-1/git/blobs/${'1'.repeat(40)}`]: {
        status: 200,
        body: { ...blobBody(''), content: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') },
      },
    })
    await expect(gh.blobText('octo-org/repo-1', '1'.repeat(40))).rejects.toThrow(/UTF-8/)
  })
})
