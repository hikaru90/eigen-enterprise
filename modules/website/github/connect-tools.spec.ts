import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { GitHubApi } from '$lib/server/github/api'
import { GitHubUserError } from '$lib/server/github/plain-errors'
import { createGitHubConnectTools } from './connect-tools'
import { GITHUB_CONNECT_TOOL_NAMES } from './manifest'
import { InMemoryConnectedRepoStore } from './repos-store'
import { InMemoryGitHubStore } from './store'

const human: ToolContext = {
  principal: { id: 'u1', kind: 'human', roles: ['admin'] },
  requestId: 'r',
}

type Route = { status: number; body: unknown; headers?: Record<string, string> }

/** A mocked api.github.com: routes keyed by "<auth> <path>", auth = "none" or the token. */
function mockGitHub(routes: Record<string, Route>) {
  const seen: string[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const path = String(input).replace('https://api.github.com', '')
    const auth = ((init?.headers ?? {}) as Record<string, string>).authorization ?? 'none'
    const key = `${auth} ${init?.method ?? 'GET'} ${path}`
    seen.push(key)
    const route = routes[key]
    if (!route) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: route.headers,
    })
  }) as typeof fetch
  return { seen, api: new GitHubApi(impl) }
}

const site = {
  id: 42,
  full_name: 'kindred/site',
  default_branch: 'main',
  private: false,
  clone_url: 'https://github.com/kindred/site.git',
  html_url: 'https://github.com/kindred/site',
}
const app = {
  ...site,
  id: 7,
  full_name: 'kindred/app',
  private: true,
  clone_url: 'https://github.com/kindred/app.git',
  html_url: 'https://github.com/kindred/app',
}
const commit = {
  sha: 'a'.repeat(40),
  commit: { message: 'Ship it\n\nbody', author: { date: '2026-10-01T10:00:00Z' } },
}

const publicRoutes: Record<string, Route> = {
  'none GET /repos/kindred/site': { status: 200, body: site },
  'none GET /repos/kindred/site/branches?per_page=100&page=1': {
    status: 200,
    body: [{ name: 'main' }, { name: 'staging' }],
  },
  'none GET /repos/kindred/site/commits/main': { status: 200, body: commit },
}

function setup(routes: Record<string, Route>, installed: boolean) {
  const github = new InMemoryGitHubStore()
  if (installed) {
    github.conn = {
      appId: 5,
      appSlug: 'eigen-kindred',
      clientId: 'c',
      htmlUrl: 'https://github.com/apps/eigen-kindred',
      installationId: 99,
    }
    github.creds = { privateKeyPem: 'pem', webhookSecret: 'w', clientSecret: 's' }
  }
  const { api, seen } = mockGitHub(routes)
  // The App JWT needs a real key; the installation token itself is what the tests observe.
  api.installationToken = async (appId, _pem, inst) => `tok-${appId}-${inst}`
  const repos = new InMemoryConnectedRepoStore()
  const tools = new Map(createGitHubConnectTools({ github, repos, api }).map((t) => [t.name, t]))
  const run = (name: string, input: unknown) => tools.get(name)!.handler(human, input)
  return { tools, repos, run, seen }
}

describe('website GitHub connect tools: metadata', () => {
  const { tools } = setup({}, false)

  it('builds exactly the declared tools', () => {
    expect([...tools.keys()].sort()).toEqual([...GITHUB_CONNECT_TOOL_NAMES].sort())
  })

  it('reads are read; connect is internal, disconnect is destructive; both say what they did', () => {
    expect(tools.get('website.github_list_repos')!.auditClass).toBe('read')
    expect(tools.get('website.github_inspect_repo')!.auditClass).toBe('read')
    expect(tools.get('website.github_available_repos')!.auditClass).toBe('read')
    const connect = tools.get('website.github_connect_repo')!
    const disconnect = tools.get('website.github_disconnect_repo')!
    expect([connect.auditClass, connect.approvalRisk]).toEqual(['mutate', 'internal'])
    expect([disconnect.auditClass, disconnect.approvalRisk]).toEqual(['mutate', 'destructive'])
    expect(
      connect.activity!({ repo: 'https://github.com/kindred/site', branch: 'main' }, undefined),
    ).toBe('Connected the GitHub repo kindred/site (main)')
    expect(
      connect.activity!({ repo: 'kindred/site', branch: 'main' }, { fullName: 'Kindred/Site' }),
    ).toBe('Connected the GitHub repo Kindred/Site (main)')
    expect(disconnect.activity!({ repo: 'kindred/site', branch: 'main' }, undefined)).toBe(
      'Disconnected the GitHub repo kindred/site (main)',
    )
  })
})

