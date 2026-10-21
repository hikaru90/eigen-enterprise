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
import { FAKE_CRASH, FakeEe } from '../../../../../../../../modules/website/apps/testing'
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

import { GET } from './+server'

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

const formContract = {
  runtime: 'node',
  nodeVersion: '22',
  install: 'npm install --omit=dev',
  build: '',
  start: 'node index.js',
  health: '/',
}

/** Start a background deploy the way the pages do and answer its job id. */
async function start(name: string): Promise<string> {
  return startOwnerDeploy(user, {
    name,
    repo: 'heroku/node-js-getting-started',
    branch: 'main',
    kind: 'web',
    contract: formContract,
  }).id
}

const get = (name: string, jobId: string) =>
  GET({
    locals: { user },
    params: { name },
    url: new URL(`http://x/m/website/apps/${name}/deploy-progress?job=${jobId}`),
  } as never)

const body = async (res: Response) => (await res.json()) as Record<string, unknown>

describe('GET /m/website/apps/[name]/deploy-progress', () => {
  it('a running deploy reports its stage at once', async () => {
    const { ee } = await setup()
    // Hold createApp so the job is still running when the page polls.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const createApp = ee.createApp.bind(ee)
    ee.createApp = async (i) => {
      await gate
      return createApp(i)
    }
    const jobId = await start('gs-running')

    const res = await get('gs-running', jobId)
    expect(res.status).toBe(200)
    expect(await body(res)).toMatchObject({ state: 'running', stage: 'fetching', deployId: null })

    release()
    await deployJobs.get(jobId)!.done
  })

  it("a failed deploy reports the failure with ee's cause, its stage path and the log", async () => {
    const { ee } = await setup()
    ee.failHealth = true
    const jobId = await start('gs-failed')
    await deployJobs.get(jobId)!.done

    const res = await get('gs-failed', jobId)
    expect(res.status).toBe(200)
    const out = await body(res)
    expect(out).toMatchObject({
      state: 'failed',
      failedStage: 'health',
      deployId: expect.any(String),
    })
    expect(out.error).toBe(`gs-failed failed while waiting for its health check: ${FAKE_CRASH}.`)
    expect((out.lines as string[]).join('\n')).toContain('MODULE_NOT_FOUND')
    expect((out.stages as Array<{ stage: string }>).map((s) => s.stage)).toEqual([
      'fetching',
      'building',
      'starting',
      'health',
      'failed',
    ])
  })

  it('an unknown job is a plain 404, not a crash', async () => {
    await setup()
    const res = await get('gs', '00000000-0000-4000-8000-000000000000')
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual({
      error: expect.stringMatching(/not running on this server/),
    })
  })

  it('another app may not follow a job that is not its own: it is a plain 404 too', async () => {
    await setup()
    const jobId = await start('gs-mine')
    const res = await get('gs-other', jobId)
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual({
      error: expect.stringMatching(/not running on this server/),
    })
    await deployJobs.get(jobId)!.done
  })
})
