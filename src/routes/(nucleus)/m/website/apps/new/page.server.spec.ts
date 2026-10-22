import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import { SubstrateUnavailableError, type EeClient } from '$lib/server/ee/client'
import { InMemoryServiceStore } from '../../../../../../../modules/website/apps/store'
import { FakeEe } from '../../../../../../../modules/website/apps/testing'
import {
  APP_AGENT_GATED_TOOLS,
  createAppTools,
} from '../../../../../../../modules/website/apps/tools'
import { GitHubApi } from '../../../../../../../modules/website/github/api'
import {
  createGitHubConnectTools,
  type DeployKeyEe,
} from '../../../../../../../modules/website/github/connect-tools'
import { InMemoryConnectedRepoStore } from '../../../../../../../modules/website/github/repos-store'
import { InMemoryGitHubStore } from '../../../../../../../modules/website/github/store'
import { createSubstrateTools } from '../../../../../../../modules/website/hosting/tools'

const { holder } = vi.hoisted(() => ({
  holder: { registry: null as unknown, approvals: null as unknown },
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: async (u: unknown) => u }))
vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
vi.mock('../../../../../../../modules/index', () => ({
  bootstrapKernel: () => ({ registry: holder.registry }),
  ensureSystemModulesActive: async () => undefined,
}))
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

