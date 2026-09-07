import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalStore, StaticApprovalPolicy } from './approvals'
import { KernelError } from './errors'
import { InMemoryEventSink } from './events'
import { InMemoryActivationStore } from './modules'
import { KernelRegistry } from './registry'
import type { ToolContext, ToolDescriptor } from './types'
import type { VcsCommitter } from './vcs'

function makeCtx(overrides: Partial<ToolContext['principal']> = {}): ToolContext {
  return {
    principal: { id: 'principal-1', kind: 'human', roles: ['admin'], ...overrides },
    requestId: 'req-1',
  }
}

function makeTool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name: 'memory.echo',
    module: 'memory',
    summary: 'echoes its input',
    inputSchema: z.object({ value: z.string() }),
    permission: { roles: ['admin'] },
    auditClass: 'read',
    handler: async (_ctx, input) => ({ echoed: input }),
    ...overrides,
  }
}

function makeVcsSpy() {
  const messages: string[] = []
  const spy: VcsCommitter = {
    commit: async (message: string) => {
      messages.push(message)
      return 'deadbeef'
    },
  }
  return { spy, messages }
}

describe('KernelRegistry registration + lookup', () => {
  it('throws duplicate_tool on duplicate registration', () => {
    const registry = new KernelRegistry()
    registry.register(makeTool())
    expect(() => registry.register(makeTool())).toThrowError(KernelError)
    try {
      registry.register(makeTool())
    } catch (err) {
      expect((err as KernelError).code).toBe('duplicate_tool')
    }
  })

  it('throws unknown_tool for unregistered tools', async () => {
    const registry = new KernelRegistry()
    await expect(registry.execute('memory.nope', {}, makeCtx())).rejects.toMatchObject({
      code: 'unknown_tool',
    })
  })

  it('get and list with module/auditClass filters', () => {
    const registry = new KernelRegistry()
    registry.register(makeTool())
    registry.register(makeTool({ name: 'mail.send', module: 'mail', auditClass: 'mutate' }))
    expect(registry.get('memory.echo')?.name).toBe('memory.echo')
    expect(registry.get('nope')).toBeUndefined()
    expect(registry.list({ module: 'mail' }).map((t) => t.name)).toEqual(['mail.send'])
    expect(registry.list({ auditClass: 'mutate' }).map((t) => t.name)).toEqual(['mail.send'])
    expect(registry.list({ module: 'mail', auditClass: 'read' })).toEqual([])
    expect(registry.list()).toHaveLength(2)
  })
})

