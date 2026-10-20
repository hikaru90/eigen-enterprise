import { describe, expect, it } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelError } from '$lib/kernel/errors'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { SubstrateError } from '$lib/server/ee/client'
import { InMemoryConnectedRepoStore, type NewConnectedRepo } from '../github/repos-store'
import { InMemoryServiceStore } from './store'
import { FakeEe } from './testing'
import { APP_AGENT_GATED_TOOLS, createAppTools } from './tools'

const REV = 'c'.repeat(40)
const human: ToolContext = {
  principal: { id: 'u1', kind: 'human', roles: ['admin'] },
  requestId: 'r',
}
const agent: ToolContext = {
  principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] },
  requestId: 'r',
}

const form = {
  runtime: 'node' as const,
  nodeVersion: '22',
  install: 'npm install --omit=dev',
  start: 'node index.js',
  health: '/',
}

const publicRepo: NewConnectedRepo = {
  repoId: 42,
  fullName: 'kindred/shop',
  branch: 'main',
  htmlUrl: 'https://github.com/kindred/shop',
  cloneUrl: 'https://github.com/kindred/shop.git',
  visibility: 'public',
  authKind: 'public',
  installationId: null,
  deployKeyId: null,
  connectedBy: 'human:u1',
}

async function setup(repo: NewConnectedRepo = publicRepo) {
  const ee = new FakeEe()
  const repos = new InMemoryConnectedRepoStore()
  await repos.add(repo)
  const services = new InMemoryServiceStore()
  const minted: number[] = []
  const tools = createAppTools({
    ee,
    repos,
    services,
    mintToken: async (id) => {
      minted.push(id)
      return 'ghs_SECRET_TOKEN'
    },
    now: () => new Date('2026-10-20T10:00:00Z'),
  })
  const tool = (name: string) => tools.find((t) => t.name === name) as ToolDescriptor
  const run = (name: string, input: unknown, ctx = human) =>
    tool(name).handler(ctx, tool(name).inputSchema.parse(input))
  return { ee, repos, services, tools, tool, run, minted }
}

const verbs = (ee: FakeEe) => ee.calls.map((c) => c.verb)

