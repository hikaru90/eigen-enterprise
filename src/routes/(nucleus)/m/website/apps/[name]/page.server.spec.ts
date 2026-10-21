import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import { EeClient } from '$lib/server/ee/client'
import {
  createDomainTools,
  type DomainEe,
} from '../../../../../../../modules/website/apps/domain-tools'
import { InMemoryServiceStore } from '../../../../../../../modules/website/apps/store'
import { FakeEe } from '../../../../../../../modules/website/apps/testing'
import {
  APP_AGENT_GATED_TOOLS,
  createAppTools,
} from '../../../../../../../modules/website/apps/tools'
import { InMemoryConnectedRepoStore } from '../../../../../../../modules/website/github/repos-store'
import { createSubstrateTools } from '../../../../../../../modules/website/hosting/tools'

const { holder } = vi.hoisted(() => ({
  holder: {
    registry: null as unknown,
    approvals: null as unknown,
  },
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

import { actions, load } from './+page.server'

/** FakeEe plus the removeDomain verb the per-app domain tools use. */
class FakeEeWithDomains extends FakeEe implements DomainEe {
  removed: Array<{ host: string; author: string }> = []
  async removeDomain(i: { host: string; author: string }) {
    this.calls.push({ verb: 'removeDomain', input: i })
    this.removed.push(i)
    this.routes = this.routes.filter((r) => r.host !== i.host)
    return { rev: 's4', reconcileError: null }
  }
}

async function setup() {
  const ee = new FakeEeWithDomains()
  ee.routes = [
    { host: 'os.ee.localhost', workload: 'os' },
    { host: 'shop.ee.localhost', workload: 'shop' },
  ]
  ee.workloads = [
    {
      name: 'shop',
      tier: 'app',
      source: { kind: 'release' },
      deploy: { auto: false },
      contract: null,
      secrets: [],
      declaredSecrets: ['STRIPE_KEY'],
      live: { release: 'r1', slot: 'a' },
      lastError: null,
    },
  ]
  ee.secretNames['shop'] = ['API_KEY']
  const repos = new InMemoryConnectedRepoStore()
  await repos.add({
    repoId: 1,
    fullName: 'kindred/shop',
    branch: 'main',
    htmlUrl: 'https://github.com/kindred/shop',
    cloneUrl: 'https://github.com/kindred/shop.git',
    visibility: 'public',
    authKind: 'public',
    installationId: null,
    deployKeyId: null,
    connectedBy: 'human:u1',
  })
  const services = new InMemoryServiceStore()
  await services.upsert({
    name: 'shop',
    kind: 'web',
    repoFullName: 'kindred/shop',
    branch: 'main',
    repoId: 1,
    authKind: 'public',
    host: 'shop.ee.localhost',
    autoDeploy: false,
    createdBy: 'human:u1',
  })
  // substrate tools (secrets, managed state) through a recording ee client
  // whose transport serves the same fake server state.
  const eeHttp: string[] = []
  const client = new EeClient(async (method, path) => {
    eeHttp.push(`${method} ${path}`)
    if (method === 'GET' && path === '/v1/status') return { status: 200, data: await ee.status() }
    return { status: 200, data: { ok: true, reconcileError: null } }
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
  for (const t of [
    ...createAppTools({ ee, repos, services, mintToken: async () => 'x' }),
    ...createDomainTools({ ee, services }),
    ...createSubstrateTools({ client }),
  ])
    registry.register(t)
  holder.registry = registry
  holder.approvals = approvals
  return { ee, eeHttp, services }
}

const user = { id: 'u1' }
const event = (extra: Record<string, unknown> = {}) =>
  ({ locals: { user }, params: {}, ...extra }) as never

function formRequest(fields: Record<string, string>) {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  return new Request('http://x', { method: 'POST', body })
}

describe('/m/website/apps/[name]', () => {
  it("loads the app, its logs, the workload's secret names and the managed state", async () => {
    await setup()
    const data = (await load(event({ params: { name: 'shop' } }))) as {
      app: { name: string; domains: string[]; status: string }
      managed: boolean
      secretNames: string[]
      logs: string[]
    }
    expect(data.app).toMatchObject({
      name: 'shop',
      status: 'healthy',
      domains: ['shop.ee.localhost'],
    })
    expect(data.managed).toBe(true)
    // Declared names only — never a value.
    expect(data.secretNames).toEqual(['API_KEY', 'STRIPE_KEY'])
    expect(data.logs).toEqual(['listening on 4100'])
  })

  it('an unknown app is a plain 404', async () => {
    await setup()
    await expect(load(event({ params: { name: 'ghost' } }))).rejects.toMatchObject({ status: 404 })
  })

  describe('domainSet', () => {
    it('adds a domain through website.app_domain_set and answers in plain words', async () => {
      const { ee, services } = await setup()
      const out = (await actions.domainSet(
        event({ params: { name: 'shop' }, request: formRequest({ host: 'shop.kindred.dev' }) }),
      )) as { action: string; ok: boolean; message: string }
      expect(out.ok).toBe(true)
      expect(out.message).toContain('shop.kindred.dev')
      expect(ee.calls).toContainEqual({
        verb: 'addDomain',
        input: { host: 'shop.kindred.dev', workload: 'shop', role: 'app', author: 'human:u1' },
      })
      expect((await services.get('shop'))?.host).toBe('shop.ee.localhost')
    })

    it('with replace, the old address moves: removed, then the new one added', async () => {
      const { ee, services } = await setup()
      const out = await actions.domainSet(
        event({
          params: { name: 'shop' },
          request: formRequest({ host: 'shop.kindred.dev', replace: 'shop.ee.localhost' }),
        }),
      )
      expect(out).toMatchObject({ ok: true })
      expect(ee.removed).toEqual([{ host: 'shop.ee.localhost', author: 'human:u1' }])
      expect((await services.get('shop'))?.host).toBe('shop.kindred.dev')
    })

    it('a host in use comes back as a plain sentence naming the owner', async () => {
      const { ee } = await setup()
      const out = (await actions.domainSet(
        event({ params: { name: 'shop' }, request: formRequest({ host: 'os.ee.localhost' }) }),
      )) as { status: number; data: { action: string; error: string } }
      expect(out.status).toBe(400)
      expect(out.data.action).toBe('domainSet')
      expect(out.data.error).toMatch(/console/)
      expect(ee.calls).toEqual([])
    })
  })

  describe('domainRemove', () => {
    it('removes through website.app_domain_remove', async () => {
      const { ee } = await setup()
      await actions.domainSet(
        event({ params: { name: 'shop' }, request: formRequest({ host: 'shop.kindred.dev' }) }),
      )
      ee.calls = []
      const out = await actions.domainRemove(
        event({
          params: { name: 'shop' },
          request: formRequest({ host: 'shop.kindred.dev' }),
        }),
      )
      expect(out).toMatchObject({ ok: true })
      expect(ee.removed).toEqual([{ host: 'shop.kindred.dev', author: 'human:u1' }])
    })

    it('removing the last address of a web app is refused in plain words', async () => {
      const { ee } = await setup()
      const out = (await actions.domainRemove(
        event({ params: { name: 'shop' }, request: formRequest({ host: 'shop.ee.localhost' }) }),
      )) as { status: number; data: { action: string; error: string } }
      expect(out.status).toBe(400)
      expect(out.data.error).toBe('A web app needs one address; change it instead of removing it')
      expect(ee.calls).toEqual([])
    })
  })

  describe('secretSet', () => {
    it('sets a sealed secret through substrate.secret_set and never returns the value', async () => {
      const { eeHttp } = await setup()
      const out = (await actions.secretSet(
        event({
          params: { name: 'shop' },
          request: formRequest({ name: 'STRIPE_KEY', value: 'sk-live-SECRET-VALUE' }),
        }),
      )) as { action: string; ok: boolean; message: string }
      expect(out.ok).toBe(true)
      expect(out.message).toContain('STRIPE_KEY')
      expect(eeHttp).toContain('POST /v1/secrets')
      expect(JSON.stringify(out)).not.toContain('sk-live')
    })

    it('a bad name is a plain sentence, not a raw zod error', async () => {
      await setup()
      const out = (await actions.secretSet(
        event({
          params: { name: 'shop' },
          request: formRequest({ name: 'stripe_key', value: 'v' }),
        }),
      )) as { status: number; data: { action: string; error: string } }
      expect(out.status).toBe(400)
      expect(out.data.error).toBe('Some of what was entered is not valid. Check it and try again.')
    })
  })

  describe('remove', () => {
    it('removes the app and redirects to the overview', async () => {
      await setup()
      await expect(
        actions.remove(event({ params: { name: 'shop' }, request: formRequest({}) })),
      ).rejects.toMatchObject({ status: 303, location: '/m/website/apps' })
    })
  })
})
