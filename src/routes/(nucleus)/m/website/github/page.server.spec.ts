import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import { SubstrateUnavailableError } from '$lib/server/ee/client'
import { GitHubApi } from '../../../../../../modules/website/github/api'
import {
  createGitHubConnectTools,
  type DeployKeyEe,
} from '../../../../../../modules/website/github/connect-tools'
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

/** ee's deploy-key verbs in memory: the private key never exists on this side. */
class FakeEe implements DeployKeyEe {
  keys = new Map<string, string>()
  accepted = false
  unavailable = false
  deleted: string[] = []
  async createDeployKey(i: { repo: string }) {
    if (this.unavailable) throw new SubstrateUnavailableError('ENOENT')
    const keyId = 'dk_' + String(this.keys.size + 1).padStart(24, '0')
    this.keys.set(keyId, i.repo)
    return { keyId, publicKey: 'ssh-ed25519 AAAAPUBLIC ee-deploy' }
  }
  async checkDeployKey() {
    return this.accepted
      ? { ok: true as const, branches: ['dev', 'main'] }
      : {
          ok: false as const,
          error: 'not_accepted' as const,
          detail: 'Permission denied (publickey).',
        }
  }
  async deleteDeployKey(keyId: string) {
    this.keys.delete(keyId)
    this.deleted.push(keyId)
    return { ok: true as const }
  }
}

let repos: InMemoryConnectedRepoStore
let ee: FakeEe
const cookies = { set: vi.fn() }
const user = { id: 'owner-1' }

beforeEach(() => {
  repos = new InMemoryConnectedRepoStore()
  ee = new FakeEe()
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
    ee,
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
      'GitHub has no public repository kindred/ghost. If it is private, connect it with a deploy key below.',
    )
    expect(out.data.error).not.toMatch(/Not Found|docs\.github|404/)
  })

  it('deploy key: create shows the public key → check fails plainly → check lists branches → connect → disconnect deletes the key', async () => {
    const created = (await actions.deployKeyCreate(
      event({ repo: 'git@github.com:kindred/secret.git' }),
    )) as Record<string, unknown>
    expect(created).toEqual({
      action: 'deploy_key',
      step: 'add',
      repo: 'kindred/secret',
      keyId: expect.stringMatching(/^dk_/),
      publicKey: 'ssh-ed25519 AAAAPUBLIC ee-deploy',
      addKeyUrl: 'https://github.com/kindred/secret/settings/keys/new',
    })
    const keyId = created.keyId as string
    const pending = { repo: 'kindred/secret', keyId, publicKey: 'ssh-ed25519 AAAAPUBLIC ee-deploy' }

    const refused = (await actions.deployKeyCheck(event(pending))) as {
      status: number
      data: Record<string, unknown>
    }
    expect(refused.status).toBe(400)
    expect(refused.data).toMatchObject({
      step: 'add',
      keyId,
      error:
        "GitHub didn't accept the key yet — check it was added to this repo (Settings → Deploy keys).",
    })
    expect(JSON.stringify(refused.data)).not.toMatch(/Permission denied/)

    ee.accepted = true
    expect(await actions.deployKeyCheck(event(pending))).toMatchObject({
      action: 'deploy_key',
      step: 'branches',
      branches: ['dev', 'main'],
      branch: 'main',
    })
    expect(await actions.deployKeyConnect(event({ ...pending, branch: 'dev' }))).toMatchObject({
      action: 'connect',
      ok: true,
      message: 'Connected kindred/secret (dev).',
    })
    expect(repos.rows).toMatchObject([
      { authKind: 'deploy_key', deployKeyId: keyId, branch: 'dev' },
    ])

    const data = (await load(event())) as { repos: Array<Record<string, unknown>> }
    expect(data.repos).toMatchObject([{ fullName: 'kindred/secret', authKind: 'deploy_key' }])

    expect(
      await actions.disconnect(event({ repo: 'kindred/secret', branch: 'dev' })),
    ).toMatchObject({
      ok: true,
      message:
        'Disconnected kindred/secret (dev) and deleted its deploy key on this server. You can remove the key on GitHub too.',
      link: {
        href: 'https://github.com/kindred/secret/settings/keys',
        label: 'Deploy keys of kindred/secret on GitHub',
      },
    })
    expect(ee.deleted).toEqual([keyId])
  })

  it('deploy key: giving up before connecting deletes the key on the server', async () => {
    const created = (await actions.deployKeyCreate(event({ repo: 'kindred/secret' }))) as {
      keyId: string
    }
    expect(
      await actions.deployKeyCancel(event({ repo: 'kindred/secret', keyId: created.keyId })),
    ).toMatchObject({ ok: true, link: { href: 'https://github.com/kindred/secret/settings/keys' } })
    expect(ee.deleted).toEqual([created.keyId])
  })

  it('deploy key without ee: a plain message, nothing stored', async () => {
    ee.unavailable = true
    const out = (await actions.deployKeyCreate(event({ repo: 'kindred/secret' }))) as {
      status: number
      data: Record<string, unknown>
    }
    expect(out.status).toBe(400)
    expect(out.data).toMatchObject({ action: 'deploy_key', step: 'repo', repo: 'kindred/secret' })
    expect(out.data.error).toMatch(/^Private repos need the server's deploy agent\./)
    expect(repos.rows).toEqual([])
  })

  it('deploy key: a bad repo address is the parser’s plain message', async () => {
    const out = (await actions.deployKeyCreate(event({ repo: 'git@gitlab.com:a/b.git' }))) as {
      data: { error: string }
    }
    expect(out.data.error).toBe('Only github.com repositories can be connected.')
  })
})
