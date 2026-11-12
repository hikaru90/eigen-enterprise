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
      {
        id: 'memory',
        name: 'memory',
        version: '1.0.0',
        tools: ['memory.tool_one'],
        active: true,
        core: false,
        requires: [],
        requiredBy: [],
      },
      {
        id: 'email',
        name: 'email',
        version: '1.0.0',
        tools: ['email.tool_one'],
        active: false,
        core: false,
        requires: [],
        requiredBy: [],
      },
    ])
  })

  it('marks the core (the kernel and internal modules) and says which modules need which', async () => {
    const activations = new InMemoryActivationStore()
    const modules = makeModules(activations, [
      makeManifest(KERNEL_MODULE_ID),
      { ...makeManifest('members'), internal: true },
      makeManifest('messages'),
      { ...makeManifest('calls'), requires: ['messages'] },
    ])
    const [listTool] = createAdminTools({ modules, activations, approvals: makeRichApprovalStore([]).store })

    const result = (await listTool.handler(makeCtx(), {})) as Array<Record<string, unknown>>
    const byId = Object.fromEntries(result.map((m) => [m.id, m]))
    expect(byId.kernel).toMatchObject({ core: true, requires: [], requiredBy: [] })
    expect(byId.members).toMatchObject({ core: true })
    expect(byId.messages).toMatchObject({ core: false, requires: [], requiredBy: ['calls'] })
    expect(byId.calls).toMatchObject({ core: false, requires: ['messages'], requiredBy: [] })
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

  /** Messages and Calls (Calls needs Messages) plus the internal Members core, all on. */
  async function pluginsAndCore() {
    const activations = new InMemoryActivationStore()
    for (const id of ['messages', 'calls', 'members', KERNEL_MODULE_ID]) await activations.set(id, true)
    const modules = makeModules(activations, [
      makeManifest(KERNEL_MODULE_ID),
      { ...makeManifest('members'), name: 'Members', internal: true },
      { ...makeManifest('messages'), name: 'Messages' },
      { ...makeManifest('calls'), name: 'Calls', requires: ['messages'] },
    ])
    const tools = createAdminTools({ modules, activations, approvals: makeRichApprovalStore([]).store })
    return {
      activations,
      activate: toolByName(tools, 'kernel.module_activate'),
      deactivate: toolByName(tools, 'kernel.module_deactivate'),
    }
  }

  it.each(['members', KERNEL_MODULE_ID])('refuses to switch off the core (%s): a kernel error, still on', async (id) => {
    const { activations, deactivate } = await pluginsAndCore()
    await expect(deactivate.handler(makeCtx(), { module_id: id })).rejects.toMatchObject({
      name: 'KernelError',
      code: 'core_module',
      details: { module: id },
    })
    expect(await activations.get(id)).toBe(true)
  })

  it('says the core refusal in words', async () => {
    const { deactivate } = await pluginsAndCore()
    await expect(deactivate.handler(makeCtx(), { module_id: 'members' })).rejects.toThrow(
      'Members is part of the eigenEnterprise core and cannot be switched off.',
    )
  })

  it('refuses to switch off a plugin another active plugin needs, naming it', async () => {
    const { activations, deactivate } = await pluginsAndCore()
    await expect(deactivate.handler(makeCtx(), { module_id: 'messages' })).rejects.toMatchObject({
      code: 'module_required',
      message: 'Calls needs Messages: switch off Calls first.',
      details: { module: 'messages', requiredBy: ['calls'] },
    })
    expect(await activations.get('messages')).toBe(true)
  })

  it('switches a needed plugin off once what needs it is off', async () => {
    const { activations, deactivate } = await pluginsAndCore()
    await deactivate.handler(makeCtx(), { module_id: 'calls' })
    await expect(deactivate.handler(makeCtx(), { module_id: 'messages' })).resolves.toEqual({
      module_id: 'messages',
      active: false,
    })
    expect(await activations.get('messages')).toBe(false)
  })

  it('refuses to switch on a plugin while one it needs is off, naming it', async () => {
    const { activations, activate, deactivate } = await pluginsAndCore()
    await deactivate.handler(makeCtx(), { module_id: 'calls' })
    await deactivate.handler(makeCtx(), { module_id: 'messages' })
    await expect(activate.handler(makeCtx(), { module_id: 'calls' })).rejects.toMatchObject({
      code: 'module_required',
      message: 'Calls needs Messages: switch on Messages first.',
      details: { module: 'calls', missing: ['messages'] },
    })
    expect(await activations.get('calls')).toBe(false)
  })

  // Owner, 2026-11-12: the assistant never switches back on a plugin a person switched off.
  it.each(['agent', 'service'] as const)(
    'refuses an %s principal switching on a plugin a person switched off (no approval-free way back)',
    async (kind) => {
      const { activations, activate, deactivate } = await pluginsAndCore()
      await deactivate.handler(makeCtx(), { module_id: 'calls' })
      await expect(activate.handler(makeCtx({ kind, roles: ['admin', 'agent'] }), { module_id: 'calls' })).rejects.toMatchObject({
        name: 'KernelError',
        code: 'module_switched_off',
        message: 'Calls was switched off by a person. Only the owner or an admin can switch it back on, in Settings → Plugins.',
        details: { module: 'calls' },
      })
      expect(await activations.get('calls')).toBe(false)
    },
  )

  it('lets an agent switch on a plugin that was never set up (no activation record)', async () => {
    const activations = new InMemoryActivationStore()
    const modules = makeModules(activations, [makeManifest('memory')])
    const tools = createAdminTools({ modules, activations, approvals: makeRichApprovalStore([]).store })
    const activate = toolByName(tools, 'kernel.module_activate')
    await expect(activate.handler(makeCtx({ kind: 'agent', roles: ['admin', 'agent'] }), { module_id: 'memory' })).resolves.toEqual({
      module_id: 'memory',
      active: true,
    })
    expect(await activations.get('memory')).toBe(true)
  })

  it('lets a person switch a switched-off plugin back on', async () => {
    const { activations, activate, deactivate } = await pluginsAndCore()
    await deactivate.handler(makeCtx(), { module_id: 'calls' })
    await expect(activate.handler(makeCtx(), { module_id: 'calls' })).resolves.toEqual({ module_id: 'calls', active: true })
    expect(await activations.get('calls')).toBe(true)
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
