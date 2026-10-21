import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import { startOwnerDeploy } from '$lib/server/website/deploy-runner'
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
    llmCalls: [] as unknown[],
    llmAnswer: null as unknown,
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
    diagnoseLlm: async (input) => {
      holder.llmCalls.push(input)
      return { choices: [{ message: { content: JSON.stringify(holder.llmAnswer) } }] }
    },
  }))
    registry.register(t)
  holder.registry = registry
  holder.approvals = approvals
  holder.llmCalls = []
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

/** Deploy (and fail, when failHealth) in the background, then answer the attempt's id. */
async function failedDeploy(name: string): Promise<string> {
  const job = startOwnerDeploy(user, {
    name,
    repo: 'heroku/node-js-getting-started',
    branch: 'main',
    kind: 'web',
    contract: formContract,
  })
  await job.done
  return job.id
}

const post = (body: unknown) =>
  new Request('http://x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const call = (name: string, body: unknown) =>
  POST({ locals: { user }, params: { name }, request: post(body) } as never)

describe('POST /m/website/apps/[name]/diagnose', () => {
  it('the failed deploy goes to the LLM gateway caller and the answer comes back in plain words', async () => {
    const { ee } = await setup()
    ee.failHealth = true
    const name = 'gs-ai'
    await failedDeploy(name)
    const deployId = ee.deployRecords.at(-1)!.id
    holder.llmAnswer = {
      cause: 'The start command runs index.js, which this repo does not have.',
      fix: 'Start it with node server.js instead.',
      suggestedContractChanges: { start: 'node server.js' },
    }

    const res = await call(name, { deployId })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...holder.llmAnswer, contractSource: 'form' })
    expect(holder.llmCalls).toHaveLength(1)
  })

  it('an answer without the expected shape is a plain 400 that says to ask again', async () => {
    const { ee } = await setup()
    ee.failHealth = true
    await failedDeploy('gs-shape')
    const deployId = ee.deployRecords.at(-1)!.id
    holder.llmAnswer = { verdict: 'no idea' }

    const res = await call('gs-shape', { deployId })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/expected shape/)
  })

  it('a deploy that did not fail has nothing to diagnose: plain words, no LLM call', async () => {
    const { ee } = await setup()
    await failedDeploy('gs-live')
    const deployId = ee.deployRecords.at(-1)!.id
    holder.llmAnswer = { cause: 'x', fix: 'y' }

    const res = await call('gs-live', { deployId })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/nothing to diagnose/)
    expect(holder.llmCalls).toEqual([])
  })

  it('an unknown deploy id maps to a plain sentence, never a raw ee error', async () => {
    await setup()
    await failedDeploy('gs-unknown')
    const res = await call('gs-unknown', { deployId: '00000000-0000-4000-8000-000000000000' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error).not.toMatch(/SubstrateError|urn:ee|at \w+ \(/)
  })
})
