import type { WiredKernel } from '../../../modules/index'
import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from './approvals'
import type { PrincipalStore } from './principals'
import type { ToolContext } from './types'
import { describe, expect, it } from 'vitest'
import { registerAdminTools, listableApprovalStore } from './admin-bootstrap'
import { InMemoryApprovalStore } from './approvals'
import { InMemoryEventSink } from './events'
import { InMemoryActivationStore, ModuleRegistry, type ModuleManifest } from './modules'
import { KernelRegistry } from './registry'
import { InMemoryAgentSessionLog } from './session-log'

function makeManifest(id: string): ModuleManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    tools: [],
    permissions: { roles: ['admin'] },
  }
}

function makeFakeKernel(approvals: ApprovalStore): WiredKernel {
  const activations = new InMemoryActivationStore()
  const modules = new ModuleRegistry(activations)
  modules.register(makeManifest('memory'))
  modules.register(makeManifest('email'))
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    activationStore: activations,
  })
  const principals: PrincipalStore = {
    getById: async () => null,
    getByApiKey: async () => null,
  }
  return {
    registry,
    modules,
    activations,
    principals,
    approvals,
    eventSink: new InMemoryEventSink(),
    sessionLog: new InMemoryAgentSessionLog(),
  }
}

function makeCtx(overrides: Partial<ToolContext['principal']> = {}): ToolContext {
  return {
    principal: { id: 'principal-1', kind: 'human', roles: ['admin', 'owner'], ...overrides },
    requestId: 'req-1',
  }
}

type ListSpy = { calls: Array<ApprovalStatus | undefined> }

function makeRichApprovalStore(requests: ApprovalRequest[]): {
  store: ApprovalStore
  spy: ListSpy
} {
  const spy: ListSpy = { calls: [] }
  const store: ApprovalStore = {
    create: async (req) => req,
    decide: async (id, status, decidedBy) => {
      const existing = requests.find((r) => r.id === id)
      if (!existing) throw new Error(`unknown approval request: ${id}`)
      return { ...existing, status, decidedBy, decidedAt: new Date().toISOString() }
    },
    listPending: async () => requests.filter((r) => r.status === 'pending'),
    latestFor: async () => null,
    list: async (status?: ApprovalStatus) => {
      spy.calls.push(status)
      return status === undefined ? [...requests] : requests.filter((r) => r.status === status)
    },
  }
  return { store, spy }
}

