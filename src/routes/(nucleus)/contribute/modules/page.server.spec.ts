import { describe, expect, it, vi } from 'vitest'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'

const { holder, roleMock } = vi.hoisted(() => ({
  holder: { registry: null as unknown },
  roleMock: vi.fn(async (): Promise<string | null> => 'admin'),
}))

vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: roleMock,
  kernelRolesFor: (role: string) => (role === 'owner' || role === 'admin' ? ['admin', 'member'] : ['member']),
}))
vi.mock('$lib/server/boot', () => ({ appKernel: async () => ({ registry: holder.registry }) }))

import { testInstall } from '../../../../../modules/contribute/hub/test-fixtures'
import { publishModule } from '../../../../../modules/module-hub/service'
import { bundleOf, moduleHubFixture, publishBody } from '../../../../../modules/module-hub/test-fixtures'
import { createModuleHubTools } from '../../../../../modules/module-hub/tools'
import { actions, load } from './+page.server'

async function wired(active = true) {
  const f = moduleHubFixture()
  const a = await f.registered(testInstall())
  const b = bundleOf()
  await publishModule(f.deps, f.publishReq(a, publishBody(b)))
  const activations = new InMemoryActivationStore()
  await activations.set('module-hub', active)
  const registry = new KernelRegistry({ activationStore: activations })
  const summarized: string[] = []
  for (const t of createModuleHubTools({
    deps: async () => f.deps,
    summarize: async (sha) => {
      summarized.push(sha)
      return { does: 'Greets.', touches: 'Members.', sendsOut: 'Nothing.' }
    },
  }))
    registry.register(t)
  holder.registry = registry
  return { f, a, b, summarized }
}

const ev = (search: string) => ({ locals: { user: { id: 'u1' } }, url: new URL(`https://hub.test/contribute/modules${search}`) }) as never

describe('/contribute/modules (a client of the module_hub.* tools)', () => {
  it('lists the modules, opens one with its versions, code and a file', async () => {
    const { a, b } = await wired()
    const data = (await load(ev(`?install=${a.installId}&module=hello&path=module.yaml`))) as Record<string, unknown>
    expect((data.list as { modules: { moduleId: string }[] }).modules.map((m) => m.moduleId)).toEqual(['hello'])
    expect(data.detail).toMatchObject({ module: { moduleId: 'hello' } })
    expect(data.version).toMatchObject({ bundleSha256: b.sha256 })
    expect((data.files as { path: string }[]).map((x) => x.path)).toContain('index.mjs')
    expect(data.file).toMatchObject({ path: 'module.yaml', binary: false })
    expect(data.canSummarize).toBe(true)
  })

  it('is 404 while the module hub is off, 403 for a member', async () => {
    await wired(false)
    await expect(load(ev(''))).rejects.toMatchObject({ status: 404 })
    await wired()
    roleMock.mockResolvedValueOnce('member')
    await expect(load(ev(''))).rejects.toMatchObject({ status: 403 })
  })

  it('summarise runs module_hub.summarize', async () => {
    const { b, summarized } = await wired()
    const form = new FormData()
    form.set('bundle_sha256', b.sha256)
    const out = await actions.summarize({ locals: { user: { id: 'u1' } }, request: new Request('https://hub.test', { method: 'POST', body: form }) } as never)
    expect(out).toEqual({ summarized: b.sha256 })
    expect(summarized).toEqual([b.sha256])
  })
})
