import type { WiredKernel } from '../../modules/index'
import type { CliDeps } from './index'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { StaticApprovalPolicy, InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import type { Principal, PrincipalStore } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import { InMemoryAgentSessionLog } from '$lib/kernel/session-log'
import type { ToolDescriptor } from '$lib/kernel/types'
import { runCli } from './index'

/**
 * Entry-pipeline tests against fully in-memory kernels. No process
 * execution: runCli returns rendered output + exit codes directly.
 */

const PRINCIPALS: Principal[] = [
  { id: 'principal-1', kind: 'human', roles: ['admin', 'owner'] },
  { id: 'principal-2', kind: 'human', roles: ['admin'] },
]

async function makeWiredFake(options: { approvalTools?: string[] } = {}): Promise<WiredKernel> {
  const activations = new InMemoryActivationStore()
  const modules = new ModuleRegistry(activations)
  modules.register({
    id: 'memory',
    name: 'Memory',
    version: '0.1.0',
    tools: ['memory.echo'],
    permissions: { roles: ['admin', 'agent'] },
  })
  modules.register({
    id: 'email',
    name: 'Email',
    version: '0.1.0',
    tools: ['email.send_mail'],
    permissions: { roles: ['admin', 'agent'] },
  })
  modules.register({
    id: 'fixture',
    name: 'Fixture',
    version: '0.1.0',
    tools: ['fixture.owner_only'],
    permissions: { roles: ['owner'] },
  })
  await activations.set('email', true)
  await activations.set('fixture', true)
  const approvalStore = new InMemoryApprovalStore()
  const registry = new KernelRegistry({
    activationStore: activations,
    approvalPolicy: new StaticApprovalPolicy(new Set(options.approvalTools ?? [])),
    approvalStore,
  })
  const echo: ToolDescriptor = {
    name: 'memory.echo',
    module: 'memory',
    summary: 'echoes its input',
    inputSchema: z.object({ value: z.string() }),
    permission: { roles: ['admin'] },
    auditClass: 'read',
    handler: async (_ctx, input) => ({ echoed: input }),
  }
  const sendMail: ToolDescriptor = {
    name: 'email.send_mail',
    module: 'email',
    summary: 'sends mail',
    inputSchema: z.object({ to: z.string() }),
    permission: { roles: ['admin'] },
    auditClass: 'mutate',
    handler: async () => ({ sent: true }),
  }
  const ownerOnly: ToolDescriptor = {
    name: 'fixture.owner_only',
    module: 'fixture',
    summary: 'owner-gated fixture for permission_denied mapping',
    inputSchema: z.object({}),
    permission: { roles: ['owner'] },
    auditClass: 'read',
    handler: async () => ({ ok: true }),
  }
  registry.register(echo)
  registry.register(sendMail)
  registry.register(ownerOnly)
  const principals: PrincipalStore = {
    getById: async (id) => PRINCIPALS.find((p) => p.id === id) ?? null,
    getByApiKey: async () => null,
  }
  return {
    registry,
    modules,
    activations,
    principals,
    approvals: approvalStore,
    eventSink: new InMemoryEventSink(),
    sessionLog: new InMemoryAgentSessionLog(),
  }
}

function depsWith(
  kernel: WiredKernel,
  tracked: WiredKernel[] = [],
  env: Record<string, string | undefined> = {},
): CliDeps {
  return {
    buildKernel: () => {
      tracked.push(kernel)
      return kernel
    },
    env,
  }
}

describe('runCli: argument failures happen before any kernel wiring', () => {
  it('prints usage and exits 1 on empty argv without building a kernel', async () => {
    const tracked: WiredKernel[] = []
    const result = await runCli([], depsWith(await makeWiredFake(), tracked))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/usage/i)
    expect(tracked).toHaveLength(0)
  })

  it('rejects unknown command groups without building a kernel', async () => {
    const tracked: WiredKernel[] = []
    const result = await runCli(['wat'], depsWith(await makeWiredFake(), tracked))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/unknown command group: wat/)
    expect(tracked).toHaveLength(0)
  })
})

describe('runCli: principal resolution', () => {
  it('fails loud naming both options when flag and env are absent', async () => {
    const result = await runCli(['status'], depsWith(await makeWiredFake()))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/--principal <id>/)
    expect(result.stderr).toMatch(/EE_CLI_PRINCIPAL_ID/)
  })

  it('resolves from the env when no flag is given', async () => {
    const kernel = await makeWiredFake()
    const result = await runCli(['status'], {
      buildKernel: () => kernel,
      env: { EE_CLI_PRINCIPAL_ID: 'principal-1' },
    })
    expect(result.exitCode).toBe(0)
  })

  it('the flag wins over the env', async () => {
    const kernel = await makeWiredFake()
    // principal-2 lacks the owner role: if the env (principal-1) were used,
    // the owner-gated fixture tool would succeed; with the flag (principal-2)
    // it must be denied.
    const result = await runCli(
      ['tool', 'run', 'fixture.owner_only', '--input', '{}', '--principal', 'principal-2'],
      {
        buildKernel: () => kernel,
        env: { EE_CLI_PRINCIPAL_ID: 'principal-1' },
      },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/permission_denied/)
  })

  it('fails loud on unknown principal ids', async () => {
    const result = await runCli(['status', '--principal', 'ghost'], depsWith(await makeWiredFake()))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/unknown principal: ghost/)
  })
})

