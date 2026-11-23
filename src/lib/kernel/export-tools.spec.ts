import type { ToolContext } from './types'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from './approvals'
import { InMemoryEventSink } from './events'
import { createExportTools, KERNEL_EXPORT_TOOL_NAMES, type CompanyExportView, type ExportPort } from './export-tools'
import { delegatedPrincipal } from './principals'
import { KernelRegistry } from './registry'

const owner: ToolContext = { principal: delegatedPrincipal({ id: 'u-owner', roles: ['admin', 'member'] }, 'orchestrator'), requestId: 'r1' }
const admin: ToolContext = { principal: { id: 'u-admin', kind: 'human', roles: ['admin', 'member'] }, requestId: 'r2' }
const bareAgent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }, requestId: 'r3' }

const ID = '7c0b8f5e-3f1a-4b8e-9a51-0d6c1c2b3a4f'

function view(over: Partial<CompanyExportView> = {}): CompanyExportView {
  return {
    id: ID,
    status: 'pending',
    requestedBy: 'u-owner',
    createdAt: '2026-11-23T12:00:00.000Z',
    finishedAt: null,
    expiresAt: null,
    bytes: null,
    summary: null,
    error: null,
    downloadPath: null,
    ...over,
  }
}

function setup() {
  const calls: unknown[] = []
  const port: ExportPort = {
    isOwner: async (id) => id === 'u-owner',
    start: async (userId) => {
      calls.push(['start', userId])
      return view()
    },
    get: async (id) => (id === ID ? view({ status: 'done', downloadPath: `/api/exports/${ID}/download` }) : null),
    list: async () => [view()],
    remove: async (id) => {
      calls.push(['remove', id])
      return id === ID ? view({ status: 'deleted' }) : null
    },
  }
  const approvals = new InMemoryApprovalStore()
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(), new InMemoryApprovalModeStore('allow_all')),
    approvalStore: approvals,
  })
  for (const tool of createExportTools({ port })) registry.register(tool)
  const approved = async (name: string, input: unknown, ctx: ToolContext) => {
    const gated = await registry.execute(name, input, ctx).catch((e) => e)
    expect(gated).toMatchObject({ code: 'approval_required' })
    await approvals.decide(gated.details.approvalId, 'approved', 'u-owner')
    return registry.execute(name, input, ctx)
  }
  return { registry, calls, approved }
}

describe('company export tools', () => {
  it('starting an export always waits for the owner’s approval, even in allow-all mode', async () => {
    const { registry, calls, approved } = setup()
    expect(registry.get('kernel.export_company')).toMatchObject({ approvalAlways: true, approvalRisk: 'external' })
    expect(await approved('kernel.export_company', {}, owner)).toEqual(view())
    expect(calls).toEqual([['start', 'u-owner']])
  })

  it('only the owner: an admin is refused, a bare agent is no person', async () => {
    const { registry } = setup()
    await expect(registry.execute('kernel.export_list', {}, admin)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(registry.execute('kernel.export_list', {}, bareAgent)).rejects.toMatchObject({ code: 'no_person' })
  })

  it('status shows the download once done; an unknown export is not found', async () => {
    const { registry } = setup()
    expect(await registry.execute('kernel.export_status', { id: ID }, owner)).toMatchObject({
      status: 'done',
      downloadPath: `/api/exports/${ID}/download`,
    })
    await expect(
      registry.execute('kernel.export_status', { id: '00000000-0000-4000-8000-000000000000' }, owner),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('lists and deletes', async () => {
    const { registry, calls } = setup()
    expect(await registry.execute('kernel.export_list', {}, owner)).toEqual({ exports: [view()] })
    expect(await registry.execute('kernel.export_delete', { id: ID }, owner)).toMatchObject({ status: 'deleted' })
    expect(calls).toEqual([['remove', ID]])
  })

  it('names every tool it registers', () => {
    expect(createExportTools({ port: {} as ExportPort }).map((t) => t.name)).toEqual([...KERNEL_EXPORT_TOOL_NAMES])
  })
})