describe('registerAdminTools', () => {
  it('registers the kernel manifest and all five admin tools, and self-seeds activation', async () => {
    const approvals = new InMemoryApprovalStore()
    const kernel = makeFakeKernel(approvals)
    await registerAdminTools(kernel)

    expect(kernel.modules.get('kernel')).toBeDefined()
    for (const name of [
      'kernel.module_list',
      'kernel.module_activate',
      'kernel.module_deactivate',
      'kernel.approvals_list',
      'kernel.approvals_decide',
    ]) {
      expect(kernel.registry.get(name)?.module).toBe('kernel')
    }
    expect(await kernel.activations.get('kernel')).toBe(true)
  })

  it('executes admin tools through the full registry pipeline (permissions + audit)', async () => {
    const approvals = new InMemoryApprovalStore()
    const kernel = makeFakeKernel(approvals)
    await registerAdminTools(kernel)

    await expect(
      kernel.registry.execute('kernel.module_activate', { module_id: 'memory' }, makeCtx()),
    ).resolves.toMatchObject({ module_id: 'memory', active: true })
    expect(await kernel.activations.get('memory')).toBe(true)

    const adminOnly = makeCtx({ roles: ['admin'] })
    await expect(
      kernel.registry.execute('kernel.approvals_list', {}, adminOnly),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('decides pending approvals through the registry with an owner principal', async () => {
    const approvals = new InMemoryApprovalStore()
    await approvals.create({
      id: 'appr-1',
      toolName: 'email.send_mail',
      input: {},
      principalId: 'principal-2',
      status: 'pending',
    })
    const kernel = makeFakeKernel(approvals)
    await registerAdminTools(kernel)

    await expect(
      kernel.registry.execute(
        'kernel.approvals_decide',
        { approval_id: 'appr-1', decision: 'denied' },
        makeCtx({ roles: ['owner'] }),
      ),
    ).resolves.toMatchObject({ id: 'appr-1', status: 'denied', decidedBy: 'principal-1' })
  })

  it('is idempotent when admin tools are registered twice on the same kernel', async () => {
    const kernel = makeFakeKernel(new InMemoryApprovalStore())
    await registerAdminTools(kernel)
    await expect(registerAdminTools(kernel)).resolves.toBeUndefined()
  })

  it('uses an injected rich approval store for status-filtered listing', async () => {
    const requests: ApprovalRequest[] = [
      {
        id: 'appr-2',
        toolName: 'email.send_mail',
        input: {},
        principalId: 'principal-2',
        status: 'approved',
      },
    ]
    const { store, spy } = makeRichApprovalStore(requests)
    const kernel = makeFakeKernel(store)
    await registerAdminTools(kernel, { approvals: store })

    await expect(
      kernel.registry.execute('kernel.approvals_list', { status: 'approved' }, makeCtx()),
    ).resolves.toEqual(requests)
    expect(spy.calls).toEqual(['approved'])
  })

  it('fails loud when listing non-pending approvals without a capable store or db', async () => {
    const kernel = makeFakeKernel(new InMemoryApprovalStore())
    await registerAdminTools(kernel)

    await expect(
      kernel.registry.execute('kernel.approvals_list', { status: 'approved' }, makeCtx()),
    ).rejects.toThrow(/cannot list approvals with status "approved"/)

    await expect(kernel.registry.execute('kernel.approvals_list', {}, makeCtx())).rejects.toThrow(
      /cannot list approvals without a status filter/,
    )
  })

  it('delegates pending listing to the plain store without a db', async () => {
    const approvals = new InMemoryApprovalStore()
    await approvals.create({
      id: 'appr-3',
      toolName: 'email.send_mail',
      input: {},
      principalId: 'principal-2',
      status: 'pending',
    })
    const kernel = makeFakeKernel(approvals)
    await registerAdminTools(kernel)

    await expect(
      kernel.registry.execute('kernel.approvals_list', { status: 'pending' }, makeCtx()),
    ).resolves.toHaveLength(1)
  })
})

describe('listableApprovalStore', () => {
  it('returns rich stores as-is (capability preserved, no wrapper)', () => {
    const { store } = makeRichApprovalStore([])
    expect(listableApprovalStore(store)).toBe(store)
  })

  it('wraps plain stores: pending delegates to listPending, others fail loud', async () => {
    const approvals = new InMemoryApprovalStore()
    await approvals.create({
      id: 'appr-4',
      toolName: 'email.send_mail',
      input: {},
      principalId: 'p',
      status: 'pending',
    })
    const wrapped = listableApprovalStore(approvals)

    await expect(wrapped.list('pending')).resolves.toHaveLength(1)
    await expect(wrapped.list('denied')).rejects.toThrow(
      /cannot list approvals with status "denied"/,
    )
    await expect(wrapped.list(undefined)).rejects.toThrow(
      /cannot list approvals without a status filter/,
    )
    await expect(
      wrapped.create({ id: 'x', toolName: 't', input: {}, principalId: 'p', status: 'pending' }),
    ).resolves.toBeDefined()
    await expect(wrapped.listPending()).resolves.toHaveLength(2)
    await expect(wrapped.decide('appr-4', 'approved', 'by')).resolves.toMatchObject({
      status: 'approved',
    })
    await expect(wrapped.latestFor('email.send_mail', 'p')).resolves.toMatchObject({ id: 'appr-4' })
  })
})
