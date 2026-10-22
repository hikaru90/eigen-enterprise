import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { SubstrateError, SubstrateUnavailableError } from '$lib/server/ee/client'
import { createActivityTools } from '../../../../../modules/website/activity-tools'
import { InMemoryServiceStore } from '../../../../../modules/website/apps/store'
import { FakeEe } from '../../../../../modules/website/apps/testing'
import {
  APP_AGENT_GATED_TOOLS,
  createAppTools,
  type AppListResult,
} from '../../../../../modules/website/apps/tools'
import {
  InMemoryConnectedRepoStore,
  type NewConnectedRepo,
} from '../../../../../modules/website/github/repos-store'

const { holder } = vi.hoisted(() => ({
  holder: {
    registry: null as unknown,
  },
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: async (u: unknown) => u }))
vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
vi.mock('../../../../../modules/index', () => ({
  bootstrapKernel: () => ({ registry: holder.registry }),
  ensureSystemModulesActive: async () => undefined,
}))

import { load } from './+page.server'

const form = {
  runtime: 'node' as const,
  nodeVersion: '22',
  install: 'npm install --omit=dev',
  start: 'node index.js',
  health: '/',
}

const repo: NewConnectedRepo = {
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

const human: ToolContext = {
  principal: { id: 'u1', kind: 'human', roles: ['admin'] },
  requestId: 'r',
}

/** FakeEe pins publicHost to null; the page reads it from ee's settings. */
const setPublicHost = (ee: FakeEe, host: string | null) => {
  const real = ee.status.bind(ee)
  ee.status = async () => {
    const s = await real()
    return { ...s, settings: { ...s.settings, publicHost: host } }
  }
}

async function setup() {
  const ee = new FakeEe()
  const repos = new InMemoryConnectedRepoStore()
  await repos.add(repo)
  const services = new InMemoryServiceStore()
  const readRepositories = vi.fn(async () => ({
    repos: (await repos.list()).map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      lastCommit: null,
      lastCommitError: null,
    })),
  }))
  const tools: ToolDescriptor[] = [
    {
      name: 'website.github_list_repos',
      module: 'website',
      summary: 'Saved repos',
      inputSchema: z.object({}).strict(),
      auditClass: 'read',
      permission: { roles: ['admin'] },
      handler: readRepositories,
    },
    ...createAppTools({ ee, repos, services, mintToken: async () => 'x' }),
    // The kernel audit read is faked empty: the rail's rows here come from
    // ee's journal (the deploys the spec just made).
    ...createActivityTools({ ee, toolEvents: async () => [] }),
  ]
  const registry = new KernelRegistry({
    approvalPolicy: new ModeAwareApprovalPolicy(
      new Set(APP_AGENT_GATED_TOOLS),
      new InMemoryApprovalModeStore('ask'),
    ),
    approvalStore: new InMemoryApprovalStore(),
  })
  for (const t of tools) registry.register(t)
  holder.registry = registry
  // The owner's own click is a human action: deploys go through the tool as them.
  const deployAsOwner = async (input: Record<string, unknown>) => {
    const deploy = tools.find((t) => t.name === 'website.app_deploy') as ToolDescriptor
    await deploy.handler(human, deploy.inputSchema.parse(input))
  }
  return { ee, repos, readRepositories, deployAsOwner }
}

const event = () => ({ locals: { user: { id: 'u1' } } }) as never

