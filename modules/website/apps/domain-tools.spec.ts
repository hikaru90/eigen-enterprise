import type { NewService } from './store'
import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { EeStatus } from '$lib/server/ee/client'
import { createDomainTools, type DomainEe } from './domain-tools'
import { InMemoryServiceStore } from './store'
import { FakeEe } from './testing'

/**
 * D-W2 (plan/phase-website-apps-ux.md): domain assignment is per app. The
 * human-only tools own the host ↔ app mapping, refuse hosts owned by another
 * workload (console, company site, other apps — all `os` or another app in
 * ee's routes) and keep website_services.host in sync.
 */

const human: ToolContext = {
  principal: { id: 'u1', kind: 'human', roles: ['admin'] },
  requestId: 'r',
}
const agent: ToolContext = {
  principal: { id: 'agent-1', kind: 'agent', roles: ['admin', 'agent'] },
  requestId: 'r',
}

/** FakeEe plus the one verb the domain tools need that apps' seam leaves out. */
class DomainFakeEe extends FakeEe implements DomainEe {
  removed: Array<{ host: string; author: string }> = []
  publicHost: string | null = null
  override async status(): Promise<EeStatus> {
    const s = await super.status()
    return { ...s, settings: { ...s.settings, publicHost: this.publicHost } }
  }
  async removeDomain(i: { host: string; author: string }) {
    this.calls.push({ verb: 'removeDomain', input: i })
    this.removed.push(i)
    this.routes = this.routes.filter((r) => r.host !== i.host)
    return { rev: 's4', reconcileError: null }
  }
}

const shop: NewService = {
  name: 'shop',
  kind: 'web',
  repoFullName: 'kindred/shop',
  branch: 'main',
  repoId: null,
  authKind: 'public',
  host: 'shop.ee.localhost',
  autoDeploy: false,
  createdBy: 'human:u1',
}

async function setup(services: NewService[] = [shop], extraRoutes: EeStatus['routes'] = []) {
  const ee = new DomainFakeEe()
  ee.routes = [
    { host: 'os.ee.localhost', workload: 'os' },
    { host: 'shop.ee.localhost', workload: 'shop' },
    ...extraRoutes,
  ]
  const store = new InMemoryServiceStore()
  for (const s of services) await store.upsert(s)
  const tools = createDomainTools({ ee, services: store })
  const tool = (name: string) => tools.find((t) => t.name === name) as ToolDescriptor
  const run = (name: string, input: unknown, ctx = human) => tool(name).handler(ctx, input)
  return { ee, store, run }
}

