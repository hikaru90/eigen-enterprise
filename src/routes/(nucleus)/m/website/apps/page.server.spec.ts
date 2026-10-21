import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { SubstrateUnavailableError } from '$lib/server/ee/client'
import { InMemoryServiceStore } from '../../../../../../modules/website/apps/store'
import { FakeEe } from '../../../../../../modules/website/apps/testing'
import {
  APP_AGENT_GATED_TOOLS,
  createAppTools,
  type AppListResult,
} from '../../../../../../modules/website/apps/tools'
import {
  InMemoryConnectedRepoStore,
  type NewConnectedRepo,
} from '../../../../../../modules/website/github/repos-store'
import { InMemoryWebsiteStore } from '../../../../../../modules/website/store'

const { holder } = vi.hoisted(() => ({
  holder: {
    registry: null as unknown,
  },
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: async (u: unknown) => u }))
vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
vi.mock('../../../../../../modules/index', () => ({
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

/** FakeEe pins publicHost to null; the overview reads it from ee's settings. */
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
  const pages = new InMemoryWebsiteStore()
  const tools = createAppTools({ ee, repos, services, pages, mintToken: async () => 'x' })
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
  return { ee, pages, deployAsOwner }
}

const event = () => ({ locals: { user: { id: 'u1' } } }) as never

describe('/m/website/apps: the overview load', () => {
  it('managed: the site entry, and every app enriched with its domains, url and newest deploy', async () => {
    const { ee, pages, deployAsOwner } = await setup()
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
    await pages.createPage({ slug: 'home', title: 'Home', body: 'x', visibility: 'public' })
    setPublicHost(ee, 'kindred.digital')

    const data = (await load(event())) as AppListResult

    expect(data.managed).toBe(true)
    expect(data.site).toEqual({
      publicHost: 'kindred.digital',
      url: 'https://kindred.digital',
      pages: { published: 1, drafts: 0 },
    })
    const shop = data.services.find((s) => s.name === 'shop')
    expect(shop).toMatchObject({
      domains: ['shop.ee.localhost'],
      url: 'https://shop.ee.localhost',
      lastDeploy: { status: 'live', stage: 'live' },
    })
    // A back-end service has no route, so no url.
    expect(data.services.find((s) => s.name === 'worker')).toMatchObject({
      domains: [],
      url: null,
    })
    expect(data.catalog).toMatchObject({ runtimes: { node: ['22'] } })
  })

  it('ee unreachable: the page still loads, explicitly unmanaged (no domains, no deploys, no site host)', async () => {
    const { ee, pages, deployAsOwner } = await setup()
    await deployAsOwner({
      repo: 'kindred/shop',
      branch: 'main',
      name: 'shop',
      kind: 'web',
      contract: form,
    })
    await pages.createPage({ slug: 'home', title: 'Home', body: 'x', visibility: 'public' })
    ee.status = async () => {
      throw new SubstrateUnavailableError('ENOENT')
    }

    const data = (await load(event())) as AppListResult

    expect(data.managed).toBe(false)
    expect(data.catalog).toBeNull()
    expect(data.services).toHaveLength(1)
    expect(data.services[0]).toMatchObject({
      name: 'shop',
      domains: [],
      url: null,
      lastDeploy: null,
    })
    expect(data.site).toEqual({
      publicHost: null,
      url: null,
      pages: { published: 1, drafts: 0 },
    })
  })

  it('with zero apps the shape is still complete: no services, but the site entry is there', async () => {
    await setup()
    const data = (await load(event())) as AppListResult
    expect(data.services).toEqual([])
    expect(data.site).toEqual({
      publicHost: null,
      url: null,
      pages: { published: 0, drafts: 0 },
    })
  })
})
