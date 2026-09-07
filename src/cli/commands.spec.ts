import type { CliCommandContext, CommandOutcome } from './commands'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalStore, type ApprovalRequest } from '$lib/kernel/approvals'
import { KernelError } from '$lib/kernel/errors'
import type { ActivationStore } from '$lib/kernel/modules'
import type { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { parseCliArgs } from './args'
import { dispatchCommand, renderOutcome, validateParsedCommand } from './commands'

/**
 * Command handlers are exercised against a fake KernelRegistry: assertions
 * cover tool names, inputs, ctx.principal mapping, and exit-code mapping.
 * No process execution — fast and deterministic.
 */

function makeTool(name: string, module: string): ToolDescriptor {
  return {
    name,
    module,
    summary: `${name} summary`,
    inputSchema: z.object({}),
    permission: { roles: ['admin'] },
    auditClass: 'read',
    handler: async () => ({}),
  }
}

const KERNEL_FAKE_TOOLS = [
  'kernel.module_list',
  'kernel.module_activate',
  'kernel.module_deactivate',
  'kernel.approvals_list',
  'kernel.approvals_decide',
].map((name) => makeTool(name, 'kernel'))

type RecordedCall = { name: string; input: unknown; ctx: ToolContext }

function makeFakeKernel(
  options: {
    tools?: ToolDescriptor[]
    activeModules?: string[]
    execute?: (name: string, input: unknown, ctx: ToolContext) => Promise<unknown>
  } = {},
) {
  const calls: RecordedCall[] = []
  const tools = options.tools ?? [
    makeTool('memory.echo', 'memory'),
    makeTool('email.send', 'email'),
    ...KERNEL_FAKE_TOOLS,
  ]
  const activeModules = new Set(options.activeModules ?? ['memory', 'email', 'kernel'])
  const activations: Pick<ActivationStore, 'get'> = {
    get: async (id) => activeModules.has(id),
  }
  const approvalStore = new InMemoryApprovalStore()
  const registry = {
    execute: async (name: string, input: unknown, ctx: ToolContext) => {
      calls.push({ name, input, ctx })
      if (options.execute) return options.execute(name, input, ctx)
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new KernelError('unknown_tool', `unknown tool: ${name}`)
      return { echoed: input }
    },
    list: (filter?: { module?: string }) =>
      tools.filter((t) => filter?.module === undefined || t.module === filter.module),
    get: (name: string) => tools.find((t) => t.name === name),
    getApprovalStore: () => approvalStore,
  }
  return {
    registry: registry as unknown as KernelRegistry,
    activations,
    approvalStore,
    calls,
  }
}

function makeCtx(
  kernel: ReturnType<typeof makeFakeKernel>,
  principal = defaultPrincipal(),
): CliCommandContext {
  return {
    registry: kernel.registry,
    activations: kernel.activations,
    principal,
    requestId: 'req-1',
  }
}

function defaultPrincipal() {
  return { id: 'principal-1', kind: 'human' as const, roles: ['admin', 'owner'] }
}

async function dispatch(argv: string[], kernel = makeFakeKernel(), principal = defaultPrincipal()) {
  const args = parseCliArgs(argv)
  return dispatchCommand(makeCtx(kernel, principal), args)
}

describe('validateParsedCommand', () => {
  it('accepts every supported command shape', () => {
    for (const argv of [
      ['status'],
      ['tool', 'list'],
      ['tool', 'run', 'memory.echo', '--input', '{}'],
      ['module', 'list'],
      ['module', 'activate', 'memory'],
      ['module', 'deactivate', 'memory'],
      ['approvals', 'list'],
      ['approvals', 'list', '--status', 'pending'],
      ['approvals', 'decide', 'id-1', '--approve'],
      ['openapi'],
    ]) {
      expect(() => validateParsedCommand(parseCliArgs(argv))).not.toThrow()
    }
  })

  it('rejects unknown groups and actions', () => {
    expect(() => validateParsedCommand(parseCliArgs(['nope']))).toThrowError(
      /unknown command group/,
    )
    expect(() => validateParsedCommand(parseCliArgs(['tool', 'dance']))).toThrowError(
      /unknown action/,
    )
  })

  it('rejects missing positionals and flags', () => {
    expect(() => validateParsedCommand(parseCliArgs(['tool', 'run']))).toThrowError(/tool name/)
    expect(() => validateParsedCommand(parseCliArgs(['tool', 'run', 'memory.echo']))).toThrowError(
      /--input/,
    )
    expect(() => validateParsedCommand(parseCliArgs(['module', 'activate']))).toThrowError(
      /module id/,
    )
    expect(() => validateParsedCommand(parseCliArgs(['approvals', 'decide']))).toThrowError(
      /approval id/,
    )
  })

  it('rejects invalid JSON input and undecided decisions', () => {
    expect(() =>
      validateParsedCommand(parseCliArgs(['tool', 'run', 'x', '--input', '{nope'])),
    ).toThrowError(/--input is not valid JSON/)
    expect(() => validateParsedCommand(parseCliArgs(['approvals', 'decide', 'id-1']))).toThrowError(
      /exactly one of --approve or --deny/,
    )
    expect(() =>
      validateParsedCommand(parseCliArgs(['approvals', 'decide', 'id-1', '--approve', '--deny'])),
    ).toThrowError(/exactly one of --approve or --deny/)
  })
})

describe('ee status', () => {
  it('composes module_list and pending approvals through the registry', async () => {
    const kernel = makeFakeKernel()
    const outcome = await dispatch(['status'], kernel)

    expect(outcome.exitCode).toBe(0)
    expect(kernel.calls.map((c) => c.name)).toEqual(['kernel.module_list', 'kernel.approvals_list'])
    expect(kernel.calls[1].input).toEqual({ status: 'pending' })
    expect(outcome.data).toEqual({
      modules: { echoed: {} },
      pendingApprovals: { echoed: { status: 'pending' } },
    })
  })

  it('maps --principal to ctx.principal on every registry.execute call', async () => {
    const kernel = makeFakeKernel()
    await dispatch(['status'], kernel, { id: 'principal-7', kind: 'agent', roles: ['admin'] })

    for (const call of kernel.calls) {
      expect(call.ctx.principal).toEqual({ id: 'principal-7', kind: 'agent', roles: ['admin'] })
      expect(call.ctx.requestId).toBe('req-1')
    }
  })
})

describe('ee tool list', () => {
  it('omits tools of inactive modules (same fail-closed filter as MCP tools/list)', async () => {
    const kernel = makeFakeKernel({ activeModules: ['memory'] })
    const outcome = await dispatch(['tool', 'list', '--json'], kernel)

    expect(outcome.exitCode).toBe(0)
    const tools = (outcome.data as Array<{ name: string }>).map((t) => t.name)
    expect(tools).toEqual(['memory.echo'])
  })

  it('filters by --module on top of the activation filter', async () => {
    const kernel = makeFakeKernel({
      tools: [makeTool('a.x', 'a'), makeTool('b.y', 'b')],
      activeModules: ['a', 'b'],
    })
    const outcome = await dispatch(['tool', 'list', '--module', 'b'], kernel)

    expect((outcome.data as Array<{ name: string }>).map((t) => t.name)).toEqual(['b.y'])
  })
})

describe('ee tool run', () => {
  it('executes the named tool with parsed JSON input and the resolved principal', async () => {
    const kernel = makeFakeKernel()
    const outcome = await dispatch(
      ['tool', 'run', 'memory.echo', '--input', '{"thought":"hi"}'],
      kernel,
    )

    expect(outcome.exitCode).toBe(0)
    expect(kernel.calls).toHaveLength(1)
    expect(kernel.calls[0]).toMatchObject({
      name: 'memory.echo',
      input: { thought: 'hi' },
    })
    expect(kernel.calls[0].ctx.principal.id).toBe('principal-1')
  })

  it('maps invalid JSON to exit 1 with code invalid_json', async () => {
    const outcome = await dispatch(['tool', 'run', 'x', '--input', '{broken'])
    expect(outcome.exitCode).toBe(1)
    expect(outcome).toMatchObject({ error: { code: 'invalid_json' } })
  })

  it('maps approval_required to exit 3 and includes the pending approval id when available', async () => {
    const pending: ApprovalRequest = {
      id: 'appr-77',
      toolName: 'email.send_mail',
      input: {},
      principalId: 'principal-1',
      status: 'pending',
    }
    const kernel = makeFakeKernel({
      execute: async (name) => {
        if (name === 'email.send_mail') {
          throw new KernelError('approval_required', `tool ${name} requires approval`)
        }
        return {}
      },
    })
    await kernel.approvalStore.create(pending)

    const outcome = await dispatch(['tool', 'run', 'email.send_mail', '--input', '{}'], kernel)
    expect(outcome.exitCode).toBe(3)
    expect(outcome).toMatchObject({
      error: { code: 'approval_required', approvalId: 'appr-77' },
    })
  })

  it('omits the approval id when the store has none (message only)', async () => {
    const kernel = makeFakeKernel({
      execute: async () => {
        throw new KernelError('approval_required', 'tool email.send_mail requires approval')
      },
    })
    const outcome = await dispatch(['tool', 'run', 'email.send_mail', '--input', '{}'], kernel)

    expect(outcome.exitCode).toBe(3)
    expect(outcome.exitCode === 3 && outcome.error.approvalId).toBeUndefined()
  })

  it('surfaces permission_denied with its code at exit 1', async () => {
    const kernel = makeFakeKernel({
      execute: async () => {
        throw new KernelError('permission_denied', 'principal is not permitted')
      },
    })
    const outcome = await dispatch(['tool', 'run', 'email.send_mail', '--input', '{}'], kernel)

    expect(outcome.exitCode).toBe(1)
    expect(outcome).toMatchObject({ error: { code: 'permission_denied' } })
  })

  it('maps non-kernel errors to code "error" at exit 1', async () => {
    const kernel = makeFakeKernel({
      execute: async () => {
        throw new Error('unknown module: ghost')
      },
    })
    const outcome = await dispatch(['module', 'activate', 'ghost'], kernel)

    expect(outcome.exitCode).toBe(1)
    expect(outcome).toMatchObject({ error: { code: 'error', message: 'unknown module: ghost' } })
  })
})

describe('ee module', () => {
  it('activate/deactivate route to the kernel.module_* tools with { module_id }', async () => {
    const kernel = makeFakeKernel()
    await dispatch(['module', 'activate', 'memory'], kernel)
    await dispatch(['module', 'deactivate', 'memory'], kernel)

    expect(kernel.calls.map((c) => [c.name, c.input])).toEqual([
      ['kernel.module_activate', { module_id: 'memory' }],
      ['kernel.module_deactivate', { module_id: 'memory' }],
    ])
  })

  it('lists modules via kernel.module_list', async () => {
    const kernel = makeFakeKernel()
    await dispatch(['module', 'list'], kernel)
    expect(kernel.calls[0].name).toBe('kernel.module_list')
  })
})

describe('ee approvals', () => {
  it('list passes the optional --status through', async () => {
    const kernel = makeFakeKernel()
    await dispatch(['approvals', 'list'], kernel)
    await dispatch(['approvals', 'list', '--status', 'denied'], kernel)

    expect(kernel.calls.map((c) => [c.name, c.input])).toEqual([
      ['kernel.approvals_list', {}],
      ['kernel.approvals_list', { status: 'denied' }],
    ])
  })

  it('decide maps --approve/--deny to the decision enum', async () => {
    const kernel = makeFakeKernel()
    await dispatch(['approvals', 'decide', 'id-1', '--approve'], kernel)
    await dispatch(['approvals', 'decide', 'id-2', '--deny'], kernel)

    expect(kernel.calls.map((c) => [c.name, c.input])).toEqual([
      ['kernel.approvals_decide', { approval_id: 'id-1', decision: 'approved' }],
      ['kernel.approvals_decide', { approval_id: 'id-2', decision: 'denied' }],
    ])
  })
})

describe('ee openapi', () => {
  it('returns an OpenAPI document over the registry surface', async () => {
    const kernel = makeFakeKernel()
    const outcome = await dispatch(['openapi'], kernel)

    expect(outcome.exitCode).toBe(0)
    expect((outcome.data as { openapi: string }).openapi).toBe('3.1.0')
  })
})

describe('unknown commands', () => {
  it('fail with usage at exit 1', async () => {
    const outcome = await dispatch(['wat'])
    expect(outcome.exitCode).toBe(1)
    expect(outcome).toMatchObject({ error: { code: 'usage' } })
  })
})

describe('renderOutcome', () => {
  it('renders success data as JSON when --json is set', () => {
    const outcome: CommandOutcome = { exitCode: 0, data: { modules: [] } }
    const rendered = renderOutcome(outcome, true)
    expect(rendered.stdout).toBe(JSON.stringify({ modules: [] }, null, 2))
    expect(rendered.stderr).toBe('')
  })

  it('renders module lists as human-readable lines by default', () => {
    const outcome: CommandOutcome = {
      exitCode: 0,
      data: [{ id: 'memory', name: 'Memory', version: '0.1.0', tools: ['a', 'b'], active: true }],
    }
    const rendered = renderOutcome(outcome, false)
    expect(rendered.stdout).toMatch(/memory/)
    expect(rendered.stdout).toMatch(/active/)
  })

  it('renders errors as structured JSON on stderr', () => {
    const outcome: CommandOutcome = {
      exitCode: 3,
      error: { code: 'approval_required', message: 'awaiting approval', approvalId: 'appr-1' },
    }
    const rendered = renderOutcome(outcome, false)
    expect(rendered.stdout).toBe('')
    const payload = JSON.parse(rendered.stderr)
    expect(payload).toEqual({
      code: 'approval_required',
      message: 'awaiting approval',
      approvalId: 'appr-1',
    })
  })
})
