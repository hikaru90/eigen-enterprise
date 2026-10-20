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
  holder: { registry: null as unknown, approvals: null as unknown },
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

import { actions, load } from './+page.server'
import { actions as detailActions, load as detailLoad } from './[name]/+page.server'

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
