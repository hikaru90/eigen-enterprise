import { describe, expect, it } from 'vitest'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from '$lib/kernel/approvals'
import { coworkerPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { memoryCoworkerStore } from '$lib/server/coworkers/memory-store'
import type { CoworkerActor, OrgMember } from '$lib/server/coworkers/service'
import { COWORKERS_GATED_TOOLS, COWORKERS_TOOL_NAMES, coworkersManifest } from './manifest'
import { createCoworkersTools } from './tools'

const at = new Date('2026-11-23T09:00:00Z')
const person = (id: string, role: OrgMember['role'], minutesBefore: number): OrgMember => ({
  id,
  name: id,
  email: `${id}@k.co`,
  role,
  kind: 'human',
  createdAt: new Date(at.getTime() - minutesBefore * 60_000),
})

const roleOf: Record<string, OrgMember['role']> = { olga: 'owner', ari: 'admin', mo: 'member' }

function setup(mode: 'ask' | 'reasonable' | 'allow_all' = 'allow_all') {
  const store = memoryCoworkerStore([person('olga', 'owner', 3), person('ari', 'admin', 2), person('mo', 'member', 1)])
  let n = 0
  const deps = { store, now: () => at, newId: () => `cw${String(++n).padStart(6, '0')}abcdef` }
  const tools = createCoworkersTools({
    deps: async () => deps,
    actor: async (ctx): Promise<CoworkerActor> => {
      const p = ctx.principal
      if (p.kind === 'coworker') return { id: p.id, role: 'member', kind: 'coworker' }
      if (p.kind === 'human') return { id: p.id, role: roleOf[p.id] ?? null, kind: 'person' }
      return { id: p.id, role: 'admin', kind: 'agent' }
    },
  })
  const approvals = new InMemoryApprovalStore()
  const registry = new KernelRegistry({
    approvalStore: approvals,
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(COWORKERS_GATED_TOOLS), new InMemoryApprovalModeStore(mode)),
  })
  for (const t of tools) registry.register(t)
  const as = (id: string, roles: string[]): ToolContext => ({ principal: { id, kind: 'human', roles }, requestId: `r-${id}` })
  const ownerCtx = as('olga', ['admin', 'member'])
  const memberCtx = as('mo', ['member'])
  const tool = (name: string) => tools.find((t) => t.name === name)!
  /** Runs an always-ask tool: the call waits, a person approves, the same call runs. */
  const approved = async (name: string, input: unknown, ctx: ToolContext) => {
    await expect(registry.execute(name, input, ctx)).rejects.toMatchObject({ code: 'approval_required' })
    const pending = (await approvals.listPending()).find((r) => r.toolName === name)
    await approvals.decide(pending!.id, 'approved', 'olga')
    return registry.execute(name, input, ctx)
  }
  return { store, registry, tool, ownerCtx, memberCtx, approved, approvals }
}