describe('runCli: happy paths through the full registry pipeline', () => {
  it('registers the kernel admin tools and returns composed status as JSON', async () => {
    const kernel = await makeWiredFake()
    const result = await runCli(
      ['status', '--json'],
      depsWith(kernel, [], { EE_CLI_PRINCIPAL_ID: 'principal-1' }),
    )

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    const data = JSON.parse(result.stdout)
    expect(data.modules).toEqual([
      { id: 'memory', name: 'Memory', version: '0.1.0', tools: ['memory.echo'], active: false },
      { id: 'email', name: 'Email', version: '0.1.0', tools: ['email.send_mail'], active: true },
      { id: 'fixture', name: 'Fixture', version: '0.1.0', tools: ['fixture.owner_only'], active: true },
      {
        id: 'kernel',
        name: 'Kernel',
        version: '0.1.0',
        description:
          'Module activation and approval-decision administration for the kernel itself.',
        tools: [
          'kernel.module_list',
          'kernel.module_activate',
          'kernel.module_deactivate',
          'kernel.approvals_list',
          'kernel.approvals_decide',
        ],
        active: true,
      },
    ])
    expect(data.pendingApprovals).toEqual([])
    expect(kernel.registry.get('kernel.module_list')).toBeDefined()
    expect(kernel.registry.get('kernel.approvals_decide')).toBeDefined()
    expect(await kernel.activations.get('kernel')).toBe(true)
  })

  it('activates a module through kernel.module_activate and shows it in status', async () => {
    const kernel = await makeWiredFake()
    const env = { EE_CLI_PRINCIPAL_ID: 'principal-1' }
    const deps: CliDeps = { buildKernel: () => kernel, env }

    const activated = await runCli(['module', 'activate', 'memory'], deps)
    expect(activated.exitCode).toBe(0)

    const status = await runCli(['status', '--json'], deps)
    const data = JSON.parse(status.stdout)
    expect(data.modules[0].active).toBe(true)
  })

  it('renders human-readable module lines without --json', async () => {
    const kernel = await makeWiredFake()
    const result = await runCli(['module', 'list', '--principal', 'principal-1'], depsWith(kernel))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/memory/)
    expect(result.stdout).toMatch(/INACTIVE/)
  })
})

describe('runCli: error and approval exit-code mapping', () => {
  it('maps approval_required to exit 3 with the pending approval id, and lists it', async () => {
    const kernel = await makeWiredFake({ approvalTools: ['email.send_mail'] })
    const env = { EE_CLI_PRINCIPAL_ID: 'principal-1' }
    const deps: CliDeps = { buildKernel: () => kernel, env }

    const blocked = await runCli(
      ['tool', 'run', 'email.send_mail', '--input', '{"to":"a@example.com"}'],
      deps,
    )
    expect(blocked.exitCode).toBe(3)
    const error = JSON.parse(blocked.stderr)
    expect(error.code).toBe('approval_required')
    expect(typeof error.approvalId).toBe('string')

    const listed = await runCli(['approvals', 'list', '--status', 'pending', '--json'], deps)
    expect(listed.exitCode).toBe(0)
    expect(JSON.parse(listed.stdout)).toHaveLength(1)
  })

  it('decides a pending approval through the registry, then the tool runs', async () => {
    const kernel = await makeWiredFake({ approvalTools: ['email.send_mail'] })
    const env = { EE_CLI_PRINCIPAL_ID: 'principal-1' }
    const deps: CliDeps = { buildKernel: () => kernel, env }

    const blocked = await runCli(
      ['tool', 'run', 'email.send_mail', '--input', '{"to":"a@example.com"}'],
      deps,
    )
    const { approvalId } = JSON.parse(blocked.stderr)

    const decided = await runCli(['approvals', 'decide', approvalId, '--approve', '--json'], deps)
    expect(decided.exitCode).toBe(0)
    expect(JSON.parse(decided.stdout).status).toBe('approved')

    const run = await runCli(
      ['tool', 'run', 'email.send_mail', '--input', '{"to":"a@example.com"}'],
      deps,
    )
    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual({ sent: true })
  })

  it('maps module_inactive to exit 1 with its code', async () => {
    const kernel = await makeWiredFake()
    const result = await runCli(
      ['tool', 'run', 'memory.echo', '--input', '{"value":"x"}', '--principal', 'principal-1'],
      depsWith(kernel),
    )
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe('module_inactive')
  })

  it('maps permission_denied to exit 1 with its code', async () => {
    const kernel = await makeWiredFake()
    const result = await runCli(
      [
        'tool',
        'run',
        'fixture.owner_only',
        '--input',
        '{}',
        '--principal',
        'principal-2',
        '--json',
      ],
      depsWith(kernel),
    )
    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe('permission_denied')
  })
})