describe('website.app_deploy builds the right ee calls', () => {
  it('public repo without ee.json: fetch (no auth) → contract from the form → app → host route', async () => {
    const { ee, run, services } = await setup()
    const out = (await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })) as {
      state: string
      url: string
      commit: string
    }
    expect(verbs(ee)).toEqual(['fetchSource', 'sourceContract', 'createApp', 'addDomain'])
    expect(ee.calls[0]!.input).toEqual({
      name: 'gh-shop',
      url: 'https://github.com/kindred/shop.git',
      ref: 'main',
    })
    expect(ee.calls[2]!.input).toMatchObject({
      name: 'shop',
      source: { kind: 'git', mirror: 'sources/gh-shop.git', ref: 'main', rev: REV },
      contract: {
        runtime: 'node',
        node: '22',
        start: ['node', 'index.js'],
        build: [['npm', 'install', '--omit=dev']],
      },
      author: 'human:u1',
    })
    expect(ee.calls[3]!.input).toEqual({
      host: 'shop.ee.localhost',
      workload: 'shop',
      role: 'app',
      author: 'human:u1',
    })
    expect(out).toMatchObject({ state: 'healthy', url: 'https://shop.ee.localhost', commit: REV })
    expect((await services.get('shop'))?.state).toBe('healthy')
  })

  it("a repo with ee.json: the repo's contract is used and nothing is written for it", async () => {
    const { ee, run } = await setup()
    ee.repoContract = {
      present: true,
      contract: {
        runtime: 'node',
        node: '22',
        build: [],
        start: ['node', 'server.js'],
        preStart: [],
        health: '/up',
        services: [],
        capabilities: [],
      },
      gap: null,
      error: null,
    }
    await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
    })
    const create = ee.calls.find((c) => c.verb === 'createApp')!.input as { contract?: unknown }
    expect(create.contract).toBeUndefined()
  })

  it('redeploy by name reuses the stored contract and does not add the route twice', async () => {
    const { ee, run } = await setup()
    await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })
    ee.calls = []
    await run('website.app_deploy', { name: 'shop' })
    expect(verbs(ee)).toEqual(['fetchSource', 'sourceContract', 'createApp'])
    expect((ee.calls[2]!.input as { contract: { start: string[] } }).contract.start).toEqual([
      'node',
      'index.js',
    ])
  })

  it('deploy_key repo: the fetch passes the key id over ssh', async () => {
    const { ee, run } = await setup({
      ...publicRepo,
      repoId: null,
      visibility: 'private',
      authKind: 'deploy_key',
      deployKeyId: 'dk_' + 'a'.repeat(24),
    })
    await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })
    expect(ee.calls[0]!.input).toEqual({
      name: 'gh-shop',
      url: 'git@github.com:kindred/shop.git',
      ref: 'main',
      deployKeyId: 'dk_' + 'a'.repeat(24),
    })
  })

  it('github_app repo: a token is minted for that installation and never comes back', async () => {
    const { ee, run, minted, tool } = await setup({
      ...publicRepo,
      visibility: 'private',
      authKind: 'github_app',
      installationId: 9,
    })
    const out = await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })
    expect(minted).toEqual([9])
    expect((ee.calls[0]!.input as { token: string }).token).toBe('ghs_SECRET_TOKEN')
    expect(JSON.stringify(out)).not.toContain('ghs_')
    expect(
      tool('website.app_deploy').activity!(
        { repo: 'kindred/shop', branch: 'main', name: 'shop' },
        out,
      ),
    ).toBe('Deployed kindred/shop (main) as shop')
  })

  it('a back-end service gets no public route', async () => {
    const { ee, run } = await setup()
    const out = (await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'worker',
      kind: 'backend',
      contract: form,
    })) as { url: string | null }
    expect(verbs(ee)).not.toContain('addDomain')
    expect(out.url).toBeNull()
  })

  it("on the owner's own domain, a web app needs a host given", async () => {
    const { ee, run } = await setup()
    ee.consoleHost = 'os.kindred.dev'
    await expect(
      run('website.app_deploy', {
        repo: 'kindred/shop',
        branch: 'main',
        name: 'shop',
        kind: 'web',
        contract: form,
      }),
    ).rejects.toThrow(/domain/)
    const out = (await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
      host: 'shop.kindred.dev',
    })) as { url: string }
    expect(out.url).toBe('https://shop.kindred.dev')
  })

  it('a missing runtime is a catalog gap in plain words; nothing is deployed', async () => {
    const { ee, run } = await setup()
    await expect(
      run('website.app_deploy', {
        repo: 'kindred/shop',
        branch: 'main',
        name: 'shop',
        kind: 'web',
        contract: { ...form, nodeVersion: '18' },
      }),
    ).rejects.toThrow(/Node\.js 18.*change to Eigen/)
    expect(verbs(ee)).not.toContain('createApp')
  })

  it('a failed health gate is recorded and reported plainly, without raw logs', async () => {
    const { ee, run, services } = await setup()
    ee.failHealth = true
    const err = await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/didn't answer GET \/ in time/)
    expect(err.message).not.toContain('<raw')
    const s = await services.get('shop')
    expect(s).toMatchObject({ state: 'failed', lastRev: REV })
    expect(s?.lastError).not.toContain('<raw')
  })

  it('a repo that is not connected is refused in plain words', async () => {
    const { run } = await setup()
    await expect(
      run('website.app_deploy', {
        repo: 'kindred/other',
        branch: 'main',
        name: 'other',
        kind: 'web',
        contract: form,
      }),
    ).rejects.toThrow(/Connect kindred\/other \(main\)/)
  })

  it("an ee workload that isn't one of these services keeps its name", async () => {
    const { ee, run } = await setup()
    ee.workloads = [
      {
        name: 'shop',
        tier: 'app',
        source: { kind: 'release' },
        deploy: { auto: false },
        contract: null,
        secrets: [],
        declaredSecrets: [],
        live: null,
        lastError: null,
      },
    ]
    await expect(
      run('website.app_deploy', {
        repo: 'kindred/shop',
        branch: 'main',
        name: 'shop',
        kind: 'web',
        contract: form,
      }),
    ).rejects.toThrow(/already runs here/)
  })

  it('ee catalog_gap from the server is mapped to plain words too', async () => {
    const { ee, run } = await setup()
    ee.createApp = async () => {
      throw new SubstrateError(422, 'catalog_gap: ...', 'urn:ee:catalog_gap', {
        missing: ['runtime node@22'],
      })
    }
    await expect(
      run('website.app_deploy', {
        repo: 'kindred/shop',
        branch: 'main',
        name: 'shop',
        kind: 'web',
        contract: form,
      }),
    ).rejects.toThrow(/doesn't provide yet/)
  })
})

describe('D11: agent deploys go through approval, never around it', () => {
  // That these tools are on APPROVAL_REQUIRED_TOOLS is held in modules/manifests.spec.ts.

  it("under 'ask' the agent's deploy waits for the owner; nothing reaches ee", async () => {
    const { ee, tools } = await setup()
    const registry = new KernelRegistry({
      approvalPolicy: new ModeAwareApprovalPolicy(
        new Set(APP_AGENT_GATED_TOOLS),
        new InMemoryApprovalModeStore('ask'),
      ),
      approvalStore: new InMemoryApprovalStore(),
    })
    for (const t of tools) registry.register(t)
    const err = await registry
      .execute(
        'website.app_deploy',
        { repo: 'kindred/shop', branch: 'main', name: 'shop', kind: 'web', contract: form },
        agent,
      )
      .catch((e) => e)
    expect(err).toBeInstanceOf(KernelError)
    expect(err.code).toBe('approval_required')
    expect(ee.calls).toEqual([])
  })

  it('a service principal cannot deploy through website.app_deploy', async () => {
    const { run } = await setup()
    const svc: ToolContext = {
      principal: { id: 'x', kind: 'service', roles: ['admin'] },
      requestId: 'r',
    }
    await expect(run('website.app_deploy', { name: 'shop' }, svc)).rejects.toThrow(
      /permission|human|approval/i,
    )
  })

  it('removing an app is human-only', async () => {
    const { run } = await setup()
    await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })
    await expect(run('website.app_remove', { name: 'shop' }, agent)).rejects.toThrow(/only a human/)
  })
})

