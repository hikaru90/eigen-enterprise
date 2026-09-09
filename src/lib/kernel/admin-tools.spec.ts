import type { ApprovalRequest, ApprovalStatus, ApprovalStore } from './approvals'
import type { ToolContext, ToolDescriptor } from './types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAdminTools, KERNEL_ADMIN_TOOL_NAMES, KERNEL_MODULE_ID } from './admin-tools'
import {
  InMemoryActivationStore,
  ModuleRegistry,
  type ActivationStore,
  type ModuleManifest,
} from './modules'

function makeManifest(id: string): ModuleManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    tools: [`${id}.tool_one`],
    permissions: { roles: ['admin'] },
  }
}

function makeModules(activations: ActivationStore, manifests: ModuleManifest[]): ModuleRegistry {
  const modules = new ModuleRegistry(activations)
  for (const manifest of manifests) modules.register(manifest)
  return modules
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

function toolByName(tools: ToolDescriptor[], name: string): ToolDescriptor {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`missing admin tool: ${name}`)
  return tool
}

describe('createAdminTools surface', () => {
  const tools = createAdminTools({
    modules: makeModules(new InMemoryActivationStore(), [makeManifest('memory')]),
    activations: new InMemoryActivationStore(),
    approvals: makeRichApprovalStore([]).store,
  })

  it('registers exactly the five kernel admin tools under module id "kernel"', () => {
    expect(tools.map((t) => t.name)).toEqual([...KERNEL_ADMIN_TOOL_NAMES])
    for (const tool of tools) expect(tool.module).toBe(KERNEL_MODULE_ID)
  })

  it('maps audit classes: reads are read, mutations are mutate', () => {
    expect(toolByName(tools, 'kernel.module_list').auditClass).toBe('read')
    expect(toolByName(tools, 'kernel.approvals_list').auditClass).toBe('read')
    expect(toolByName(tools, 'kernel.module_activate').auditClass).toBe('mutate')
    expect(toolByName(tools, 'kernel.module_deactivate').auditClass).toBe('mutate')
    expect(toolByName(tools, 'kernel.approvals_decide').auditClass).toBe('mutate')
  })

  it('maps roles: module ops are admin ops, approval ops are conversational (owner/admin/agent)', () => {
    expect(toolByName(tools, 'kernel.module_list').permission.roles).toEqual(['admin'])
    expect(toolByName(tools, 'kernel.module_activate').permission.roles).toEqual(['admin'])
    expect(toolByName(tools, 'kernel.module_deactivate').permission.roles).toEqual(['admin'])
    expect(toolByName(tools, 'kernel.approvals_list').permission.roles).toEqual([
      'owner',
      'admin',
      'agent',
    ])
    expect(toolByName(tools, 'kernel.approvals_decide').permission.roles).toEqual([
      'owner',
      'admin',
      'agent',
    ])
  })

  it('validates inputs with zod schemas', () => {
    expect(() => toolByName(tools, 'kernel.module_activate').inputSchema.parse({})).toThrow()
    expect(() =>
      toolByName(tools, 'kernel.module_activate').inputSchema.parse({ module_id: 'memory' }),
    ).not.toThrow()
    expect(() =>
      toolByName(tools, 'kernel.approvals_list').inputSchema.parse({ status: 'nope' }),
    ).toThrow()
    expect(() =>
      toolByName(tools, 'kernel.approvals_decide').inputSchema.parse({
        approval_id: 'a',
        decision: 'maybe',
      }),
    ).toThrow()
    expect(() =>
      toolByName(tools, 'kernel.module_list').inputSchema.parse(z.object({})),
    ).not.toThrow()
  })
})

describe('kernel.module_list handler', () => {
  it('returns every manifest with its activation state', async () => {
    const activations = new InMemoryActivationStore()
    await activations.set('memory', true)
    const modules = makeModules(activations, [makeManifest('memory'), makeManifest('email')])
    const [listTool] = createAdminTools({
      modules,
      activations,
      approvals: makeRichApprovalStore([]).store,
    })

    const result = await listTool.handler(makeCtx(), {})
    expect(result).toEqual([
      { id: 'memory', name: 'memory', version: '1.0.0', tools: ['memory.tool_one'], active: true },
      { id: 'email', name: 'email', version: '1.0.0', tools: ['email.tool_one'], active: false },
    ])
  })
})