import { deployJobs } from '../../../../../../../modules/website/apps/deploy-jobs'
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
    '/app/installations/7/access_tokens': { token: 'tok-7' },
    '/installation/repositories?per_page=100&page=1': {
      total_count: 1,
      repositories: [
        {
          id: 9001,
          full_name: 'kindred/app',
          default_branch: 'main',
          private: true,
          clone_url: 'https://github.com/kindred/app.git',
          html_url: 'https://github.com/kindred/app',
        },
      ],
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

/** ee's deploy-key verbs in memory; the private key never exists on this side. */
class FakeKeyEe implements DeployKeyEe {
  keys = new Map<string, string>()
  accepted = false
  deleted: string[] = []
  async createDeployKey(i: { repo: string }) {
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

const user = { id: 'u1' }
let ee: FakeEe
let keyEe: FakeKeyEe
let repos: InMemoryConnectedRepoStore
let services: InMemoryServiceStore
let github: InMemoryGitHubStore

/** A connected public repo (deployed as `site`) and an unused deploy-key repo. */
beforeEach(async () => {
  ee = new FakeEe()
  keyEe = new FakeKeyEe()
  github = new InMemoryGitHubStore()
  repos = new InMemoryConnectedRepoStore()
  services = new InMemoryServiceStore()
  await repos.add({
    repoId: 42,
    fullName: 'kindred/site',
    branch: 'main',
    htmlUrl: 'https://github.com/kindred/site',
    cloneUrl: 'https://github.com/kindred/site.git',
    visibility: 'public',
    authKind: 'public',
    installationId: null,
    deployKeyId: null,
    connectedBy: 'human:u1',
  })
  await repos.add({
    repoId: null,
    fullName: 'kindred/secret',
    branch: 'dev',
    htmlUrl: 'https://github.com/kindred/secret',
    cloneUrl: 'git@github.com:kindred/secret.git',
    visibility: 'private',
    authKind: 'deploy_key',
    installationId: null,
    deployKeyId: 'dk_' + 'a'.repeat(24),
    connectedBy: 'human:u1',
  })
  await services.upsert({
    name: 'site',
    kind: 'web',
    repoFullName: 'kindred/site',
    branch: 'main',
    repoId: 42,
    authKind: 'public',
    host: 'site.ee.localhost',
    autoDeploy: false,
    createdBy: 'human:u1',
  })
  const approvals = new InMemoryApprovalStore()
  const registry = new KernelRegistry({
    approvalPolicy: new ModeAwareApprovalPolicy(
      new Set(APP_AGENT_GATED_TOOLS),
      new InMemoryApprovalModeStore('ask'),
    ),
    approvalStore: approvals,
  })
  for (const t of createAppTools({ ee, repos, services, mintToken: async () => 'x' }))
    registry.register(t)
  for (const t of createGitHubConnectTools({
    github,
    repos,
    api: new GitHubApi(fakeFetch()),
    ee: keyEe,
  }))
    registry.register(t)
  for (const t of createSubstrateTools({ client: ee as unknown as EeClient })) registry.register(t)
  holder.registry = registry
  holder.approvals = approvals
})

function event(form?: Record<string, string>) {
  const body = new FormData()
  for (const [k, v] of Object.entries(form ?? {})) body.set(k, v)
  return {
    locals: { user },
    // The load sets the GitHub App manifest's state cookie when GitHub isn't
    // connected; a no-op cookies bag is enough for these tests.
    cookies: { set: () => {} },
    url: new URL('https://kindred.example/m/website/apps/new'),
    request: new Request('https://kindred.example/m/website/apps/new', { method: 'POST', body }),
  } as never
}

describe('/m/website/apps/new: load', () => {
  it('passes the overview repository selection to the connection flow', async () => {
    const e = event() as unknown as { url: URL }
    e.url.searchParams.set('repo', 'kindred/secret')
    e.url.searchParams.set('branch', 'preview/features')
    expect(await load(e as never)).toMatchObject({
      repoHint: 'kindred/secret',
      branchHint: 'preview/features',
    })
  })

  it('loads repos (marked used/unused, with a free suggested name), the catalog and the managed state', async () => {
    const data = (await load(event())) as Record<string, unknown>
    expect(data.ownerId).toBe('u1')
    expect(data.github).toEqual({
      connected: false,
      installed: false,
      appSlug: null,
      manageUrl: null,
    })
    // The App connection moved into this page: the manifest is offered here.
    const manifest = data.githubManifest as { json: string; state: string }
    expect(manifest.state).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.parse(manifest.json)).toMatchObject({ name: expect.stringMatching(/eigen/i) })
    expect(data.managed).toBe(true)
    expect(data.consoleHost).toBe('os.ee.localhost')
    expect(data.managedReason).toBeNull()
    expect(data.appsError).toBeNull()
    expect(data.available).toBeNull()
    expect(data.takenNames).toEqual(['site'])
    expect(data.catalog).toMatchObject({ runtimes: { node: ['22'] } })
    expect(data.repos).toMatchObject([
      {
        fullName: 'kindred/secret',
        branch: 'dev',
        visibility: 'private',
        authKind: 'deploy_key',
        used: false,
        usedBy: null,
        suggestedName: 'secret',
      },
      {
        fullName: 'kindred/site',
        branch: 'main',
        visibility: 'public',
        authKind: 'public',
        used: true,
        usedBy: 'site',
        suggestedName: 'site-2',
      },
    ])
  })

  it('ee unreachable: an explicit not-managed state (deploy off), while repo connecting still works', async () => {
    ee.status = async () => {
      throw new SubstrateUnavailableError('connect ECONNREFUSED 127.0.0.1:7420')
    }
    const data = (await load(event())) as Record<string, unknown>
    expect(data.managed).toBe(false)
    expect(data.consoleHost).toBeNull()
    expect(data.managedReason).toMatch(/ECONNREFUSED/)
    // app_list answers from the database when ee is away: no error, no catalog,
    // and the connected repos are still marked by the services that use them.
    expect(data.appsError).toBeNull()
    expect(data.catalog).toBeNull()
    expect(data.repos).toHaveLength(2)
    expect((data.repos as Array<{ used: boolean }>).map((r) => r.used)).toEqual([false, true])
  })

  it('with the GitHub App installed: the repos it can see are listed', async () => {
    await github.saveConnection(
      {
        appId: 1,
        appSlug: 'eigen-kindred',
        clientId: 'Iv1.x',
        htmlUrl: 'https://github.com/apps/eigen-kindred',
      },
      {
        privateKeyPem: privateKeyPem(),
        webhookSecret: 'wh',
        clientSecret: 'cs',
      },
    )
    await github.setInstallation(7)
    const data = (await load(event())) as { available: Array<Record<string, unknown>> }
    expect(data.available).toEqual([
      {
        repoId: 9001,
        fullName: 'kindred/app',
        visibility: 'private',
        defaultBranch: 'main',
      },
    ])
  })
})

describe('/m/website/apps/new: connect steps', () => {
  it('inspect: structured visibility, default branch, link #branch preselect, and a free suggested name', async () => {
    const out = (await actions.inspect(
      event({ repo: 'https://github.com/kindred/site/tree/dev' }),
    )) as Record<string, unknown>
    expect(out).toMatchObject({
      action: 'inspect',
      repo: 'https://github.com/kindred/site/tree/dev',
      branch: 'dev',
      inspected: {
        fullName: 'kindred/site',
        visibility: 'public',
        defaultBranch: 'main',
        branches: ['main', 'dev'],
      },
    })
  })

  it('inspect: a bad link is the parser’s plain message', async () => {
    const out = (await actions.inspect(event({ repo: 'https://gitlab.com/a/b' }))) as {
      status: number
      data: { action: string; error: string }
    }
    expect(out.status).toBe(400)
    expect(out.data.action).toBe('inspect')
    expect(out.data.error).toBe('Only github.com repositories can be connected.')
  })

  it('deploy key: create → refused check (plain) → accepted check (branches, name) → cancel deletes the key', async () => {
    const created = (await actions.deployKeyCreate(event({ repo: 'kindred/secret' }))) as Record<
      string,
      unknown
    >
    expect(created).toEqual({
      action: 'deploy_key',
      repo: 'kindred/secret',
      keyId: expect.stringMatching(/^dk_[0-9a-f]{24}$/),
      publicKey: 'ssh-ed25519 AAAAPUBLIC ee-deploy',
      addKeyUrl: 'https://github.com/kindred/secret/settings/keys/new',
    })
    const keyId = created.keyId as string
    const pending = {
      repo: 'kindred/secret',
      keyId,
      publicKey: 'ssh-ed25519 AAAAPUBLIC ee-deploy',
    }

    const refused = (await actions.deployKeyCheck(event(pending))) as {
      status: number
      data: Record<string, unknown>
    }
    expect(refused.status).toBe(400)
    expect(refused.data).toMatchObject({
      action: 'deploy_key',
      repo: 'kindred/secret',
      error:
        "GitHub didn't accept the key yet — check it was added to this repo (Settings → Deploy keys).",
    })
    expect(JSON.stringify(refused.data)).not.toMatch(/Permission denied/)

    keyEe.accepted = true
    expect(await actions.deployKeyCheck(event(pending))).toMatchObject({
      action: 'deploy_key',
      repo: 'kindred/secret',
      keyId,
      branches: ['dev', 'main'],
      branch: 'main',
    })

    expect(await actions.deployKeyCancel(event(pending))).toMatchObject({
      action: 'deploy_key_cancel',
      ok: true,
      link: { href: 'https://github.com/kindred/secret/settings/keys' },
    })
    expect(keyEe.deleted).toEqual([keyId])
  })

  it('connect: public by link; private with the deploy key; disconnect an unused repo', async () => {
    expect(await actions.connect(event({ repo: 'kindred/site', branch: 'dev' }))).toMatchObject({
      action: 'connect',
      ok: true,
      message: 'Connected kindred/site (dev).',
    })
    expect(repos.rows).toMatchObject([
      { fullName: 'kindred/site', branch: 'main', authKind: 'public' },
      { fullName: 'kindred/secret', branch: 'dev', authKind: 'deploy_key' },
      { fullName: 'kindred/site', branch: 'dev', authKind: 'public' },
    ])

    keyEe.accepted = true
    const created = (await actions.deployKeyCreate(event({ repo: 'kindred/vault' }))) as {
      keyId: string
    }
    expect(
      await actions.connect(event({ repo: 'kindred/vault', branch: 'main', keyId: created.keyId })),
    ).toMatchObject({ action: 'connect', ok: true })
    const vault = repos.rows.find((r) => r.fullName === 'kindred/vault')
    expect(vault).toMatchObject({
      branch: 'main',
      authKind: 'deploy_key',
      deployKeyId: created.keyId,
    })

    // A deploy-key repo: disconnecting also deletes the key on the server.
    const fixtureKeyId = 'dk_' + 'a'.repeat(24)
    expect(
      await actions.disconnect(event({ repo: 'kindred/secret', branch: 'dev' })),
    ).toMatchObject({
      action: 'disconnect',
      ok: true,
      message:
        'Disconnected kindred/secret (dev) and deleted its deploy key on this server. You can remove the key on GitHub too.',
      link: { href: 'https://github.com/kindred/secret/settings/keys' },
    })
    expect(keyEe.deleted).toContain(fixtureKeyId)
    expect(repos.rows.find((r) => r.fullName === 'kindred/secret')).toBeUndefined()
  })

  it('a connect failure comes back as a plain sentence', async () => {
    const out = (await actions.connect(event({ repo: 'kindred/site', branch: 'nope' }))) as {
      status: number
      data: { action: string; error: string }
    }
    expect(out.status).toBe(400)
    expect(out.data.action).toBe('connect')
    expect(out.data.error).toBe('kindred/site has no branch named “nope”.')
  })
})

describe('/m/website/apps/new: deploy', () => {
  const contract = {
    useForm: 'on',
    runtime: 'node@22',
    install: 'npm install --omit=dev',
    start: 'node index.js',
    health: '/',
  }

  it('a quick deploy redirects to the new app; the repo is then marked used', async () => {
    await expect(
      actions.deploy(
        event({ repo: 'kindred/site', branch: 'main', name: 'shop', kind: 'web', ...contract }),
      ),
    ).rejects.toMatchObject({ status: 303, location: '/m/website/apps/shop' })
    expect(ee.calls.map((c) => c.verb)).toEqual([
      'fetchSource',
      'sourceContract',
      'createApp',
      'addDomain',
    ])

    const data = (await load(event())) as { repos: Array<Record<string, unknown>> }
    expect(data.repos.find((r) => r.fullName === 'kindred/site')).toMatchObject({
      used: true,
      usedBy: expect.stringMatching(/^(site|shop)$/),
    })
    expect(data.takenNames).toHaveLength(2)
    expect(data.takenNames).toEqual(expect.arrayContaining(['site', 'shop']))
  })

  it('a slow deploy returns at once with the job the page follows', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const createApp = ee.createApp.bind(ee)
    ee.createApp = async (i) => {
      await gate
      return createApp(i)
    }
    const out = (await actions.deploy(
      event({ repo: 'kindred/site', branch: 'main', name: 'gs-slow', kind: 'web', ...contract }),
    )) as { action: string; name: string; jobId: string }
    expect(out).toMatchObject({ action: 'deploy', name: 'gs-slow', jobId: expect.any(String) })
    release()
    await deployJobs.get(out.jobId)!.done
    expect(deployJobs.get(out.jobId)!.state).toBe('done')
  })

  it('an instant refusal comes back with the plain error and the job id (the page still follows it)', async () => {
    const out = (await actions.deploy(
      event({ repo: 'kindred/site', branch: 'main', name: 'plain', kind: 'web' }),
    )) as { status: number; data: { action: string; error: string; jobId: string } }
    expect(out.status).toBe(400)
    expect(out.data.action).toBe('deploy')
    expect(out.data.error).toMatch(/no ee\.json/)
    expect(typeof out.data.jobId).toBe('string')
  })

  it('a broken build form is refused before anything runs, with the schema’s words', async () => {
    const out = (await actions.deploy(
      event({
        repo: 'kindred/site',
        branch: 'main',
        name: 'badform',
        kind: 'web',
        useForm: 'on',
        runtime: 'node@abc',
        start: 'node index.js',
      }),
    )) as { status: number; data: { action: string; error: string; jobId?: string } }
    expect(out.status).toBe(400)
    expect(out.data.error).toBe('a Node.js major version, e.g. 22')
    expect(out.data.jobId).toBeUndefined()
    expect(ee.calls).toEqual([])
  })
})

function privateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
}
