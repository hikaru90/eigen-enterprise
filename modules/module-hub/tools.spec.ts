import type { HubFileContent, HubModuleDetail, HubModuleListItem } from './types'
import { describe, expect, it } from 'vitest'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { MODULE_HUB_TOOL_NAMES } from './manifest'
import { publishModule } from './service'
import { bundleOf, moduleHubFixture, publishBody } from './test-fixtures'
import { createModuleHubTools } from './tools'

const agentCtx: ToolContext = { principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] }, requestId: 'r1' }

async function seeded() {
  const f = moduleHubFixture()
  const a = await f.registered()
  const b = bundleOf()
  await publishModule(f.deps, f.publishReq(a, publishBody(b)))
  const summarized: string[] = []
  const tools = Object.fromEntries(
    createModuleHubTools({
      deps: async () => f.deps,
      summarize: async (sha) => {
        summarized.push(sha)
        return { does: 'Greets.', touches: 'Members.', sendsOut: 'Nothing.' }
      },
    }).map((t) => [t.name, t]),
  )
  return { f, a, b, tools, summarized }
}

describe('module_hub.* tools', () => {
  it('match the manifest: reads for admin and agent, summarise for admin only', () => {
    const tools = createModuleHubTools()
    expect(tools.map((t) => t.name)).toEqual([...MODULE_HUB_TOOL_NAMES])
    expect(Object.fromEntries(tools.map((t) => [t.name, [t.auditClass, t.permission.roles]]))).toEqual({
      'module_hub.list': ['read', ['admin', 'agent']],
      'module_hub.get': ['read', ['admin', 'agent']],
      'module_hub.version': ['read', ['admin', 'agent']],
      'module_hub.tree': ['read', ['admin', 'agent']],
      'module_hub.file': ['read', ['admin', 'agent']],
      'module_hub.summarize': ['mutate', ['admin']],
    })
  })

  it('register in a registry (activity on the mutation)', () => {
    const registry = new KernelRegistry()
    for (const t of createModuleHubTools()) registry.register(t)
    expect(registry.list().filter((t) => t.module === 'module-hub')).toHaveLength(MODULE_HUB_TOOL_NAMES.length)
  })

  it('the agent lists, reads a module, its tree and a file', async () => {
    const { a, b, tools } = await seeded()
    const list = (await tools['module_hub.list']!.handler(agentCtx, {})) as { modules: HubModuleListItem[] }
    expect(list.modules.map((m) => m.moduleId)).toEqual(['hello'])
    const got = (await tools['module_hub.get']!.handler(agentCtx, { install_id: a.installId, module_id: 'hello' })) as HubModuleDetail
    expect(got.versions[0]!.bundleSha256).toBe(b.sha256)
    const file = (await tools['module_hub.file']!.handler(agentCtx, { bundle_sha256: b.sha256, path: 'index.mjs' })) as HubFileContent
    expect(file.binary).toBe(false)
    await expect(tools['module_hub.version']!.handler(agentCtx, { bundle_sha256: 'nope' })).rejects.toThrow()
  })

  it('summarise runs the summary for that version and says so in plain words', async () => {
    const { b, tools, summarized } = await seeded()
    const out = await tools['module_hub.summarize']!.handler(agentCtx, { bundle_sha256: b.sha256 })
    expect(out).toEqual({ bundleSha256: b.sha256, summary: { does: 'Greets.', touches: 'Members.', sendsOut: 'Nothing.' } })
    expect(summarized).toEqual([b.sha256])
    expect(tools['module_hub.summarize']!.activity!({ bundle_sha256: b.sha256 }, out)).toBe(`Summarised module bundle ${b.sha256.slice(0, 12)} on the module hub`)
  })
})