describe('KernelRegistry.execute permission + validation', () => {
  it('throws permission_denied when roles do not intersect', async () => {
    const registry = new KernelRegistry()
    const handlerCalls: unknown[] = []
    registry.register(makeTool({ handler: async (c, i) => handlerCalls.push([c, i]) }))
    await expect(
      registry.execute('memory.echo', { value: 'x' }, makeCtx({ roles: ['viewer'] })),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    expect(handlerCalls).toHaveLength(0)
  })

  it('passes when any role intersects', async () => {
    const registry = new KernelRegistry()
    registry.register(makeTool({ permission: { roles: ['owner-only', 'admin'] } }))
    await expect(
      registry.execute('memory.echo', { value: 'x' }, makeCtx({ roles: ['viewer', 'admin'] })),
    ).resolves.toEqual({ echoed: { value: 'x' } })
  })

  it('throws invalid_input on schema violation and skips the handler', async () => {
    const sink = new InMemoryEventSink()
    const registry = new KernelRegistry({ eventSink: sink })
    const handlerCalls: unknown[] = []
    registry.register(makeTool({ handler: async (c, i) => handlerCalls.push([c, i]) }))
    await expect(
      registry.execute('memory.echo', { value: 42 }, makeCtx()),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(handlerCalls).toHaveLength(0)
    expect(sink.events).toHaveLength(0)
  })
})

describe('KernelRegistry.execute external flow (approvals cover everything non-read)', () => {
  const toolName = 'email.send_mail'

  function makeExternalRegistry(policy: StaticApprovalPolicy) {
    const sink = new InMemoryEventSink()
    const store = new InMemoryApprovalStore()
    const { spy, messages } = makeVcsSpy()
    const registry = new KernelRegistry({
      eventSink: sink,
      approvalPolicy: policy,
      approvalStore: store,
      vcsCommitter: spy,
    })
    const handlerCalls: unknown[] = []
    registry.register(
      makeTool({
        name: toolName,
        module: 'email',
        auditClass: 'external',
        handler: async (c, i) => {
          handlerCalls.push([c, i])
          return { sent: true }
        },
      }),
    )
    return { registry, sink, store, messages, handlerCalls }
  }

  it('requires approval for external tools when the policy demands it', async () => {
    const policy = new StaticApprovalPolicy(new Set([toolName]))
    const { registry, store, messages, handlerCalls } = makeExternalRegistry(policy)
    const ctx = makeCtx()

    await expect(registry.execute(toolName, { value: 'hello' }, ctx)).rejects.toMatchObject({
      code: 'approval_required',
    })
    expect(handlerCalls).toHaveLength(0)
    const pending = await store.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ toolName, status: 'pending' })

    await store.decide(pending[0].id, 'approved', 'the-owner')
    await expect(registry.execute(toolName, { value: 'hello' }, ctx)).resolves.toEqual({
      sent: true,
    })
    expect(handlerCalls).toHaveLength(1)
    // external actions change no repo state: no vcs commit, ever
    expect(messages).toHaveLength(0)
  })

  it('runs external tools without approval when not listed in the policy', async () => {
    const policy = new StaticApprovalPolicy(new Set())
    const { registry, sink, handlerCalls } = makeExternalRegistry(policy)

    await expect(registry.execute(toolName, { value: 'hello' }, makeCtx())).resolves.toEqual({
      sent: true,
    })
    expect(handlerCalls).toHaveLength(1)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]).toMatchObject({
      payload: { tool: toolName, auditClass: 'external', ok: true },
    })
  })
})

describe('KernelRegistry.execute mutate flow', () => {
  const toolName = 'memory.wipe'

  function makeMutateRegistry(policy: StaticApprovalPolicy) {
    const sink = new InMemoryEventSink()
    const store = new InMemoryApprovalStore()
    const { spy, messages } = makeVcsSpy()
    const registry = new KernelRegistry({
      eventSink: sink,
      approvalPolicy: policy,
      approvalStore: store,
      vcsCommitter: spy,
    })
    const handlerCalls: unknown[] = []
    registry.register(
      makeTool({
        name: toolName,
        auditClass: 'mutate',
        handler: async (c, i) => {
          handlerCalls.push([c, i])
          return { wiped: true }
        },
      }),
    )
    return { registry, sink, store, messages, handlerCalls }
  }

  it('blocks with approval_required and creates a pending request; executes after approval', async () => {
    const policy = new StaticApprovalPolicy(new Set([toolName]))
    const { registry, sink, store, messages, handlerCalls } = makeMutateRegistry(policy)
    const ctx = makeCtx()

    await expect(registry.execute(toolName, { value: 'gone' }, ctx)).rejects.toMatchObject({
      code: 'approval_required',
    })
    expect(handlerCalls).toHaveLength(0)
    expect(messages).toHaveLength(0)
    const pending = await store.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ toolName, principalId: 'principal-1', status: 'pending' })

    await store.decide(pending[0].id, 'approved', 'the-owner')

    await expect(registry.execute(toolName, { value: 'gone' }, ctx)).resolves.toEqual({
      wiped: true,
    })
    expect(handlerCalls).toHaveLength(1)
    expect(messages).toEqual([`tool ${toolName} by principal-1`])
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]).toMatchObject({
      type: 'tool.executed',
      principalId: 'principal-1',
      payload: { tool: toolName, auditClass: 'mutate', ok: true, durationMs: expect.any(Number) },
    })
  })

  it('stays blocked after denial', async () => {
    const policy = new StaticApprovalPolicy(new Set([toolName]))
    const { registry, store, handlerCalls } = makeMutateRegistry(policy)
    const ctx = makeCtx()

    await expect(registry.execute(toolName, { value: 'x' }, ctx)).rejects.toMatchObject({
      code: 'approval_required',
    })
    const [request] = await store.listPending()
    await store.decide(request.id, 'denied', 'the-owner')

    await expect(registry.execute(toolName, { value: 'x' }, ctx)).rejects.toMatchObject({
      code: 'approval_required',
    })
    expect(handlerCalls).toHaveLength(0)
  })

  it('rethrows handler errors, emits ok:false audit, and skips the vcs commit', async () => {
    const policy = new StaticApprovalPolicy(new Set())
    const { registry, sink, messages } = makeMutateRegistry(policy)
    registry.register(
      makeTool({
        name: 'memory.break',
        auditClass: 'mutate',
        handler: async () => {
          throw new Error('boom')
        },
      }),
    )

    await expect(registry.execute('memory.break', { value: 'x' }, makeCtx())).rejects.toThrow(
      'boom',
    )
    expect(messages).toHaveLength(0)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].payload).toMatchObject({ tool: 'memory.break', ok: false, error: 'boom' })
  })
})