describe('coworkers module', () => {
  it('owns exactly its tools, in the coworkers and org namespaces', () => {
    const { tool } = setup()
    expect(coworkersManifest.toolNamespaces).toEqual(['coworkers', 'org'])
    expect(createCoworkersTools().map((t) => t.name)).toEqual([...COWORKERS_TOOL_NAMES])
    for (const name of COWORKERS_TOOL_NAMES) expect(tool(name).module).toBe('coworkers')
  })

  it('reads are for every member; writes for admins and the agent; create and remove always ask', () => {
    const { tool } = setup()
    for (const name of ['coworkers.templates', 'coworkers.list', 'coworkers.get', 'org.chart']) {
      expect(tool(name)).toMatchObject({ auditClass: 'read', permission: { roles: ['admin', 'member', 'agent'] } })
    }
    for (const name of ['coworkers.create', 'coworkers.update', 'coworkers.enable', 'coworkers.disable', 'coworkers.remove']) {
      expect(tool(name)).toMatchObject({ auditClass: 'mutate', permission: { roles: ['admin', 'agent'] } })
    }
    expect(tool('coworkers.create')).toMatchObject({ approvalAlways: true, approvalRisk: 'internal' })
    expect(tool('coworkers.remove')).toMatchObject({ approvalAlways: true, approvalRisk: 'destructive' })
    for (const name of COWORKERS_GATED_TOOLS) expect(tool(name).approvalRisk).toBe('internal')
    expect(tool('org.set_position').permission.roles).toEqual(['admin', 'member', 'agent'])
  })

  it('templates lists the catalog', async () => {
    const { registry, memberCtx } = setup()
    const out = (await registry.execute('coworkers.templates', {}, memberCtx)) as { templates: Array<{ id: string }> }
    expect(out.templates.map((t) => t.id)).toEqual([
      'marketing-manager',
      'go-to-market-manager',
      'designer',
      'ops-analyst',
      'finance-analyst',
      'customer-success-lead',
    ])
  })

  it('create waits for a yes even in allow_all, then makes the co-worker; the activity names it', async () => {
    const { registry, ownerCtx, approved, tool } = setup('allow_all')
    const cw = (await approved('coworkers.create', { template_id: 'marketing-manager', name: 'Mara' }, ownerCtx)) as { id: string; name: string }
    expect(cw.name).toBe('Mara')
    expect(tool('coworkers.create').activity!({ template_id: 'marketing-manager' }, cw)).toBe('Created the AI co-worker Mara')
    const list = (await registry.execute('coworkers.list', {}, ownerCtx)) as { coworkers: Array<{ id: string; kind?: string }> }
    expect(list.coworkers.map((c) => c.id)).toEqual([cw.id])
  })

  it('create refuses a model outside the chat pool, before anyone is asked', async () => {
    const { registry, ownerCtx, approved } = setup()
    await expect(approved('coworkers.create', { template_id: 'designer', model_id: 'openai/gpt-made-up' }, ownerCtx)).rejects.toMatchObject({
      code: 'invalid_model',
    })
    await expect(registry.execute('coworkers.create', { template_id: 'nope' }, ownerCtx)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a member reads the chart but cannot create; a co-worker reads but writes nothing', async () => {
    const { registry, ownerCtx, memberCtx, approved } = setup()
    await expect(registry.execute('coworkers.create', { template_id: 'designer' }, memberCtx)).rejects.toMatchObject({ code: 'permission_denied' })
    const cw = (await approved('coworkers.create', { template_id: 'designer' }, ownerCtx)) as { id: string }
    const self = { principal: coworkerPrincipal(cw.id, `coworker-${cw.id}`), requestId: 'r-cw' }
    const chart = (await registry.execute('org.chart', {}, self)) as { people: Array<{ id: string; kind: string }> }
    expect(chart.people.map((p) => `${p.id}:${p.kind}`)).toEqual(['olga:human', 'ari:human', 'mo:human', `${cw.id}:coworker`])
    await expect(registry.execute('coworkers.disable', { user_id: cw.id }, self)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(registry.execute('org.set_position', { user_id: cw.id, title: 'CEO' }, self)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('org.set_position: a member edits their own seat; cycles are refused', async () => {
    const { registry, ownerCtx, memberCtx } = setup()
    await expect(registry.execute('org.set_position', { user_id: 'mo', title: 'Engineer', accountabilities: ['Ship'] }, memberCtx)).resolves.toMatchObject({
      title: 'Engineer',
    })
    await expect(registry.execute('org.set_position', { user_id: 'mo', reports_to_user_id: 'olga' }, memberCtx)).rejects.toMatchObject({ code: 'forbidden' })
    await registry.execute('org.set_position', { user_id: 'mo', reports_to_user_id: 'ari' }, ownerCtx)
    await expect(registry.execute('org.set_position', { user_id: 'ari', reports_to_user_id: 'mo' }, ownerCtx)).rejects.toMatchObject({ code: 'org_cycle' })
  })

  it('update, disable, enable wait on the approval mode (ask), and remove always asks', async () => {
    const { registry, ownerCtx, approved } = setup('ask')
    const cw = (await approved('coworkers.create', { template_id: 'ops-analyst' }, ownerCtx)) as { id: string }
    await expect(registry.execute('coworkers.disable', { user_id: cw.id }, ownerCtx)).rejects.toMatchObject({ code: 'approval_required' })
    const removed = (await approved('coworkers.remove', { user_id: cw.id }, ownerCtx)) as { removedAt: string | null; enabled: boolean }
    expect(removed).toMatchObject({ removedAt: at.toISOString(), enabled: false })
  })
})
