import { describe, expect, it, vi } from 'vitest'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
} from '$lib/kernel/approvals'
import { KernelRegistry } from '$lib/kernel/registry'
import { EeClient } from '$lib/server/ee/client'
import { cachedResolver, type DnsResolver } from '../../../../../../../modules/domains/dns'
import { createDomainsTools } from '../../../../../../../modules/domains/tools'
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

const BOX = '203.0.113.7'
const none = () => Promise.reject(Object.assign(new Error('nodata'), { code: 'ENODATA' }))
/** DNS: every host points at the box. */
const dns: DnsResolver = {
  resolve4: async () => [BOX],
  resolve6: none,
  resolveCname: none,
  resolveTxt: none,
  resolveMx: none,
}

/** FakeEe plus the removeDomain verb the per-app domain tools use, and the box's public address. */
class FakeEeWithDomains extends FakeEe implements DomainEe {
  override async status() {
    const s = await super.status()
    return { ...s, settings: { ...s.settings, rtcNodeIp: BOX } as typeof s.settings }
  }
  async retryCertificate(host: string) {
    return { host, reloaded: true as const }
  }
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
  const mailKeys = {
    minted: [] as string[],
    revoked: [] as string[],
    async mint(i: { userId: string; name: string }) {
      mailKeys.minted.push(i.name)
      return { id: `key-${mailKeys.minted.length}`, raw: 'eigen_RAW_SECRET' }
    },
    async revoke(id: string) {
      mailKeys.revoked.push(id)
    },
  }
  for (const t of [
    ...createAppTools({ ee, repos, services, mintToken: async () => 'x', mailKeys }),
    ...createDomainTools({ ee, services }),
    ...createSubstrateTools({ client }),
    ...createDomainsTools({
      ee,
      mail: async () => [],
      bought: async () => [],
      resolver: cachedResolver(dns, 60_000, () => 0),
    }),
  ])
    registry.register(t)
  holder.registry = registry
  holder.approvals = approvals
  return { ee, eeHttp, services, mailKeys }
}

const user = { id: 'u1' }
const event = (extra: Record<string, unknown> = {}) =>
  ({ locals: { user }, params: {}, url: new URL('https://console.test/'), ...extra }) as never

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

  it('shows its addresses with their status; changing them is Settings › Domains’ job', async () => {
    await setup()
    const data = (await load(event({ params: { name: 'shop' } }))) as Record<string, unknown>
    expect(data).toMatchObject({
      addresses: [{ host: 'shop.ee.localhost', label: 'Live', on: true }],
      addressesError: null,
    })
    expect(Object.keys(actions)).not.toContain('domainSet')
    expect(Object.keys(actions)).not.toContain('domainRemove')
  })

  it('an unknown app is a plain 404', async () => {
    await setup()
    await expect(load(event({ params: { name: 'ghost' } }))).rejects.toMatchObject({ status: 404 })
  })

  it('the saved build settings survive ee losing the workload: the form comes prefilled', async () => {
    const { ee, services } = await setup()
    const row = (await services.get('shop'))!
    services.rows.set('shop', {
      ...row,
      state: 'healthy',
      contract: {
        runtime: 'node',
        nodeVersion: '22',
        install: 'npm install --omit=dev',
        start: 'node index.js',
        health: '/',
      },
    })
    ee.workloads = []
    const data = (await load(event({ params: { name: 'shop' } }))) as {
      app: { contractSource: string }
      contractFields: { runtime: string; install: string; start: string } | null
    }
    expect(data.app.contractSource).toBe('form')
    expect(data.contractFields).toMatchObject({
      runtime: 'node@22',
      install: 'npm install --omit=dev',
      start: 'node index.js',
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

    it('EE_API_KEY cannot be set by hand: the email switch owns it', async () => {
      const { eeHttp } = await setup()
      const out = (await actions.secretSet(
        event({
          params: { name: 'shop' },
          request: formRequest({ name: 'EE_API_KEY', value: 'eigen_whatever' }),
        }),
      )) as { status: number; data: { error: string } }
      expect(out.status).toBe(400)
      expect(out.data.error).toContain('Allow this app to send email')
      expect(eeHttp).not.toContain('POST /v1/secrets')
    })

    it('a bad variable name is a plain sentence naming the field, not a raw zod error', async () => {
      await setup()
      const out = (await actions.secretSet(
        event({
          params: { name: 'shop' },
          request: formRequest({ name: 'stripe_key', value: 'v' }),
        }),
      )) as { status: number; data: { action: string; error: string } }
      expect(out.status).toBe(400)
      expect(out.data.error).toBe('Check the variable name: CAPITALS, digits and _, like API_KEY.')
    })
  })

  describe('mailEnable / mailDisable ("Allow this app to send email")', () => {
    it('load tells whether email is on and where the how-to lives', async () => {
      await setup()
      const data = (await load(event({ params: { name: 'shop' } }))) as {
        app: { mail: { enabled: boolean } }
        howtoUrl: string
      }
      expect(data.app.mail).toEqual({ enabled: false })
      expect(data.howtoUrl).toBe('https://console.test/docs/send-mail.md')
    })

    it('turning it on mints a mail-only key for the app, seals it through ee, and says so without the key', async () => {
      const { eeHttp, services, mailKeys } = await setup()
      const out = (await actions.mailEnable(
        event({ params: { name: 'shop' }, request: formRequest({}) }),
      )) as { action: string; ok: boolean; message: string }
      expect(out).toMatchObject({ action: 'mailEnable', ok: true })
      expect(out.message).toContain('Email is on')
      expect(mailKeys.minted).toEqual(['app:shop'])
      expect((await services.get('shop'))!.mailKeyId).toBe('key-1')
      expect(JSON.stringify(out)).not.toContain('eigen_RAW')
      // The page's own ee client is not the path: the app tools' ee (the fake) sealed it.
      expect(eeHttp).not.toContain('POST /v1/secrets')
      const data = (await load(event({ params: { name: 'shop' } }))) as {
        app: { mail: { enabled: boolean } }
      }
      expect(data.app.mail).toEqual({ enabled: true })
    })

    it('turning it off revokes the key at once', async () => {
      const { services, mailKeys } = await setup()
      await actions.mailEnable(event({ params: { name: 'shop' }, request: formRequest({}) }))
      const out = (await actions.mailDisable(
        event({ params: { name: 'shop' }, request: formRequest({}) }),
      )) as { action: string; ok: boolean; message: string }
      expect(out).toMatchObject({ action: 'mailDisable', ok: true })
      expect(out.message).toContain('revoked')
      expect(mailKeys.revoked).toEqual(['key-1'])
      expect((await services.get('shop'))!.mailKeyId).toBeNull()
    })
  })

  describe('remove', () => {
    it('removes the app and redirects to the overview', async () => {
      await setup()
      await expect(
        actions.remove(event({ params: { name: 'shop' }, request: formRequest({}) })),
      ).rejects.toMatchObject({ status: 303, location: '/m/website' })
    })
  })
})