describe('KernelRegistry.execute read flow', () => {
  it('emits audit and never calls the vcs committer', async () => {
    const sink = new InMemoryEventSink()
    const { spy, messages } = makeVcsSpy()
    const registry = new KernelRegistry({ eventSink: sink, vcsCommitter: spy })
    registry.register(makeTool())

    await expect(
      registry.execute('memory.echo', { value: 'hi' }, makeCtx()),
    ).resolves.toEqual({ echoed: { value: 'hi' } })
    expect(messages).toHaveLength(0)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].payload).toMatchObject({ tool: 'memory.echo', auditClass: 'read', ok: true })
  })
})

describe('KernelRegistry.execute module activation gating', () => {
  it('is skipped when no activation store is injected (bare in-memory usage)', async () => {
    const registry = new KernelRegistry()
    registry.register(makeTool())
    await expect(
      registry.execute('memory.echo', { value: 'x' }, makeCtx()),
    ).resolves.toEqual({ echoed: { value: 'x' } })
  })

  it('throws module_inactive (fail closed) for inactive modules and skips handler + audit', async () => {
    const sink = new InMemoryEventSink()
    const activations = new InMemoryActivationStore()
    const registry = new KernelRegistry({ eventSink: sink, activationStore: activations })
    const handlerCalls: unknown[] = []
    registry.register(makeTool({ handler: async (c, i) => handlerCalls.push([c, i]) }))

    await expect(
      registry.execute('memory.echo', { value: 'x' }, makeCtx()),
    ).rejects.toSatisfy((err: unknown) => err instanceof KernelError && err.code === 'module_inactive')
    expect(handlerCalls).toHaveLength(0)
    expect(sink.events).toHaveLength(0)
  })

  it('executes when the owning module is active, and deactivation re-gates', async () => {
    const activations = new InMemoryActivationStore()
    const registry = new KernelRegistry({ activationStore: activations })
    registry.register(makeTool())

    await activations.set('memory', true)
    await expect(
      registry.execute('memory.echo', { value: 'x' }, makeCtx()),
    ).resolves.toEqual({ echoed: { value: 'x' } })

    await activations.set('memory', false)
    await expect(
      registry.execute('memory.echo', { value: 'x' }, makeCtx()),
    ).rejects.toSatisfy((err: unknown) => err instanceof KernelError && err.code === 'module_inactive')
  })

  it('gates per module: activating another module does not unlock this tool', async () => {
    const activations = new InMemoryActivationStore()
    const registry = new KernelRegistry({ activationStore: activations })
    registry.register(makeTool())
    registry.register(makeTool({ name: 'mail.send', module: 'mail', auditClass: 'mutate' }))

    await activations.set('mail', true)
    await expect(
      registry.execute('memory.echo', { value: 'x' }, makeCtx()),
    ).rejects.toSatisfy((err: unknown) => err instanceof KernelError && err.code === 'module_inactive')
    await expect(
      registry.execute('mail.send', { value: 'x' }, makeCtx()),
    ).resolves.toEqual({ echoed: { value: 'x' } })
  })

  it('runs the activation gate before the permission check', async () => {
    const activations = new InMemoryActivationStore()
    const registry = new KernelRegistry({ activationStore: activations })
    registry.register(makeTool())

    await expect(
      registry.execute('memory.echo', { value: 'x' }, makeCtx({ roles: ['viewer'] })),
    ).rejects.toSatisfy((err: unknown) => err instanceof KernelError && err.code === 'module_inactive')
  })
})