describe('/m/website: the module front page (apps + activity)', () => {
  it('managed: every app enriched with its domains, url and newest deploy; the site entry carries the public host; activity beside them', async () => {
    const { ee, deployAsOwner } = await setup()
    await deployAsOwner({
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })
    await deployAsOwner({
      repo: 'kindred/shop',
      branch: 'main',
      name: 'worker',
      kind: 'backend',
      contract: form,
    })
    setPublicHost(ee, 'kindred.digital')

    const data = (await load(event())) as {
      apps: AppListResult
      appsError: string | null
      activity: { items: unknown[] } | null
      activityError: string | null
    }

    expect(data.appsError).toBeNull()
    expect(data.apps!.managed).toBe(true)
    expect(data.apps!.site).toEqual({
      publicHost: 'kindred.digital',
      url: 'https://kindred.digital',
    })
    const shop = data.apps!.services.find((s) => s.name === 'shop')
    expect(shop).toMatchObject({
      domains: ['shop.ee.localhost'],
      url: 'https://shop.ee.localhost',
      lastDeploy: { status: 'live', stage: 'live' },
    })
    // A back-end service has no route, so no url.
    expect(data.apps!.services.find((s) => s.name === 'worker')).toMatchObject({
      domains: [],
      url: null,
    })
    expect(data.apps!.catalog).toMatchObject({ runtimes: { node: ['22'] } })
    // The deploys just made are in the rail.
    expect(data.activityError).toBeNull()
    expect(data.activity!.items.length).toBeGreaterThan(0)
  })

  it('ee unreachable: the page still loads, explicitly unmanaged (no domains, no deploys, no site host)', async () => {
    const { ee, deployAsOwner } = await setup()
    await deployAsOwner({
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })
    ee.status = async () => {
      throw new SubstrateUnavailableError('ENOENT')
    }

    const data = (await load(event())) as {
      apps: AppListResult
      appsError: string | null
    }

    expect(data.appsError).toBeNull()
    expect(data.apps!.managed).toBe(false)
    expect(data.apps!.catalog).toBeNull()
    expect(data.apps!.services).toHaveLength(1)
    expect(data.apps!.services[0]).toMatchObject({
      name: 'shop',
      domains: [],
      url: null,
      lastDeploy: null,
    })
    expect(data.apps!.site).toEqual({ publicHost: null, url: null })
  })

  it('preserves saved public and private repositories while exposing a deployment server error', async () => {
    const { ee, repos, readRepositories } = await setup()
    await repos.add({
      ...repo,
      repoId: null,
      fullName: 'kindred/private',
      htmlUrl: 'https://github.com/kindred/private',
      cloneUrl: 'git@github.com:kindred/private.git',
      visibility: 'private',
      authKind: 'deploy_key',
      deployKeyId: 'sealed-key-id',
    })
    ee.status = async () => {
      throw new SubstrateError(500, 'server-failed', null, null)
    }
    const data = (await load(event())) as {
      apps: AppListResult | null
      appsError: string | null
      savedRepositories: unknown[]
      repositoriesError: string | null
    }
    expect(data.apps).toBeNull()
    expect(data.appsError).toBeTruthy()
    expect(data.repositoriesError).toBeNull()
    expect(data.savedRepositories).toEqual([
      {
        fullName: 'kindred/private',
        branch: 'main',
        htmlUrl: 'https://github.com/kindred/private',
        visibility: 'private',
        authKind: 'deploy_key',
      },
      {
        fullName: 'kindred/shop',
        branch: 'main',
        htmlUrl: 'https://github.com/kindred/shop',
        visibility: 'public',
        authKind: 'public',
      },
    ])
    expect(readRepositories).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(data.savedRepositories)).not.toContain('sealed-key-id')
    expect(JSON.stringify(data.savedRepositories)).not.toContain('cloneUrl')
  })

  it('shows both errors when the server and independent repository inventory fail', async () => {
    const { ee, readRepositories } = await setup()
    ee.status = async () => {
      throw new SubstrateError(500, 'server-failed', null, null)
    }
    readRepositories.mockRejectedValueOnce(new Error('Repository inventory unavailable'))
    const data = (await load(event())) as {
      apps: AppListResult | null
      appsError: string | null
      savedRepositories: unknown[]
      repositoriesError: string | null
    }
    expect(data.apps).toBeNull()
    expect(data.appsError).toBeTruthy()
    expect(data.savedRepositories).toEqual([])
    expect(data.repositoriesError).toBeTruthy()
  })

  it('uses the complete app overview without another repository read when server status succeeds', async () => {
    const { readRepositories } = await setup()
    await load(event())
    expect(readRepositories).not.toHaveBeenCalled()
  })

  it('with zero apps the shape is still complete', async () => {
    await setup()
    const data = (await load(event())) as { apps: AppListResult }
    expect(data.apps.services).toEqual([])
    expect(data.apps.repositories).toEqual([
      {
        fullName: 'kindred/shop',
        branch: 'main',
        htmlUrl: 'https://github.com/kindred/shop',
        visibility: 'public',
        authKind: 'public',
        apps: [],
      },
    ])
    expect(data.apps.site).toEqual({ publicHost: null, url: null })
  })
})