describe('public repo by URL (no auth)', () => {
  it('inspect validates through the GitHub API without a token and lists branches', async () => {
    const { run, seen } = setup(publicRoutes, false)
    expect(
      await run('website.github_inspect_repo', { repo: 'https://github.com/kindred/site' }),
    ).toEqual({
      repoId: 42,
      fullName: 'kindred/site',
      htmlUrl: 'https://github.com/kindred/site',
      cloneUrl: 'https://github.com/kindred/site.git',
      visibility: 'public',
      defaultBranch: 'main',
      branches: ['main', 'staging'],
      installationId: null,
    })
    expect(seen.every((k) => k.startsWith('none '))).toBe(true)
  })

  it('a repo GitHub does not know is a plain message, not the API error', async () => {
    const { run } = setup({}, false)
    const err = await run('website.github_inspect_repo', {
      repo: 'https://github.com/kindred/ghost',
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitHubUserError)
    expect((err as Error).message).toBe(
      'GitHub has no public repository kindred/ghost. If it is private, connect it with a deploy key.',
    )
  })

  it('a bad link is the parser’s plain message', async () => {
    const { run } = setup({}, false)
    await expect(
      run('website.github_inspect_repo', { repo: 'https://gitlab.com/a/b' }),
    ).rejects.toThrow('Only github.com repositories can be connected.')
  })

  it('a used-up rate limit says when to retry, in plain words', async () => {
    const { run } = setup(
      {
        'none GET /repos/kindred/site': {
          status: 403,
          body: { message: 'API rate limit exceeded for 1.2.3.4. (But here is the good news...)' },
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Date.UTC(2026, 9, 20, 14, 5) / 1000),
          },
        },
      },
      false,
    )
    await expect(run('website.github_inspect_repo', { repo: 'kindred/site' })).rejects.toThrow(
      "GitHub's limit for lookups is used up until 14:05 UTC. Try again then, or connect GitHub so lookups use the app.",
    )
  })

  it('connect persists repo id, branch and no installation; a missing branch is refused plainly', async () => {
    const { run, repos } = setup(publicRoutes, false)
    await expect(
      run('website.github_connect_repo', { repo: 'kindred/site', branch: 'nope' }),
    ).rejects.toThrow('kindred/site has no branch named “nope”.')
    await run('website.github_connect_repo', {
      repo: 'https://github.com/kindred/site',
      branch: 'staging',
    })
    expect(repos.rows).toMatchObject([
      {
        repoId: 42,
        fullName: 'kindred/site',
        branch: 'staging',
        visibility: 'public',
        installationId: null,
        connectedBy: 'human:u1',
      },
    ])
    await expect(
      run('website.github_connect_repo', { repo: 'kindred/site', branch: 'staging' }),
    ).rejects.toThrow('kindred/site (staging) is already connected.')
  })
})

