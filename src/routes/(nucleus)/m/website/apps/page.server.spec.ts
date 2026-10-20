import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import { InMemoryServiceStore } from '../../../../../../modules/website/apps/store'
import { FakeEe } from '../../../../../../modules/website/apps/testing'
import { APP_AGENT_GATED_TOOLS, createAppTools } from '../../../../../../modules/website/apps/tools'
import { InMemoryConnectedRepoStore } from '../../../../../../modules/website/github/repos-store'

const { holder } = vi.hoisted(() => ({
  holder: {
    registry: null as unknown,
    approvals: null as unknown,
    llmCalls: [] as unknown[],
    llmAnswer: null as unknown,
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

import { deployJobs } from '../../../../../../modules/website/apps/deploy-jobs'
import { FAKE_CRASH } from '../../../../../../modules/website/apps/testing'
import { actions, load } from './+page.server'
import { actions as detailActions, load as detailLoad } from './[name]/+page.server'
import { GET as progressGET } from './[name]/deploy-progress/+server'
import { POST as deployPOST } from './[name]/deploy/+server'
import { POST as diagnosePOST } from './[name]/diagnose/+server'

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
    diagnoseLlm: async (input) => {
      holder.llmCalls.push(input)
      return { choices: [{ message: { content: JSON.stringify(holder.llmAnswer) } }] }
    },
  }))
    registry.register(t)
  registry.register({
    name: 'website.github_list_repos',
    module: 'website',
    summary: 'fake',
    auditClass: 'read',
    inputSchema: z.object({}),
    permission: { roles: ['admin'] },
    handler: async () => ({
      github: {},
      repos: (await repos.list()).map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    }),
  })
  holder.registry = registry
  holder.approvals = approvals
  return { ee }
}

const user = { id: 'u1' }
const event = (extra: Record<string, unknown> = {}) =>
  ({ locals: { user }, params: {}, ...extra }) as never

function formRequest(fields: Record<string, string>) {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  return new Request('http://x', { method: 'POST', body })
}

describe('/m/website/apps', () => {
  it('loads services, connected repos (with a suggested app name) and the catalog', async () => {
    await setup()
    const data = (await load(event())) as {
      services: unknown[]
      repos: Array<{ suggestedName: string }>
      catalog: { runtimes: { node: string[] } }
      error: null
    }
    expect(data.services).toEqual([])
    expect(data.repos[0]!.suggestedName).toBe('node-js-getting-started')
    expect(data.catalog.runtimes.node).toEqual(['22'])
    expect(data.error).toBeNull()
  })

  it('the deploy click (owner = approval) deploys and redirects to the app; then the detail page loads', async () => {
    const { ee } = await setup()
    const request = formRequest({
      source: 'heroku/node-js-getting-started#main',
      name: 'getting-started',
      kind: 'web',
      useForm: 'on',
      runtime: 'node@22',
      install: 'npm install --omit=dev',
      start: 'node index.js',
      health: '/',
    })
    await expect(actions.deploy(event({ request }))).rejects.toMatchObject({
      status: 303,
      location: '/m/website/apps/getting-started',
    })
    expect(ee.calls.map((c) => c.verb)).toEqual([
      'fetchSource',
      'sourceContract',
      'createApp',
      'addDomain',
    ])

    const detail = (await detailLoad(event({ params: { name: 'getting-started' } }))) as {
      app: { url: string; status: string; env: string[] }
      logs: string[]
    }
    expect(detail.app).toMatchObject({
      url: 'https://getting-started.ee.localhost',
      status: 'healthy',
      env: [],
    })
    expect(detail.logs).toEqual(['listening on 4100'])
  })

  it('a deploy problem shows as a plain sentence', async () => {
    await setup()
    const request = formRequest({
      source: 'heroku/node-js-getting-started#main',
      name: 'getting-started',
      kind: 'web',
    })
    const out = (await actions.deploy(event({ request }))) as {
      status: number
      data: { error: string }
    }
    expect(out.status).toBe(400)
    expect(out.data.error).toMatch(/no ee\.json/)
  })

  it('redeploy from the detail page can carry an edited build contract', async () => {
    const { ee } = await setup()
    await actions
      .deploy(
        event({
          request: formRequest({
            source: 'heroku/node-js-getting-started#main',
            name: 'gs',
            kind: 'web',
            useForm: 'on',
            runtime: 'node@22',
            start: 'node index.js',
          }),
        }),
      )
      .catch(() => undefined)
    const detail = (await detailLoad(event({ params: { name: 'gs' } }))) as {
      nodeVersions: string[]
      contractFields: { start: string } | null
    }
    expect(detail.nodeVersions).toEqual(['22'])
    expect(detail.contractFields).toMatchObject({ runtime: 'node@22', start: 'node index.js' })
    ee.calls = []
    const out = await detailActions.deploy(
      event({
        params: { name: 'gs' },
        request: formRequest({
          useForm: 'on',
          runtime: 'node@22',
          start: 'node server/main.js',
          health: '/',
        }),
      }),
    )
    // Runs in the background: the action answers with the job the page follows.
    expect(out).toMatchObject({ action: 'deploy', name: 'gs', jobId: expect.any(String) })
    await deployJobs.get((out as { jobId: string }).jobId)!.done
    expect(deployJobs.get((out as { jobId: string }).jobId)!.state).toBe('done')
    const created = ee.calls.find((c) => c.verb === 'createApp')!.input as {
      contract: { start: string[] }
    }
    expect(created.contract.start).toEqual(['node', 'server/main.js'])
  })

  it('env set from the page never returns the value', async () => {
    await setup()
    await actions
      .deploy(
        event({
          request: formRequest({
            source: 'heroku/node-js-getting-started#main',
            name: 'gs',
            kind: 'web',
            useForm: 'on',
            runtime: 'node@22',
            start: 'node index.js',
          }),
        }),
      )
      .catch(() => undefined)
    const out = await detailActions.env(
      event({
        params: { name: 'gs' },
        request: formRequest({ key: 'API_KEY', value: 'sk-secret-123' }),
      }),
    )
    expect(JSON.stringify(out)).not.toContain('sk-secret')
    expect(out).toMatchObject({ ok: true })
  })
})

