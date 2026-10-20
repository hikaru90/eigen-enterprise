import { describe, expect, it } from 'vitest'
import { createAdminTools } from '$lib/kernel/admin-tools'
import {
  InMemoryApprovalStore,
  newApprovalRequest,
  type ApprovalRequest,
  type ApprovalStatus,
} from '$lib/kernel/approvals'
import type { ToolContext } from '$lib/kernel/types'
import {
  approvalContinuationMessage,
  decideApprovalAsOwner,
  findApprovalAsOwner,
} from './owner-decision'

/** A registry stand-in that runs the real kernel admin tools (role check included). */
function adminRegistry() {
  const store = new InMemoryApprovalStore()
  const all = new Map<string, ApprovalRequest>()
  const approvals = {
    create: async (r: ApprovalRequest) => {
      all.set(r.id, r)
      return store.create(r)
    },
    decide: async (id: string, s: 'approved' | 'denied', by: string) => {
      const r = await store.decide(id, s, by)
      all.set(id, r)
      return r
    },
    listPending: () => store.listPending(),
    latestFor: (t: string, p: string) => store.latestFor(t, p),
    list: async (status?: ApprovalStatus) =>
      [...all.values()].filter((r) => status === undefined || r.status === status),
  }
  const tools = createAdminTools({
    modules: { list: () => [], get: () => undefined } as never,
    activations: {} as never,
    approvals,
  })
  const calls: Array<{ name: string; input: unknown; ctx: ToolContext }> = []
  const registry = {
    execute: async (name: string, input: unknown, ctx: ToolContext) => {
      calls.push({ name, input, ctx })
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new Error(`unknown tool ${name}`)
      if (!tool.permission.roles.some((r) => ctx.principal.roles.includes(r))) {
        throw new Error('permission denied')
      }
      return tool.handler(ctx, input)
    },
  }
  return { approvals, registry, calls }
}

describe('owner approval decisions through the kernel', () => {
  it('records the decision via kernel.approvals_decide as the human owner', async () => {
    const { approvals, registry, calls } = adminRegistry()
    const req = await approvals.create(
      newApprovalRequest({ toolName: 'website.publish_page', input: {}, principalId: 'orchestrator' }),
    )
    const out = await decideApprovalAsOwner(registry, { id: 'owner-1' }, req.id, 'approved')
    expect(out).toMatchObject({
      kind: 'decided',
      approval: { id: req.id, status: 'approved', decidedBy: 'owner-1' },
    })
    const decide = calls.find((c) => c.name === 'kernel.approvals_decide')
    expect(decide?.input).toEqual({ approval_id: req.id, decision: 'approved' })
    expect(decide?.ctx.principal).toMatchObject({ id: 'owner-1', kind: 'human' })
  })

  it('reports an unknown id and an already-decided request without deciding again', async () => {
    const { approvals, registry, calls } = adminRegistry()
    expect(await decideApprovalAsOwner(registry, { id: 'o' }, 'nope', 'approved')).toEqual({
      kind: 'not_found',
    })
    const req = await approvals.create(
      newApprovalRequest({ toolName: 'repo.merge', input: {}, principalId: 'a' }),
    )
    await decideApprovalAsOwner(registry, { id: 'o' }, req.id, 'denied')
    const again = await decideApprovalAsOwner(registry, { id: 'o' }, req.id, 'approved')
    expect(again).toMatchObject({ kind: 'already_decided', approval: { status: 'denied' } })
    expect(calls.filter((c) => c.name === 'kernel.approvals_decide')).toHaveLength(1)
    expect(await findApprovalAsOwner(registry, { id: 'o' }, req.id)).toMatchObject({
      status: 'denied',
    })
  })

  it('tells the agent the decision so it re-runs (approved) or drops (denied) the gated step', () => {
    const base = { id: 'apr-1', toolName: 'website.publish_page', input: {}, principalId: 'a' }
    const yes = approvalContinuationMessage({ ...base, status: 'approved' })
    expect(yes).toContain('approved')
    expect(yes).toContain('website.publish_page')
    expect(yes).toContain('apr-1')
    expect(yes).toContain('Run it now')
    const no = approvalContinuationMessage({ ...base, status: 'denied' })
    expect(no).toContain('denied')
    expect(no).toContain('Do not run it')
    expect(() => approvalContinuationMessage({ ...base, status: 'pending' })).toThrow()
  })
})