describe('private repos through the installed GitHub App', () => {
  const routes: Record<string, Route> = {
    'token tok-5-99 GET /installation/repositories?per_page=100&page=1': {
      status: 200,
      body: { total_count: 2, repositories: [app, site] },
    },
    'token tok-5-99 GET /repos/kindred/app': { status: 200, body: app },
    'token tok-5-99 GET /repos/kindred/app/branches?per_page=100&page=1': {
      status: 200,
      body: [{ name: 'main' }],
    },
    'token tok-5-99 GET /repos/kindred/app/commits/main': { status: 200, body: commit },
    ...publicRoutes,
  }

  it('lists what the installation can see, with the installation token', async () => {
    const { run } = setup(routes, true)
    expect(await run('website.github_available_repos', {})).toEqual([
      { repoId: 7, fullName: 'kindred/app', visibility: 'private', defaultBranch: 'main' },
      { repoId: 42, fullName: 'kindred/site', visibility: 'public', defaultBranch: 'main' },
    ])
  })

  it('without an installed app the listing says to connect first', async () => {
    const { run } = setup(routes, false)
    await expect(run('website.github_available_repos', {})).rejects.toThrow(
      'GitHub is not connected yet. Connect GitHub first, then install the app on your repositories.',
    )
  })

  it('connect → list (with last commit) → disconnect, storing the installation id and no token', async () => {
    const { run, repos } = setup(routes, true)
    await run('website.github_connect_repo', { repo: 'kindred/app', branch: 'main' })
    expect(repos.rows[0]).toMatchObject({ repoId: 7, visibility: 'private', installationId: 99 })
    expect(JSON.stringify(repos.rows)).not.toContain('tok-')

    const listed = (await run('website.github_list_repos', {})) as {
      github: unknown
      repos: Array<{ fullName: string; lastCommit: unknown; lastCommitError: string | null }>
    }
    expect(listed.github).toEqual({
      connected: true,
      installed: true,
      appSlug: 'eigen-kindred',
      manageUrl: 'https://github.com/apps/eigen-kindred/installations/new',
    })
    expect(listed.repos[0]).toMatchObject({
      fullName: 'kindred/app',
      lastCommit: { sha: 'a'.repeat(40), message: 'Ship it', date: '2026-10-01T10:00:00Z' },
      lastCommitError: null,
    })

    await run('website.github_disconnect_repo', { repo: 'kindred/app', branch: 'main' })
    expect(repos.rows).toEqual([])
    await expect(
      run('website.github_disconnect_repo', { repo: 'kindred/app', branch: 'main' }),
    ).rejects.toThrow('kindred/app (main) is not connected.')
  })

  it('a branch whose last commit cannot be read shows a plain note, the list still loads', async () => {
    const { run, repos } = setup(publicRoutes, false)
    await repos.add({
      repoId: 42,
      fullName: 'kindred/site',
      branch: 'gone',
      htmlUrl: '',
      cloneUrl: '',
      visibility: 'public',
      authKind: 'public',
      installationId: null,
      deployKeyId: null,
      connectedBy: 'human:u1',
    })
    const listed = (await run('website.github_list_repos', {})) as {
      repos: Array<{ lastCommit: unknown; lastCommitError: string }>
    }
    expect(listed.repos[0]).toMatchObject({
      lastCommit: null,
      lastCommitError: 'GitHub could not find the branch gone.',
    })
  })
})

describe('deploy keys shared by connected branches', () => {
  it('requires a human, retains the key for remaining branches, and deletes only its last reference', async () => {
    const keyId = 'dk_' + 'a'.repeat(24)
    let keyExists = true
    const ee = {
      createDeployKey: async () => ({ keyId, publicKey: 'ssh-ed25519 PUBLIC' }),
      checkDeployKey: async () => {
        if (!keyExists) throw new Error('The key was deleted')
        return { ok: true as const, branches: ['main', 'preview/features'] }
      },
      deleteDeployKey: vi.fn(async () => {
        keyExists = false
        return { ok: true as const }
      }),
    }
    const repos = new InMemoryConnectedRepoStore()
    for (const branch of ['main', 'preview/features'])
      await repos.add({
        repoId: null,
        fullName: 'kindred/private',
        branch,
        htmlUrl: 'https://github.com/kindred/private',
        cloneUrl: 'git@github.com:kindred/private.git',
        visibility: 'private',
        authKind: 'deploy_key',
        installationId: null,
        deployKeyId: keyId,
        connectedBy: 'human:u1',
      })
    const tools = new Map(
      createGitHubConnectTools({ github: new InMemoryGitHubStore(), repos, ee }).map((t) => [
        t.name,
        t,
      ]),
    )
    const disconnect = tools.get('website.github_disconnect_repo')!
    await expect(
      disconnect.handler(
        { ...human, principal: { id: 'agent', kind: 'agent', roles: ['agent'] } },
        { repo: 'kindred/private', branch: 'main' },
      ),
    ).rejects.toThrow('only a human')
    expect(repos.rows).toHaveLength(2)
    expect(
      await disconnect.handler(human, { repo: 'kindred/private', branch: 'main' }),
    ).toMatchObject({ removeKeyUrl: null })
    expect(ee.deleteDeployKey).not.toHaveBeenCalled()
    expect(repos.rows.map((r) => r.branch)).toEqual(['preview/features'])
    expect(
      await tools
        .get('website.github_deploy_key_check')!
        .handler(human, { repo: 'kindred/private', keyId }),
    ).toEqual({ ok: true, branches: ['main', 'preview/features'] })
    expect(
      await disconnect.handler(human, { repo: 'kindred/private', branch: 'preview/features' }),
    ).toMatchObject({ removeKeyUrl: 'https://github.com/kindred/private/settings/keys' })
    expect(ee.deleteDeployKey).toHaveBeenCalledExactlyOnceWith(keyId, { author: 'human:u1' })
    expect(repos.rows).toHaveLength(0)
  })
})