describe('/m/website/apps: background deploy, progress, "Ask AI"', () => {
  const deployForm = (name: string) =>
    formRequest({
      source: 'heroku/node-js-getting-started#main',
      name,
      kind: 'web',
      useForm: 'on',
      runtime: 'node@22',
      install: 'npm install --omit=dev',
      start: 'node index.js',
      health: '/',
    })
  const progress = async (name: string, jobId: string) => {
    const res = await progressGET(
      event({
        params: { name },
        url: new URL(`http://x/m/website/apps/${name}/deploy-progress?job=${jobId}`),
      }),
    )
    return { status: res.status, body: await res.json() }
  }
  const post = (body: unknown) =>
    new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it("a slow deploy returns at once with a job; progress shows the stage, then the failure with ee's cause and the log", async () => {
    const { ee } = await setup()
    ee.failHealth = true
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const createApp = ee.createApp.bind(ee)
    ee.createApp = async (i) => {
      await gate
      return createApp(i)
    }
    const out = (await actions.deploy(event({ request: deployForm('gs-slow') }))) as {
      jobId: string
      name: string
    }
    expect(out).toMatchObject({ action: 'deploy', name: 'gs-slow', jobId: expect.any(String) })

    const running = await progress('gs-slow', out.jobId)
    expect(running.status).toBe(200)
    expect(running.body).toMatchObject({ state: 'running', stage: 'fetching', deployId: null })

    release()
    await deployJobs.get(out.jobId)!.done
    const ended = await progress('gs-slow', out.jobId)
    expect(ended.body).toMatchObject({
      state: 'failed',
      failedStage: 'health',
      deployId: expect.any(String),
    })
    expect(ended.body.error).toBe(
      `gs-slow failed while waiting for its health check: ${FAKE_CRASH}.`,
    )
    expect(ended.body.error).not.toMatch(/deploy history/)
    expect(ended.body.lines.join('\n')).toContain('MODULE_NOT_FOUND')
    expect(ended.body.stages.map((s: { stage: string }) => s.stage)).toEqual([
      'fetching',
      'building',
      'starting',
      'health',
      'failed',
    ])

    // The detail page keeps the failure (with its log) after a reload.
    const detail = (await detailLoad(event({ params: { name: 'gs-slow' } }))) as {
      lastDeploy: { state: string; error: string; lines: string[]; deployId: string }
    }
    expect(detail.lastDeploy).toMatchObject({ state: 'failed', deployId: ended.body.deployId })
    expect(detail.lastDeploy.error).toContain(FAKE_CRASH)
  })

  it('an unknown job is a plain 404, not a crash', async () => {
    await setup()
    const r = await progress('gs', '00000000-0000-4000-8000-000000000000')
    expect(r.status).toBe(404)
    expect(r.body.error).toMatch(/not running on this server/)
  })

  it('"Ask AI": the diagnosis goes through the gateway caller and comes back in plain words; "Apply and redeploy" applies the change', async () => {
    const { ee } = await setup()
    ee.failHealth = true
    await actions.deploy(event({ request: deployForm('gs-ai') })).catch(() => undefined)
    const deployId = ee.deployRecords.at(-1)!.id
    holder.llmCalls = []
    holder.llmAnswer = {
      cause: 'The start command runs index.js, which this repo does not have.',
      fix: 'Start it with node server.js instead.',
      suggestedContractChanges: { start: 'node server.js' },
    }
    const res = await diagnosePOST(
      event({ params: { name: 'gs-ai' }, request: post({ deployId }) }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...(holder.llmAnswer as object), contractSource: 'form' })
    expect(holder.llmCalls).toHaveLength(1)

    holder.llmAnswer = { verdict: 'no idea' }
    const bad = await diagnosePOST(
      event({ params: { name: 'gs-ai' }, request: post({ deployId }) }),
    )
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/expected shape/)

    ee.failHealth = false
    const applied = await deployPOST(
      event({ params: { name: 'gs-ai' }, request: post({ changes: { start: 'node server.js' } }) }),
    )
    const { jobId } = (await applied.json()) as { jobId: string }
    await deployJobs.get(jobId)!.done
    const last = ee.calls.filter((c) => c.verb === 'createApp').at(-1)!.input as {
      contract: { start: string[]; build: string[][] }
    }
    expect(last.contract.start).toEqual(['node', 'server.js'])
    expect(last.contract.build).toEqual([['npm', 'install', '--omit=dev']])
    expect((await progress('gs-ai', jobId)).body).toMatchObject({ state: 'live', stage: 'live' })

    const invalid = await deployPOST(
      event({ params: { name: 'gs-ai' }, request: post({ changes: { start: 42 } }) }),
    )
    expect(invalid.status).toBe(400)
  })
})