describe('website.app_env_set', () => {
  it('stores the value through ee; output and activity name the variable only', async () => {
    const { ee, run, tool } = await setup()
    await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })
    const out = await run('website.app_env_set', {
      name: 'shop',
      key: 'API_KEY',
      value: 'sk-very-secret-value',
    })
    expect(ee.calls.at(-1)).toEqual({
      verb: 'setSecret',
      input: {
        workload: 'shop',
        name: 'API_KEY',
        value: 'sk-very-secret-value',
        author: 'human:u1',
      },
    })
    expect(JSON.stringify(out)).not.toContain('sk-very-secret')
    const sentence = tool('website.app_env_set').activity!(
      { name: 'shop', key: 'API_KEY', value: 'sk-very-secret-value' },
      out,
    )
    expect(sentence).toBe('Set API_KEY on shop')
    expect(sentence).not.toContain('sk-very')
  })
  it('ee-owned variables cannot be set', async () => {
    const { run } = await setup()
    await expect(
      run('website.app_env_set', { name: 'shop', key: 'PORT', value: '1' }),
    ).rejects.toThrow(/PORT/)
  })
})

describe('website.app_list / app_get / app_logs', () => {
  it('lists services with status, url, branch@sha and last deploy; env names only', async () => {
    const { run } = await setup()
    await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })
    await run('website.app_env_set', {
      name: 'shop',
      key: 'API_KEY',
      value: 'sk-very-secret-value',
    })
    const list = (await run('website.app_list', {})) as { services: Array<Record<string, unknown>> }
    expect(list.services[0]).toMatchObject({
      name: 'shop',
      kind: 'web',
      status: 'healthy',
      url: 'https://shop.ee.localhost',
      branch: 'main',
      shortSha: REV.slice(0, 7),
      lastDeployedAt: '2026-10-20T10:00:00.000Z',
    })
    const detail = (await run('website.app_get', { name: 'shop' })) as {
      env: string[]
      history: unknown[]
      domains: string[]
      contractSource: string
    }
    expect(detail.env).toEqual(['API_KEY'])
    expect(JSON.stringify(detail)).not.toContain('sk-very')
    expect(detail.domains).toEqual(['shop.ee.localhost'])
    expect(detail.history.length).toBeGreaterThan(0)
    expect(detail.contractSource).toBe('form')
    expect(await run('website.app_logs', { name: 'shop' })).toEqual({
      name: 'shop',
      lines: ['listening on 4100'],
    })
  })
})

describe('push-to-deploy (website.app_auto_deploy)', () => {
  it('matches github_app services by repo id + branch, only with auto-deploy on', async () => {
    const { ee, run, tool } = await setup({
      ...publicRepo,
      visibility: 'private',
      authKind: 'github_app',
      installationId: 9,
    })
    await run('website.app_deploy', {
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
      autoDeploy: true,
    })
    ee.calls = []
    const svc: ToolContext = {
      principal: { id: 'github-webhook', kind: 'service', roles: ['service'] },
      requestId: 'r',
    }
    const auto = tool('website.app_auto_deploy')
    const renamed = await auto.handler(svc, {
      repoId: 42,
      repo: 'kindred/shop-renamed',
      ref: 'main',
      after: REV,
    })
    expect(renamed).toMatchObject({ deployed: [{ name: 'shop' }] })
    expect(verbs(ee)).toContain('createApp')
    ee.calls = []
    expect(
      await auto.handler(svc, { repoId: 42, repo: 'kindred/shop', ref: 'dev', after: REV }),
    ).toEqual({ deployed: [] })
    expect(
      await auto.handler(svc, { repoId: 7, repo: 'kindred/shop', ref: 'main', after: REV }),
    ).toEqual({ deployed: [] })
    expect(ee.calls).toEqual([])
  })
  it('a deploy-key repo cannot turn on push-to-deploy (manual deploys only)', async () => {
    const { run } = await setup({
      ...publicRepo,
      repoId: null,
      visibility: 'private',
      authKind: 'deploy_key',
      deployKeyId: 'dk_' + 'a'.repeat(24),
    })
    await expect(
      run('website.app_deploy', {
        repo: 'kindred/shop',
        branch: 'main',
        name: 'shop',
        kind: 'web',
        contract: form,
        autoDeploy: true,
      }),
    ).rejects.toThrow(/GitHub App/)
  })
})
