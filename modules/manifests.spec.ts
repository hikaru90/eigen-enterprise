import { describe, expect, it, vi } from 'vitest'

vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))

import { InMemoryApprovalModeStore, InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { MODULE_MERGES } from '$lib/kernel/module-merge'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import type { ToolContext } from '$lib/kernel/types'
import { EeClient } from '$lib/server/ee/client'
import {
  APPROVAL_REQUIRED_TOOLS,
  buildKernel,
  ensureSystemModulesActive,
  moduleManifests,
  SYSTEM_MODULE_IDS,
} from './index'
import { APP_AGENT_GATED_TOOLS } from './website/apps/tools'
import { createSubstrateTools } from './website/hosting/tools'

/** Plan/phase-platform.md step 1: the merged module cut. */

function kernel() {
  const activations = new InMemoryActivationStore()
  const k = buildKernel({
    activations,
    eventSink: new InMemoryEventSink(),
    approvalStore: new InMemoryApprovalStore(),
    approvalMode: new InMemoryApprovalModeStore('ask'),
    vcsCommitter: null,
  })
  return { kernel: k, activations }
}

/** Every tool name that existed before the merge, with its old owning module. */
const PRE_MERGE_TOOLS: Record<string, string[]> = {
  website: ['website.create_page', 'website.update_page', 'website.publish_page', 'website.get_page', 'website.list_pages', 'website.site_info'],
  substrate: ['substrate.status', 'substrate.domain_add', 'substrate.domain_remove', 'substrate.app_remove', 'substrate.secret_set'],
  github: ['github.status', 'github.repos_list', 'github.app_create', 'github.app_deploy', 'github.auto_deploy'],
  email: ['email.send_mail'],
  owlery: ['owlery.status', 'owlery.send_mail'],
  repo: ['repo.worktree_create', 'repo.run', 'repo.write_file', 'repo.read_file', 'repo.merge'],
  'dev-agent': ['dev-agent.dispatch', 'dev-agent.status', 'dev-agent.logs', 'dev-agent.merge', 'dev-agent.abort'],
  roadmap: ['roadmap.list_items', 'roadmap.add_item', 'roadmap.update_item'],
}

describe('merged module manifests', () => {
  it('owner-facing modules carry a plain name and a one-line description', () => {
    const byId = new Map(moduleManifests.map((m) => [m.id, m]))
    expect(byId.get('website')).toMatchObject({
      name: 'Website',
      description: 'Your apps, services and site: link GitHub repos, deploy, domains, logs.',
    })
    expect(byId.get('email')?.name).toBe('Email')
    for (const m of moduleManifests) {
      expect(m.description).toBeDefined()
      expect(m.description).not.toContain('\n')
    }
  })

  it('the orchestrator module is internal (no owner-facing card); the others are not', () => {
    expect(moduleManifests.filter((m) => m.internal === true).map((m) => m.id)).toEqual(['orchestrator'])
  })

  it('no retired module id remains a module', () => {
    const ids = moduleManifests.map((m) => m.id)
    for (const retired of ['substrate', 'github', 'owlery', 'repo', 'dev-agent', 'roadmap']) {
      expect(ids).not.toContain(retired)
    }
  })

  it('every pre-merge tool name still exists, owned by the module it was merged into', () => {
    const { kernel: k } = kernel()
    const mergedInto = new Map<string, string>()
    for (const [target, parts] of Object.entries(MODULE_MERGES)) {
      for (const part of parts) mergedInto.set(part, target)
    }
    for (const [oldModule, names] of Object.entries(PRE_MERGE_TOOLS)) {
      for (const name of names) {
        expect(k.registry.get(name)?.module, name).toBe(mergedInto.get(oldModule))
      }
    }
  })

  it('every approval-gated tool is registered (no stale name in APPROVAL_REQUIRED_TOOLS)', async () => {
    const { kernel: k } = kernel()
    const { registerAdminTools } = await import('$lib/kernel/admin-bootstrap')
    await registerAdminTools(k)
    for (const name of APPROVAL_REQUIRED_TOOLS) expect(k.registry.get(name), name).toBeDefined()
  })

  it('system modules are website and email, and boot activates them', async () => {
    expect([...SYSTEM_MODULE_IDS]).toEqual(['website', 'email'])
    const { kernel: k, activations } = kernel()
    await ensureSystemModulesActive(k)
    expect(await activations.get('website')).toBe(true)
    expect(await activations.get('email')).toBe(true)
    expect(await k.modules.isToolActive('substrate.status')).toBe(true)
    expect(await k.modules.isToolActive('github.status')).toBe(true)
    expect(await k.modules.isToolActive('owlery.status')).toBe(true)
    // Not a system module: the agent's internal tools keep their own activation.
    expect(await k.modules.isToolActive('repo.merge')).toBe(false)
  })
})

describe('D11: agent deploys go through approval, never around it', () => {
  it('every agent-callable app tool that changes the server is approval-gated', () => {
    for (const name of APP_AGENT_GATED_TOOLS) expect(APPROVAL_REQUIRED_TOOLS.has(name)).toBe(true)
  })
})

describe('D11 stays exactly as strict after the merge', () => {
  const agent: ToolContext = {
    principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] },
    requestId: 'd11',
  }

  it.each(['substrate.domain_add', 'substrate.domain_remove', 'substrate.app_remove', 'substrate.secret_set'])(
    '%s through the full kernel pipeline refuses an agent even with the website module active',
    async (name) => {
      const calls: string[] = []
      const client = new EeClient(async (method, path) => {
        calls.push(`${method} ${path}`)
        return { status: 200, data: {} }
      })
      const { kernel: k, activations } = kernel()
      await activations.set('website', true)
      // Swap in the hosting descriptors with a recording ee client (same descriptors, injected transport).
      const recording = new Map(createSubstrateTools({ client }).map((t) => [t.name, t]))
      const descriptor = k.registry.get(name)!
      expect(descriptor.module).toBe('website')
      const input =
        name === 'substrate.secret_set'
          ? { workload: 'x1', name: 'API_KEY', value: 'v' }
          : { host: 'a.example.com', role: 'app', workload: 'x1', name: 'x1' }
      await expect(recording.get(name)!.handler(agent, input)).rejects.toMatchObject({ code: 'permission_denied' })
      await expect(k.registry.execute(name, input, agent)).rejects.toMatchObject({ code: 'permission_denied' })
      expect(calls).toEqual([])
    },
  )
})
