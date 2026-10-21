import { generateKeyPairSync } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import { GitHubApi } from '../../../../../../modules/website/github/api'
import {
  createGitHubConnectTools,
  type DeployKeyEe,
} from '../../../../../../modules/website/github/connect-tools'
import { InMemoryConnectedRepoStore } from '../../../../../../modules/website/github/repos-store'
import { InMemoryGitHubStore } from '../../../../../../modules/website/github/store'

const { holder } = vi.hoisted(() => ({
  holder: { registry: null as unknown },
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

/**
 * /m/website/github carries the GitHub App connection only (decision D-W4).
 * The page runs one read (the App status) through the registry; the deploy-key
 * and connect/disconnect tools are registered only so that read is real — this
 * page must never call them, so their seams fail loud if it did.
 */
const unusedEe: DeployKeyEe = {
  createDeployKey: async () => {
    throw new Error('the GitHub page must not create deploy keys')
  },
  checkDeployKey: async () => {
    throw new Error('the GitHub page must not check deploy keys')
  },
  deleteDeployKey: async () => {
    throw new Error('the GitHub page must not delete deploy keys')
  },
}

let github: InMemoryGitHubStore
const cookies = { set: vi.fn() }
const user = { id: 'owner-1' }

beforeEach(() => {
  github = new InMemoryGitHubStore()
  const approvals = new InMemoryApprovalStore()
  const registry = new KernelRegistry({
    approvalPolicy: new ModeAwareApprovalPolicy(
      new Set(['website.github_connect_repo', 'website.github_disconnect_repo']),
      new InMemoryApprovalModeStore('ask'),
    ),
    approvalStore: approvals,
  })
  for (const t of createGitHubConnectTools({
    github,
    repos: new InMemoryConnectedRepoStore(),
    api: new GitHubApi(async () => {
      throw new Error('the GitHub page must not fetch repositories')
    }),
    ee: unusedEe,
  })) {
    registry.register(t)
  }
  holder.registry = registry
  cookies.set.mockClear()
})

function event() {
  return {
    locals: { user },
    cookies,
    url: new URL('https://kindred.example/m/website/github'),
  } as never
}

async function createAppWithoutInstallation() {
  await github.saveConnection(
    {
      appId: 1,
      appSlug: 'eigen-kindred',
      clientId: 'Iv1.x',
      htmlUrl: 'https://github.com/apps/eigen-kindred',
    },
    { privateKeyPem: privateKeyPem(), webhookSecret: 'wh', clientSecret: 'cs' },
  )
}

function privateKeyPem(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
}

describe('/m/website/github', () => {
  it('load: not connected → the manifest flow is offered and the state cookie is set', async () => {
    const data = (await load(event())) as Record<string, unknown>
    expect(data.github).toEqual({
      connected: false,
      installed: false,
      appSlug: null,
      manageUrl: null,
    })
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

  it('load: app created but not installed → the install link, no manifest, no state cookie', async () => {
    await createAppWithoutInstallation()
    const data = (await load(event())) as Record<string, unknown>
    expect(data.github).toEqual({
      connected: true,
      installed: false,
      appSlug: 'eigen-kindred',
      manageUrl: 'https://github.com/apps/eigen-kindred/installations/new',
    })
    expect(data.manifest).toBeNull()
    expect(cookies.set).not.toHaveBeenCalled()
  })

  it('load: installed → connected status and no manifest (repos are connected when adding an app)', async () => {
    await createAppWithoutInstallation()
    await github.setInstallation(7)
    const data = (await load(event())) as Record<string, unknown>
    expect(data.github).toEqual({
      connected: true,
      installed: true,
      appSlug: 'eigen-kindred',
      manageUrl: 'https://github.com/apps/eigen-kindred/installations/new',
    })
    expect(data.manifest).toBeNull()
    expect(cookies.set).not.toHaveBeenCalled()
  })
})
