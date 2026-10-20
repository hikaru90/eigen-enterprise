import type { PiRunner, PiRunResult } from './runner'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { orchestratorManifest } from '../manifest'
import { DEV_AGENT_TOOL_NAMES, createDevAgentEngine } from './index'
import { VERIFY_TARGETS, type CommandResult, type CommandRunner, type CommandSpec } from './runner'
import { InMemoryDevAgentRunStore } from './store'
import { DevAgentEngine, createDevAgentTools } from './tools'

const ctxOwner: ToolContext = {
  principal: { id: 'owner-1', kind: 'human', roles: ['owner'] },
  requestId: 'req-owner',
}
const ctxAgent: ToolContext = {
  principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] },
  requestId: 'req-agent',
}
const ctxAdmin: ToolContext = {
  principal: { id: 'admin-1', kind: 'human', roles: ['admin'] },
  requestId: 'req-admin',
}

class FakeCommands implements CommandRunner {
  readonly calls: CommandSpec[] = []
  killAllCount = 0
  private readonly queue: CommandResult[] = []
  private readonly matchers: Array<{
    match: (spec: CommandSpec) => boolean
    result: CommandResult
  }> = []

  push(...results: CommandResult[]): this {
    this.queue.push(...results)
    return this
  }

  /** Fail only the commands matching the predicate (rev-parse etc. stay green). */
  failWhen(match: (spec: CommandSpec) => boolean, result: CommandResult): this {
    this.matchers.push({ match, result })
    return this
  }

  /** Git commands in call order, as `git <subcommand> <args…>`. */
  gitCalls(): string[] {
    return this.calls
      .filter((call) => call.cmd === 'git')
      .map((call) => ['git', ...call.args].join(' '))
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec)
    const matched = this.matchers.find((entry) => entry.match(spec))
    if (matched) return matched.result
    return this.queue.shift() ?? { exitCode: 0, stdout: '/repo\n', stderr: '' }
  }

  async killAll(): Promise<void> {
    this.killAllCount++
  }
}

class FakePi implements PiRunner {
  readonly calls: Array<{ task: string; cwd: string }> = []
  hangNext = false
  private readonly scripted: PiRunResult[] = []
  private pending: Array<(result: PiRunResult) => void> = []

  fails(output = 'pi blew up'): this {
    this.scripted.push({ ok: false, output, durationMs: 5 })
    return this
  }

  async run(task: string, cwd: string): Promise<PiRunResult> {
    this.calls.push({ task, cwd })
    if (this.hangNext) {
      this.hangNext = false
      return new Promise<PiRunResult>((resolve) => {
        this.pending.push(resolve)
      })
    }
    return this.scripted.shift() ?? { ok: true, output: 'pi done', durationMs: 10 }
  }

  /** Simulates the killed pi process settling. */
  resolvePending(result: PiRunResult): void {
    for (const resolve of this.pending.splice(0)) resolve(result)
  }
}

type Harness = {
  store: InMemoryDevAgentRunStore
  commands: FakeCommands
  pi: FakePi
  sink: InMemoryEventSink
  engine: DevAgentEngine
}

function makeEngine(overrides: Partial<ConstructorParameters<typeof DevAgentEngine>[0]> = {}): Harness {
  const store = new InMemoryDevAgentRunStore()
  const commands = new FakeCommands()
  const pi = new FakePi()
  const sink = new InMemoryEventSink()
  const engine = new DevAgentEngine({ store, commands, pi, eventSink: sink, baseCwd: '/repo', ...overrides })
  return { store, commands, pi, sink, engine }
}

async function waitForStatus(
  store: InMemoryDevAgentRunStore,
  runId: string,
  status: string,
): Promise<void> {
  await vi.waitFor(async () => {
    const run = await store.get(runId)
    expect(run?.status).toBe(status)
  })
}

function devAgentEvents(sink: InMemoryEventSink): Array<{ type: string; payload: unknown }> {
  return sink.events
    .filter((event) => event.type.startsWith('dev-agent.'))
    .map((event) => ({ type: event.type, payload: event.payload }))
}

