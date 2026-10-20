import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import { GitHubApi } from '../../../../../../modules/website/github/api'
import { createGitHubConnectTools } from '../../../../../../modules/website/github/connect-tools'
import { InMemoryConnectedRepoStore } from '../../../../../../modules/website/github/repos-store'
import { InMemoryGitHubStore } from '../../../../../../modules/website/github/store'

const { holder } = vi.hoisted(() => ({
  holder: { registry: null as unknown, approvals: null as unknown },
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: async (u: unknown) => u }))
vi.mock('../../../../../../modules/index', () => ({
  bootstrapKernel: () => ({ registry: holder.registry }),
  ensureSystemModulesActive: async () => undefined,
}))
// The owner's click approves: decide straight on the store the registry gates with.
vi.mock('$lib/server/approvals/owner-decision', () => ({
  decideApprovalAsOwner: async (
    _r: unknown,
    user: { id: string },
    id: string,
    decision: 'approved',
  ) => {
    const approval = await (holder.approvals as InMemoryApprovalStore).decide(id, decision, user.id)
    return { kind: 'decided', approval }
  },
}))

import { actions, load } from './+page.server'

const site = {
  id: 42,
  full_name: 'kindred/site',
  default_branch: 'main',
  private: false,
  clone_url: 'https://github.com/kindred/site.git',
  html_url: 'https://github.com/kindred/site',
}

function fakeFetch(): typeof fetch {
  const routes: Record<string, unknown> = {
    '/repos/kindred/site': site,
    '/repos/kindred/site/branches?per_page=100&page=1': [{ name: 'main' }, { name: 'dev' }],
    '/repos/kindred/site/commits/main': {
      sha: 'b'.repeat(40),
      commit: { message: 'Init', author: { date: '2026-10-02T00:00:00Z' } },
    },
  }
  return (async (input: string | URL) => {
    const body = routes[String(input).replace('https://api.github.com', '')]
    return body === undefined
      ? new Response('{"message":"Not Found","documentation_url":"https://docs.github.com"}', {
          status: 404,
        })
      : new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
}

let repos: InMemoryConnectedRepoStore
const cookies = { set: vi.fn() }
const user = { id: 'owner-1' }

beforeEach(() => {
  repos = new InMemoryConnectedRepoStore()
  const approvals = new InMemoryApprovalStore()
  const registry = new KernelRegistry({
    approvalPolicy: new ModeAwareApprovalPolicy(
      new Set(['website.github_connect_repo', 'website.github_disconnect_repo']),
      new InMemoryApprovalModeStore('ask'),
    ),
    approvalStore: approvals,
  })
  for (const t of createGitHubConnectTools({
    github: new InMemoryGitHubStore(),
    repos,
    api: new GitHubApi(fakeFetch()),
  })) {
    registry.register(t)
  }
  holder.registry = registry
  holder.approvals = approvals
  cookies.set.mockClear()
})

function event(form?: Record<string, string>) {
  const body = new FormData()
  for (const [k, v] of Object.entries(form ?? {})) body.set(k, v)
  return {
    locals: { user },
    cookies,
    url: new URL('https://kindred.example/m/website/github'),
    request: new Request('https://kindred.example/m/website/github', { method: 'POST', body }),
  } as never
}

describe('/m/website/github', () => {
  it('load: not connected → manifest flow offered, state cookie set, nothing connected yet', async () => {
    const data = (await load(event())) as Record<string, unknown>
    expect(data.github).toEqual({
      connected: false,
      installed: false,
      appSlug: null,
      manageUrl: null,
    })
    expect(data.repos).toEqual([])
    expect(data.available).toBeNull()
    const manifest = data.manifest as { json: string; state: string }
    expect(JSON.parse(manifest.json)).toMatchObject({
      redirect_url: 'https://kindred.example/settings/hosting/github/callback',
      setup_url: 'https://kindred.example/settings/hosting/github/installed',
      default_permissions: { contents: 'read', metadata: 'read' },
    })
    expect(cookies.set).toHaveBeenCalledWith(
      'ee_github_state',
      manifest.state,
      expect.objectContaining({ path: '/settings/hosting/github' }),
    )
  })

  it('inspect a public link → branches; connect (the owner’s click approves) → listed; disconnect', async () => {
    const inspected = (await actions.inspect(
      event({ repo: 'https://github.com/kindred/site/tree/dev' }),
    )) as Record<string, unknown>
    expect(inspected).toMatchObject({
      action: 'inspect',
      branch: 'dev',
      inspected: { fullName: 'kindred/site', branches: ['main', 'dev'] },
    })

    expect(await actions.connect(event({ repo: 'kindred/site', branch: 'main' }))).toMatchObject({
      ok: true,
    })
    const data = (await load(event())) as { repos: Array<Record<string, unknown>> }
    expect(data.repos).toMatchObject([
      {
        fullName: 'kindred/site',
        branch: 'main',
        visibility: 'public',
        lastCommit: { message: 'Init' },
      },
    ])

    expect(await actions.disconnect(event({ repo: 'kindred/site', branch: 'main' }))).toMatchObject(
      { ok: true },
    )
    expect(repos.rows).toEqual([])
  })

  it('errors reach the page as plain words, never GitHub’s raw API error', async () => {
    const out = (await actions.inspect(event({ repo: 'https://github.com/kindred/ghost' }))) as {
      status: number
      data: { error: string }
    }
    expect(out.status).toBe(400)
    expect(out.data.error).toBe(
      'GitHub has no public repository kindred/ghost. If it is private, connect GitHub first and give the app access to it.',
    )
    expect(out.data.error).not.toMatch(/Not Found|docs\.github|404/)
  })
})