describe('kernel.module_activate / kernel.module_deactivate handlers', () => {
  it('activate flips the module active via the module registry', async () => {
    const activations = new InMemoryActivationStore()
    const modules = makeModules(activations, [makeManifest('memory')])
    const tools = createAdminTools({
      modules,
      activations,
      approvals: makeRichApprovalStore([]).store,
    })
    const activate = toolByName(tools, 'kernel.module_activate')

    const result = await activate.handler(makeCtx(), { module_id: 'memory' })
    expect(result).toMatchObject({ module_id: 'memory', active: true })
    expect(await activations.get('memory')).toBe(true)
  })

  it('deactivate flips the module inactive', async () => {
    const activations = new InMemoryActivationStore()
    const modules = makeModules(activations, [makeManifest('memory')])
    const tools = createAdminTools({
      modules,
      activations,
      approvals: makeRichApprovalStore([]).store,
    })
    const deactivate = toolByName(tools, 'kernel.module_deactivate')

    const result = await deactivate.handler(makeCtx(), { module_id: 'memory' })
    expect(result).toMatchObject({ module_id: 'memory', active: false })
    expect(await activations.get('memory')).toBe(false)
  })

  it('throws loud on unknown module ids and leaves the store untouched', async () => {
    const activations = new InMemoryActivationStore()
    const modules = makeModules(activations, [makeManifest('memory')])
    const tools = createAdminTools({
      modules,
      activations,
      approvals: makeRichApprovalStore([]).store,
    })
    const activate = toolByName(tools, 'kernel.module_activate')

    await expect(activate.handler(makeCtx(), { module_id: 'ghost' })).rejects.toThrow(
      /unknown module: ghost/,
    )
    expect(await activations.get('ghost')).toBe(false)
  })
})

describe('kernel.approvals_list handler', () => {
  it('passes the optional status filter through to the store', async () => {
    const { store, spy } = makeRichApprovalStore([])
    const tools = createAdminTools({
      modules: makeModules(new InMemoryActivationStore(), []),
      activations: new InMemoryActivationStore(),
      approvals: store,
    })
    const list = toolByName(tools, 'kernel.approvals_list')

    await list.handler(makeCtx(), {})
    await list.handler(makeCtx(), { status: 'denied' })
    expect(spy.calls).toEqual([undefined, 'denied'])
  })

  it('returns the store listing as-is', async () => {
    const requests: ApprovalRequest[] = [
      {
        id: 'req-1',
        toolName: 'email.send_mail',
        input: { to: 'a@example.com' },
        principalId: 'principal-2',
        status: 'approved',
      },
    ]
    const { store } = makeRichApprovalStore(requests)
    const tools = createAdminTools({
      modules: makeModules(new InMemoryActivationStore(), []),
      activations: new InMemoryActivationStore(),
      approvals: store,
    })

    await expect(
      toolByName(tools, 'kernel.approvals_list').handler(makeCtx(), { status: 'approved' }),
    ).resolves.toEqual(requests)
  })
})

describe('kernel.approvals_decide handler', () => {
  it('decides with the executing principal as decidedBy', async () => {
    const pending: ApprovalRequest = {
      id: 'req-9',
      toolName: 'email.send_mail',
      input: {},
      principalId: 'principal-2',
      status: 'pending',
    }
    const { store } = makeRichApprovalStore([pending])
    const tools = createAdminTools({
      modules: makeModules(new InMemoryActivationStore(), []),
      activations: new InMemoryActivationStore(),
      approvals: store,
    })
    const decide = toolByName(tools, 'kernel.approvals_decide')

    const result = await decide.handler(makeCtx({ roles: ['owner'] }), {
      approval_id: 'req-9',
      decision: 'approved',
    })
    expect(result).toMatchObject({ id: 'req-9', status: 'approved', decidedBy: 'principal-1' })
  })
})
