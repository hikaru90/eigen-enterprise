import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import { startOwnerDeploy } from '$lib/server/website/deploy-runner'
import { deployJobs } from '../../../../../../../../modules/website/apps/deploy-jobs'
import { InMemoryServiceStore } from '../../../../../../../../modules/website/apps/store'
import { FakeEe } from '../../../../../../../../modules/website/apps/testing'
import {
  APP_AGENT_GATED_TOOLS,
  createAppTools,
} from '../../../../../../../../modules/website/apps/tools'
import { InMemoryConnectedRepoStore } from '../../../../../../../../modules/website/github/repos-store'

const { holder } = vi.hoisted(() => ({
  holder: {
    registry: null as unknown,
    approvals: null as unknown,
  },
}))

vi.mock('$lib/server/auth/require-admin', () => ({ requireAdmin: async (u: unknown) => u }))
vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
vi.mock('../../../../../../../../modules/index', () => ({
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

import { POST } from './+server'

const user = { id: 'u1' }

async function setup() {
  const ee = new FakeEe()
  const repos = new InMemoryConnectedRepoStore()
  await repos.add({
    repoId: 1,
    fullName: 'heroku/node-js-getting-started',
    branch: 'main',
    htmlUrl: 'https://github.com/heroku/node-js-getting-started',
    cloneUrl: 'https://github.com/heroku/node-js-getting-started.git',
    visibility: 'public',
    authKind: 'public',
    installationId: null,
    deployKeyId: null,
    connectedBy: 'human:u1',
  })
  const approvals = new InMemoryApprovalStore()
  // "ask": every gated tool waits — the owner's click must still go through.
  const registry = new KernelRegistry({
    approvalPolicy: new ModeAwareApprovalPolicy(
      new Set(APP_AGENT_GATED_TOOLS),
      new InMemoryApprovalModeStore('ask'),
    ),
    approvalStore: approvals,
  })
  for (const t of createAppTools({
    ee,
    repos,
    services: new InMemoryServiceStore(),
    mintToken: async () => 'x',
  }))
    registry.register(t)
  holder.registry = registry
  holder.approvals = approvals
  return { ee }
}

/** The app exists (as the add flow would have created it) before the endpoint is called. */
async function deployApp(name: string, contract: Record<string, string> | null) {
  const job = startOwnerDeploy(user, {
    name,
    repo: 'heroku/node-js-getting-started',
    branch: 'main',
    kind: 'web',
    ...(contract ? { contract } : {}),
  })
  await job.done
}

const post = (body: unknown) =>
  new Request('http://x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const call = (name: string, body: unknown) =>
  POST({ locals: { user }, params: { name }, request: post(body) } as never)

const formContract = {
  runtime: 'node',
  nodeVersion: '22',
  install: 'npm install --omit=dev',
  build: '',
  start: 'node index.js',
  health: '/',
}

describe('POST /m/website/apps/[name]/deploy', () => {
  it('answers at once with the job the page follows, and the deploy runs in the background', async () => {
    const { ee } = await setup()
    await deployApp('gs', formContract)
    ee.calls = []

    const res = await call('gs', {})
    expect(res.status).toBe(200)
    const { jobId } = (await res.json()) as { jobId: string }
    expect(jobId).toEqual(expect.any(String))
    // Not settled yet: the answer comes before the deploy finished.
    expect(deployJobs.get(jobId)!.state).toBe('running')

    await deployJobs.get(jobId)!.done
    expect(deployJobs.get(jobId)!.state).toBe('done')
    expect(ee.calls.map((c) => c.verb)).toContain('createApp')
  })

  it('accepted AI changes are applied onto the stored build contract', async () => {
    const { ee } = await setup()
    await deployApp('gs', formContract)
    ee.calls = []

    const res = await call('gs', { changes: { start: 'node server.js' } })
    expect(res.status).toBe(200)
    const { jobId } = (await res.json()) as { jobId: string }
    await deployJobs.get(jobId)!.done
    expect(deployJobs.get(jobId)!.state).toBe('done')

    const created = ee.calls.find((c) => c.verb === 'createApp')!.input as {
      contract: { start: string[]; build: string[][] }
    }
    expect(created.contract.start).toEqual(['node', 'server.js'])
    // The rest of the stored form contract carries over.
    expect(created.contract.build).toEqual([['npm', 'install', '--omit=dev']])
  })

  it("the repo's own ee.json is the contract: a change is refused with 409, nothing deploys", async () => {
    const { ee } = await setup()
    // A repo-contract app: deployed without a form contract, so ee builds from ee.json.
    ee.repoContract = {
      present: true,
      contract: {
        runtime: 'node',
        node: '22',
        build: [['npm', 'ci']],
        start: ['node', 'index.js'],
        preStart: [],
        health: '/',
        services: [],
        capabilities: [],
      },
      gap: null,
      error: null,
    }
    await deployApp('gs-repo', null)
    ee.calls = []

    const res = await call('gs-repo', { changes: { start: 'node server.js' } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/ee\.json/)
    expect(ee.calls).toEqual([])
  })

  it('changes that are not valid build settings are a plain 400', async () => {
    await setup()
    const res = await call('gs', { changes: { start: 42 } })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Those build changes are not valid.')
  })
})