describe('dev-agent namespace (folded into the internal orchestrator module)', () => {
  it('the orchestrator module owns the `dev-agent` namespace and every dev-agent tool name, unchanged', () => {
    expect(orchestratorManifest.id).toBe('orchestrator')
    expect(orchestratorManifest.internal).toBe(true)
    expect(orchestratorManifest.toolNamespaces).toContain('dev-agent')
    expect(orchestratorManifest.tools).toEqual(expect.arrayContaining([...DEV_AGENT_TOOL_NAMES]))
    expect([...DEV_AGENT_TOOL_NAMES].every((name) => name.startsWith('dev-agent.'))).toBe(true)
  })
})

describe('DevAgentEngine lifecycle', () => {
  it('happy path: dispatch -> running -> green with sandbox + verification calls', async () => {
    const { store, commands, pi, sink, engine } = makeEngine()

    const dispatched = await engine.dispatch('Add a rate limiter.', 'agent-1')
    expect(dispatched.status).toBe('dispatched')
    const runId = dispatched.runId

    // dispatch resolves before the sandbox work; the row exists immediately
    const created = await store.get(runId)
    expect(created).toMatchObject({ status: 'dispatched', branch: `wt/da/${runId}` })
    expect(devAgentEvents(sink)).toEqual([{ type: 'dev-agent.dispatched', payload: { runId } }])

    await engine.settle()

    const run = await store.get(runId)
    expect(run).toMatchObject({
      status: 'green',
      green: true,
      error: null,
      finishedAt: expect.any(String),
    })
    expect(run?.resultSummary).toContain('verification: vitest exit 0, check exit 0')
    expect(run?.resultSummary).toContain('pi done')
    expect(run?.resultSummary!.length).toBeLessThanOrEqual(4000)

    // sandbox: repo root resolved from baseCwd, worktree created in the MAIN repo
    expect(commands.calls[0]).toEqual({
      cmd: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: '/repo',
    })
    expect(commands.gitCalls()).toEqual([
      'git rev-parse --show-toplevel',
      `git worktree add /ee-da-${runId} -b wt/da/${runId}`,
    ])
    // pi runs headlessly inside the worktree
    expect(pi.calls).toEqual([{ task: 'Add a rate limiter.', cwd: `/ee-da-${runId}` }])
    // verification gate runs inside the worktree
    const verifyCalls = commands.calls.filter((call) => call.cmd === 'npx' || call.cmd === 'npm')
    expect(verifyCalls).toEqual([
      { cmd: 'npx', args: ['vitest', 'run', ...VERIFY_TARGETS], cwd: `/ee-da-${runId}` },
      { cmd: 'npm', args: ['run', 'check'], cwd: `/ee-da-${runId}` },
    ])

    expect(devAgentEvents(sink)).toEqual([
      { type: 'dev-agent.dispatched', payload: { runId } },
      { type: 'dev-agent.completed', payload: { runId, green: true, ok: true } },
    ])
  })

  it('enforces single-flight: a second dispatch while one is active is run_in_progress', async () => {
    const { engine } = makeEngine()

    const first = engine.dispatch('first task', 'agent-1')
    const second = engine.dispatch('second task', 'owner-1')
    await expect(second).rejects.toMatchObject({ code: 'run_in_progress' })
    await first
    await engine.settle()

    // after the run finished, dispatch works again
    await expect(engine.dispatch('next task', 'agent-1')).resolves.toMatchObject({
      status: 'dispatched',
    })
    await engine.settle()
  })

  it('pi failure marks the run failed (never red/green) and completes with ok:false', async () => {
    const { store, pi, sink, engine } = makeEngine()
    pi.fails('pi exploded halfway')

    const { runId } = await engine.dispatch('task', 'agent-1')
    await engine.settle()

    const run = await store.get(runId)
    expect(run).toMatchObject({
      status: 'failed',
      green: false,
      error: 'pi exited non-zero',
      resultSummary: 'pi exploded halfway',
      finishedAt: expect.any(String),
    })
    // no verification ran after a failed pi
    expect(commandsCallsOutsideSandbox(setupOf(engine))).toHaveLength(0)
    expect(devAgentEvents(sink)).toEqual([
      { type: 'dev-agent.dispatched', payload: { runId } },
      { type: 'dev-agent.completed', payload: { runId, green: false, ok: false } },
    ])
  })

  it('verification failure marks the run red (pi was ok)', async () => {
    const { store, commands, engine } = makeEngine()
    commands.failWhen((spec) => spec.cmd === 'npx', { exitCode: 1, stdout: '', stderr: '2 failed' })

    const { runId } = await engine.dispatch('task', 'agent-1')
    await engine.settle()

    expect(await store.get(runId)).toMatchObject({ status: 'red', green: false, error: null })
    expect(await store.get(runId)).toMatchObject({ resultSummary: expect.stringContaining('vitest exit 1') })
  })

  it('typecheck failure also marks the run red', async () => {
    const { store, commands, engine } = makeEngine()
    commands.failWhen((spec) => spec.cmd === 'npm', { exitCode: 2, stdout: '', stderr: 'check failed' })

    const { runId } = await engine.dispatch('task', 'agent-1')
    await engine.settle()

    expect(await store.get(runId)).toMatchObject({ status: 'red', green: false })
  })

  it('sandbox setup failure (worktree add) marks the run failed with the git error', async () => {
    const { store, commands, engine } = makeEngine()
    commands.failWhen(
      (spec) => spec.cmd === 'git' && spec.args[0] === 'worktree',
      { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' },
    )

    const { runId } = await engine.dispatch('task', 'agent-1')
    await engine.settle()

    const run = await store.get(runId)
    expect(run?.status).toBe('failed')
    expect(run?.error).toContain('not a git repository')
  })

  it('merge requires green, merges in the MAIN repo, cleans up, and emits merged', async () => {
    const { store, commands, sink, engine } = makeEngine()
    const { runId } = await engine.dispatch('task', 'agent-1')
    await engine.settle()
    commands.calls.length = 0

    const merged = await engine.merge(runId, 'owner-1')
    expect(merged).toEqual({ runId, branch: `wt/da/${runId}`, status: 'merged' })
    expect(commands.gitCalls()).toEqual([
      'git rev-parse --show-toplevel',
      `git merge --no-edit wt/da/${runId}`,
      `git worktree remove /ee-da-${runId}`,
      `git branch -d wt/da/${runId}`,
    ])
    for (const call of commands.calls) expect(call.cwd).toBe('/repo')
    expect(await store.get(runId)).toMatchObject({ status: 'merged', finishedAt: expect.any(String) })
    expect(devAgentEvents(sink).at(-1)).toEqual({ type: 'dev-agent.merged', payload: { runId } })
  })

  it('merge on a non-green run fails loud and leaves the run untouched', async () => {
    const { store, pi, engine } = makeEngine()
    pi.fails()

    const { runId } = await engine.dispatch('task', 'agent-1')
    await engine.settle()

    await expect(engine.merge(runId, 'owner-1')).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('requires a green run'),
    })
    expect(await store.get(runId)).toMatchObject({ status: 'failed' })
  })

  it('a git failure during merge is loud and the run stays green (retryable)', async () => {
    const { store, commands, engine } = makeEngine()
    const { runId } = await engine.dispatch('task', 'agent-1')
    await engine.settle()
    commands.failWhen((spec) => spec.cmd === 'git' && spec.args[0] === 'merge', {
      exitCode: 1,
      stdout: '',
      stderr: 'conflict in src/x.ts',
    })

    await expect(engine.merge(runId, 'owner-1')).rejects.toThrow(/git merge failed.*conflict/)
    // the failed merge left the run exactly as the verification gate left it
    expect(await store.get(runId)).toMatchObject({ status: 'green' })
    // nothing was cleaned up after the failed merge: sandbox commands + merge, no remove/branch -d
    expect(commands.gitCalls()).toEqual([
      'git rev-parse --show-toplevel',
      `git worktree add /ee-da-${runId} -b wt/da/${runId}`,
      'git rev-parse --show-toplevel',
      `git merge --no-edit wt/da/${runId}`,
    ])
  })

  it('abort while running kills pi, cleans the sandbox up, and emits aborted', async () => {
    const { store, commands, pi, sink, engine } = makeEngine()
    pi.hangNext = true

    const { runId } = await engine.dispatch('task', 'agent-1')
    await waitForStatus(store, runId, 'running')

    const abortPromise = engine.abort(runId, 'owner-1')
    // the kill surfaces as a settled (failed) pi process
    pi.resolvePending({ ok: false, output: 'killed', durationMs: 1 })
    await abortPromise

    expect(commands.killAllCount).toBe(1)
    expect(await store.get(runId)).toMatchObject({
      status: 'aborted',
      finishedAt: expect.any(String),
    })
    expect(commands.gitCalls()).toContain(`git worktree remove --force /ee-da-${runId}`)
    expect(commands.gitCalls()).toContain(`git branch -D wt/da/${runId}`)
    expect(devAgentEvents(sink).at(-1)).toEqual({ type: 'dev-agent.aborted', payload: { runId } })
  })

  it('abort after a terminal state cleans the worktree up', async () => {
    const { store, commands, engine } = makeEngine()
    const { runId } = await engine.dispatch('task', 'agent-1')
    await engine.settle()
    commands.calls.length = 0

    await expect(engine.abort(runId, 'admin-1')).resolves.toMatchObject({
      runId,
      status: 'aborted',
    })
    expect(commands.gitCalls()).toEqual([
      'git rev-parse --show-toplevel',
      `git worktree remove --force /ee-da-${runId}`,
      `git branch -D wt/da/${runId}`,
    ])
    expect(await store.get(runId)).toMatchObject({ status: 'aborted' })
  })

  it('abort is rejected for dispatched, merged and already aborted runs', async () => {
    const { pi, engine } = makeEngine()
    pi.hangNext = true
    const { runId } = await engine.dispatch('task', 'agent-1')

    // dispatched: the sandbox worktree does not exist yet — no abort edge
    await expect(engine.abort(runId, 'owner-1')).rejects.toMatchObject({ code: 'invalid_input' })

    pi.resolvePending({ ok: true, output: 'pi done', durationMs: 1 })
    await engine.settle()
    await engine.merge(runId, 'owner-1')
    await expect(engine.abort(runId, 'owner-1')).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('status returns one run by id or all runs; logs returns the full row', async () => {
    const { engine } = makeEngine()
    const a = await engine.dispatch('task a', 'agent-1')
    await engine.settle()

    await expect(engine.status(a.runId)).resolves.toMatchObject({ id: a.runId })
    const all = await engine.status()
    expect(Array.isArray(all)).toBe(true)
    expect((all as Array<{ id: string }>)[0]?.id).toBe(a.runId)
    await expect(engine.logs(a.runId)).resolves.toMatchObject({
      id: a.runId,
      resultSummary: expect.any(String),
    })
    await expect(engine.logs(randomUUID())).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(engine.status(randomUUID())).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

/** Helper for the pi-failure test: verify/ sandbox commands must not run. */
function setupOf(engine: DevAgentEngine): Harness['commands'] {
  return (engine as unknown as { commands: FakeCommands }).commands
}
function commandsCallsOutsideSandbox(commands: FakeCommands): CommandSpec[] {
  return commands.calls.filter((call) => call.cmd !== 'git')
}

describe('createDevAgentTools descriptors', () => {
  const tools = createDevAgentTools({ engine: makeEngine().engine })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  it('builds exactly the manifest tools with mission audit classes and roles', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([...DEV_AGENT_TOOL_NAMES].sort())
    expect(byName.get('dev-agent.dispatch')?.auditClass).toBe('external')
    expect(byName.get('dev-agent.dispatch')?.permission.roles).toEqual(['owner', 'agent'])
    expect(byName.get('dev-agent.status')?.auditClass).toBe('read')
    expect(byName.get('dev-agent.status')?.permission.roles).toEqual(['admin', 'agent'])
    expect(byName.get('dev-agent.logs')?.auditClass).toBe('read')
    expect(byName.get('dev-agent.logs')?.permission.roles).toEqual(['admin', 'agent'])
    expect(byName.get('dev-agent.merge')?.auditClass).toBe('mutate')
    expect(byName.get('dev-agent.merge')?.permission.roles).toEqual(['owner'])
    expect(byName.get('dev-agent.abort')?.auditClass).toBe('mutate')
    expect(byName.get('dev-agent.abort')?.permission.roles).toEqual(['owner', 'admin'])
    for (const tool of tools) {
      expect(tool.module).toBe('orchestrator')
    }
  })

  it('validates inputs with zod', () => {
    expect(
      byName.get('dev-agent.dispatch')?.inputSchema.safeParse({ task: 'do it' }).success,
    ).toBe(true)
    expect(byName.get('dev-agent.dispatch')?.inputSchema.safeParse({ task: '' }).success).toBe(false)
    expect(byName.get('dev-agent.dispatch')?.inputSchema.safeParse({}).success).toBe(false)

    const runId = randomUUID()
    expect(byName.get('dev-agent.merge')?.inputSchema.safeParse({ runId }).success).toBe(true)
    expect(byName.get('dev-agent.merge')?.inputSchema.safeParse({ runId: 'nope' }).success).toBe(
      false,
    )
    expect(byName.get('dev-agent.status')?.inputSchema.safeParse({}).success).toBe(true)
    expect(
      byName.get('dev-agent.status')?.inputSchema.safeParse({ runId }).success,
    ).toBe(true)
  })
})

describe('dev-agent tools through the kernel registry pipeline', () => {
  function makeRegistry() {
    const harness = makeEngine()
    const activations = new InMemoryActivationStore()
    const approvals = new InMemoryApprovalStore()
    const registry = new KernelRegistry({
      eventSink: harness.sink,
      activationStore: activations,
      approvalPolicy: new StaticApprovalPolicy(new Set()),
      approvalStore: approvals,
      vcsCommitter: null,
    })
    for (const descriptor of createDevAgentTools({ engine: harness.engine })) {
      registry.register(descriptor)
    }
    return { ...harness, activations, registry }
  }

  it('agent dispatches; permissions gate merge (owner-only) and abort (owner|admin)', async () => {
    const { registry, activations, store, engine } = makeRegistry()
    await activations.set('orchestrator', true)

    const result = await registry.execute('dev-agent.dispatch', { task: 'ship it' }, ctxAgent)
    expect(result).toMatchObject({ status: 'dispatched' })
    const runId = (result as { runId: string }).runId

    await engine.settle()
    await expect(store.get(runId)).resolves.toMatchObject({ status: 'green' })

    // agent may not merge (owner-only)
    await expect(
      registry.execute('dev-agent.merge', { runId }, ctxAgent),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    // agent may not abort either
    await expect(
      registry.execute('dev-agent.abort', { runId }, ctxAgent),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    // admin may abort, owner may merge
    await expect(registry.execute('dev-agent.abort', { runId }, ctxAdmin)).resolves.toMatchObject({
      status: 'aborted',
    })
    // the aborted run can no longer merge even for the owner
    await expect(
      registry.execute('dev-agent.merge', { runId }, ctxOwner),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('second dispatch during an active run is run_in_progress through the pipeline', async () => {
    const { registry, activations, engine } = makeRegistry()
    await activations.set('orchestrator', true)

    await registry.execute('dev-agent.dispatch', { task: 'one' }, ctxAgent)
    await expect(
      registry.execute('dev-agent.dispatch', { task: 'two' }, ctxOwner),
    ).rejects.toMatchObject({ code: 'run_in_progress' })
    await engine.settle()
  })

  it('read surfaces are admin/agent readable and carry full audit + dev-agent events', async () => {
    const { registry, activations, engine, sink } = makeRegistry()
    await activations.set('orchestrator', true)

    const { runId } = (await registry.execute(
      'dev-agent.dispatch',
      { task: 't' },
      ctxAgent,
    )) as { runId: string }
    await engine.settle()

    await expect(
      registry.execute('dev-agent.status', { runId }, ctxAdmin),
    ).resolves.toMatchObject({ id: runId, status: 'green' })
    await expect(registry.execute('dev-agent.logs', { runId }, ctxAgent)).resolves.toMatchObject({
      id: runId,
    })

    const audit = sink.events.filter((event) => event.type === 'tool.executed')
    expect(audit.map((event) => (event.payload as { tool: string }).tool)).toEqual([
      'dev-agent.dispatch',
      'dev-agent.status',
      'dev-agent.logs',
    ])
    const types = sink.events.map((event) => event.type)
    expect(types).toContain('dev-agent.dispatched')
    expect(types).toContain('dev-agent.completed')
  })

  it('module activation gates the surface (fail closed)', async () => {
    const { registry, activations } = makeRegistry()
    await activations.set('orchestrator', false)
    await expect(
      registry.execute('dev-agent.dispatch', { task: 't' }, ctxAgent),
    ).rejects.toMatchObject({ code: 'module_inactive' })
  })
})

describe('createDevAgentEngine default wiring', () => {
  it('composes production seams without spawning or connecting', () => {
    const sink = new InMemoryEventSink()
    const engine = createDevAgentEngine({ eventSink: sink })
    expect(engine).toBeInstanceOf(DevAgentEngine)
  })
})