describe('website.app_domain_set', () => {
  it('adds a host to the app (role app, human author) and returns the domains from status', async () => {
    const { ee, store, run } = await setup()
    const out = (await run('website.app_domain_set', {
      name: 'shop',
      host: 'shop.kindred.dev',
    })) as { host: string; domains: string[] }
    expect(out).toEqual({
      host: 'shop.kindred.dev',
      domains: ['shop.ee.localhost', 'shop.kindred.dev'],
    })
    expect(ee.calls).toContainEqual({
      verb: 'addDomain',
      input: { host: 'shop.kindred.dev', workload: 'shop', role: 'app', author: 'human:u1' },
    })
    // A first address stays the service's own (nothing was replaced).
    expect((await store.get('shop'))?.host).toBe('shop.ee.localhost')
  })

  it('replace: removes the app-owned old host, adds the new one, and moves website_services.host', async () => {
    const { ee, store, run } = await setup()
    const out = (await run('website.app_domain_set', {
      name: 'shop',
      host: 'shop.kindred.dev',
      replace: 'shop.ee.localhost',
    })) as { host: string; domains: string[] }
    expect(out).toEqual({ host: 'shop.kindred.dev', domains: ['shop.kindred.dev'] })
    expect(ee.removed).toEqual([{ host: 'shop.ee.localhost', author: 'human:u1' }])
    expect(ee.calls.filter((c) => c.verb === 'addDomain')).toHaveLength(1)
    expect((await store.get('shop'))?.host).toBe('shop.kindred.dev')
  })

  it('refuses a host that serves the console', async () => {
    const { ee, run } = await setup()
    await expect(
      run('website.app_domain_set', { name: 'shop', host: 'os.ee.localhost' }),
    ).rejects.toThrow(/os\.ee\.localhost.*console/)
    expect(ee.calls).toEqual([])
  })

  it('refuses a host that serves the company site', async () => {
    const { ee, run } = await setup([shop], [{ host: 'www.kindred.dev', workload: 'os' }])
    ee.publicHost = 'www.kindred.dev'
    await expect(
      run('website.app_domain_set', { name: 'shop', host: 'www.kindred.dev' }),
    ).rejects.toThrow(/www\.kindred\.dev.*company site/)
    expect(ee.calls).toEqual([])
  })

  it('refuses a host another app already serves, naming it', async () => {
    const { ee, run } = await setup([shop], [{ host: 'api.kindred.dev', workload: 'blog' }])
    await expect(
      run('website.app_domain_set', { name: 'shop', host: 'api.kindred.dev' }),
    ).rejects.toThrow(/api\.kindred\.dev.*blog/)
    expect(ee.calls).toEqual([])
  })

  it('an `os` route that is neither console nor public host is refused too', async () => {
    const { ee, run } = await setup([shop], [{ host: 'internal.kindred.dev', workload: 'os' }])
    await expect(
      run('website.app_domain_set', { name: 'shop', host: 'internal.kindred.dev' }),
    ).rejects.toThrow(/internal\.kindred\.dev/)
    expect(ee.calls).toEqual([])
  })

  it('refuses to replace a host the app does not own', async () => {
    const { ee, run } = await setup([shop], [{ host: 'api.kindred.dev', workload: 'blog' }])
    await expect(
      run('website.app_domain_set', {
        name: 'shop',
        host: 'shop.kindred.dev',
        replace: 'api.kindred.dev',
      }),
    ).rejects.toThrow(/api\.kindred\.dev.*not.*address of shop/)
    expect(ee.calls).toEqual([])
  })

  it('refuses to replace a host that has no route at all', async () => {
    const { ee, run } = await setup()
    await expect(
      run('website.app_domain_set', {
        name: 'shop',
        host: 'shop.kindred.dev',
        replace: 'ghost.kindred.dev',
      }),
    ).rejects.toThrow(/ghost\.kindred\.dev/)
    expect(ee.calls).toEqual([])
  })

  it("re-pointing one of the app's own hosts at it again is allowed (ee moves it)", async () => {
    const { ee, run } = await setup()
    const out = (await run('website.app_domain_set', {
      name: 'shop',
      host: 'shop.ee.localhost',
    })) as { host: string; domains: string[] }
    expect(out.domains).toContain('shop.ee.localhost')
    expect(ee.calls.some((c) => c.verb === 'addDomain')).toBe(true)
  })

  it('there is no app with that name', async () => {
    const { run } = await setup()
    await expect(
      run('website.app_domain_set', { name: 'ghost', host: 'ghost.kindred.dev' }),
    ).rejects.toThrow('There is no app called ghost.')
  })

  it('an agent principal is denied (D11: human only)', async () => {
    const { ee, run } = await setup()
    await expect(
      run('website.app_domain_set', { name: 'shop', host: 'shop.kindred.dev' }, agent),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    expect(ee.calls).toEqual([])
  })
})

describe('website.app_domain_remove', () => {
  it("removes one of the app's hosts; website_services.host moves to a remaining one", async () => {
    const { ee, store, run } = await setup()
    ee.routes = [...ee.routes, { host: 'shop.kindred.dev', workload: 'shop' }]
    await store.upsert({ ...shop, host: 'shop.kindred.dev' })
    const out = (await run('website.app_domain_remove', {
      name: 'shop',
      host: 'shop.kindred.dev',
    })) as { host: string; domains: string[] }
    expect(out).toEqual({ host: 'shop.kindred.dev', domains: ['shop.ee.localhost'] })
    expect(ee.removed).toEqual([{ host: 'shop.kindred.dev', author: 'human:u1' }])
    expect((await store.get('shop'))?.host).toBe('shop.ee.localhost')
  })

  it('keeps website_services.host when another address was removed', async () => {
    const { ee, store, run } = await setup()
    ee.routes = [...ee.routes, { host: 'shop.kindred.dev', workload: 'shop' }]
    const out = (await run('website.app_domain_remove', {
      name: 'shop',
      host: 'shop.kindred.dev',
    })) as { host: string; domains: string[] }
    expect(out.domains).toEqual(['shop.ee.localhost'])
    expect((await store.get('shop'))?.host).toBe('shop.ee.localhost')
  })

  it('refuses to remove the last address of a web app', async () => {
    const { ee, store, run } = await setup()
    await expect(
      run('website.app_domain_remove', { name: 'shop', host: 'shop.ee.localhost' }),
    ).rejects.toThrow('A web app needs one address; change it instead of removing it')
    expect(ee.calls).toEqual([])
    expect((await store.get('shop'))?.host).toBe('shop.ee.localhost')
  })

  it('a back-end service may lose its only route (the web rule does not apply)', async () => {
    const worker: NewService = {
      ...shop,
      name: 'worker',
      kind: 'backend',
      host: null,
    }
    const { ee, store, run } = await setup([worker], [])
    ee.routes = [
      { host: 'os.ee.localhost', workload: 'os' },
      { host: 'worker.kindred.dev', workload: 'worker' },
    ]
    const out = (await run('website.app_domain_remove', {
      name: 'worker',
      host: 'worker.kindred.dev',
    })) as { host: string; domains: string[] }
    expect(out.domains).toEqual([])
    expect(ee.removed).toHaveLength(1)
    expect((await store.get('worker'))?.host).toBeNull()
  })

  it("refuses a host that is not this app's", async () => {
    const { ee, run } = await setup([shop], [{ host: 'api.kindred.dev', workload: 'blog' }])
    await expect(
      run('website.app_domain_remove', { name: 'shop', host: 'api.kindred.dev' }),
    ).rejects.toThrow(/api\.kindred\.dev/)
    await expect(
      run('website.app_domain_remove', { name: 'shop', host: 'ghost.kindred.dev' }),
    ).rejects.toThrow(/ghost\.kindred\.dev/)
    expect(ee.calls).toEqual([])
  })

  it('an agent principal is denied (D11: human only)', async () => {
    const { ee, run } = await setup()
    await expect(
      run('website.app_domain_remove', { name: 'shop', host: 'shop.ee.localhost' }, agent),
    ).rejects.toBeInstanceOf(KernelError)
    expect(ee.calls).toEqual([])
  })
})
