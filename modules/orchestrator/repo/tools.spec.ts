import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { TIMEOUT_EXIT_CODE } from '$lib/kernel/pi-engine'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { orchestratorManifest } from '../manifest'
import { REPO_TOOL_NAMES, createRepoEngine } from './index'
import { REPO_VERIFY_TARGETS, type CommandResult, type CommandRunner, type CommandSpec } from './runner'
import { RepoEngine, createRepoTools } from './tools'

const ctxAgent: ToolContext = {
  principal: { id: 'agent-1', kind: 'agent', roles: ['agent'] },
  requestId: 'req-agent',
}
const ctxAdmin: ToolContext = {
  principal: { id: 'admin-1', kind: 'human', roles: ['admin'] },
  requestId: 'req-admin',
}
const ctxOwner: ToolContext = {
  principal: { id: 'owner-1', kind: 'human', roles: ['owner'] },
  requestId: 'req-owner',
}

class FakeCommands implements CommandRunner {
  readonly calls: CommandSpec[] = []
  private readonly queue: CommandResult[] = []
  private readonly matchers: Array<{
    match: (spec: CommandSpec) => boolean
    result: CommandResult
  }> = []

  push(...results: CommandResult[]): this {
    this.queue.push(...results)
    return this
  }

  failWhen(match: (spec: CommandSpec) => boolean, result: CommandResult): this {
    this.matchers.push({ match, result })
    return this
  }

  /** Commands in call order as `cmd arg arg…` strings. */
  lines(): string[] {
    return this.calls.map((call) => [call.cmd, ...call.args].join(' '))
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec)
    const matched = this.matchers.find((entry) => entry.match(spec))
    if (matched) return matched.result
    return this.queue.shift() ?? { exitCode: 0, stdout: '/repo\n', stderr: '' }
  }

  async killAll(): Promise<void> {}
}

type Harness = {
  commands: FakeCommands
  sink: InMemoryEventSink
  engine: RepoEngine
}

function makeEngine(overrides: Partial<ConstructorParameters<typeof RepoEngine>[0]> = {}): Harness {
  const commands = new FakeCommands()
  const sink = new InMemoryEventSink()
  const engine = new RepoEngine({ commands, eventSink: sink, baseCwd: '/repo', ...overrides })
  return { commands, sink, engine }
}

function repoEvents(sink: InMemoryEventSink): Array<{ type: string; payload: unknown }> {
  return sink.events
    .filter((event) => event.type.startsWith('repo.'))
    .map((event) => ({ type: event.type, payload: event.payload }))
}

describe('repo namespace (folded into the internal orchestrator module)', () => {
  it('the orchestrator module owns the `repo` namespace and every repo tool name, unchanged', () => {
    expect(orchestratorManifest.id).toBe('orchestrator')
    expect(orchestratorManifest.internal).toBe(true)
    expect(orchestratorManifest.toolNamespaces).toContain('repo')
    expect(orchestratorManifest.tools).toEqual(expect.arrayContaining([...REPO_TOOL_NAMES]))
    expect([...REPO_TOOL_NAMES].every((name) => name.startsWith('repo.'))).toBe(true)
  })
})

describe('RepoEngine.worktreeCreate', () => {
  it('creates ee-agent-<id> on a wt/agent-<id> branch in the MAIN repo and emits the event', async () => {
    const { commands, sink, engine } = makeEngine()

    const result = await engine.worktreeCreate('agent-1')

    expect(result.created).toBe(true)
    expect(result.branch).toMatch(/^wt\/agent-[0-9a-f]{8}$/)
    expect(result.path).toBe(`/ee-agent-${result.branch.slice('wt/agent-'.length)}`)
    expect(commands.lines()).toEqual([
      'git rev-parse --show-toplevel',
      `git worktree add ${result.path} -b ${result.branch}`,
    ])
    for (const call of commands.calls) expect(call.cwd).toBe('/repo')
    expect(repoEvents(sink)).toEqual([
      {
        type: 'repo.worktree_created',
        payload: { id: result.branch.slice('wt/agent-'.length), path: result.path, branch: result.branch },
      },
    ])
  })

  it('is idempotent per calling principal: the second call returns the same worktree, created:false, no git calls', async () => {
    const { commands, engine } = makeEngine()

    const first = await engine.worktreeCreate('agent-1')
    commands.calls.length = 0
    const second = await engine.worktreeCreate('agent-1')

    expect(second).toEqual({ created: false, path: first.path, branch: first.branch })
    expect(commands.calls).toHaveLength(0)
  })

  it('tracks worktrees per principal — a different principal gets its own worktree', async () => {
    const { engine } = makeEngine()

    const a = await engine.worktreeCreate('agent-1')
    const b = await engine.worktreeCreate('agent-2')

    expect(b.created).toBe(true)
    expect(b.path).not.toBe(a.path)
  })

  it('fails loud with the git stderr when worktree add fails', async () => {
    const { commands, engine } = makeEngine()
    commands.failWhen(
      (spec) => spec.cmd === 'git' && spec.args[0] === 'worktree',
      { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' },
    )

    await expect(engine.worktreeCreate('agent-1')).rejects.toThrow(
      /git worktree add failed.*not a git repository/,
    )
  })
})

describe('RepoEngine.run', () => {
  it('executes an allowlisted command in the worktree and returns the result', async () => {
    const { commands, sink, engine } = makeEngine()
    commands.push({ exitCode: 0, stdout: 'all green\n', stderr: '' })

    const result = await engine.run('agent-1', '/repo/wt', 'npx vitest run modules/repo')

    expect(result).toEqual({ exitCode: 0, stdout: 'all green\n', stderr: '', truncated: false })
    const spec = commands.calls.at(-1)!
    expect(spec).toEqual({
      cmd: 'npx',
      args: ['vitest', 'run', 'modules/repo'],
      cwd: '/repo/wt',
      timeoutMs: 10 * 60 * 1000,
    })
    expect(repoEvents(sink)).toEqual([
      { type: 'repo.command_run', payload: { command: 'npx vitest run modules/repo', exitCode: 0 } },
    ])
  })

  it('returns non-zero exits as results (the agent must see failures), never throws them', async () => {
    const { commands, engine } = makeEngine()
    commands.push({ exitCode: 1, stdout: '', stderr: '2 failed' })

    await expect(engine.run('agent-1', '/repo/wt', 'npm test')).resolves.toMatchObject({
      exitCode: 1,
    })
  })

  it('emits command + exitCode only — never stdout/stderr content', async () => {
    const { commands, sink, engine } = makeEngine()
    commands.push({ exitCode: 3, stdout: 'SECRET-OUTPUT', stderr: 'SECRET-ERR' })

    await engine.run('agent-1', '/repo/wt', 'git status')

    const event = repoEvents(sink)[0] as { payload: Record<string, unknown> }
    expect(event.type).toBe('repo.command_run')
    expect(Object.keys(event.payload).sort()).toEqual(['command', 'exitCode'])
    expect(JSON.stringify(repoEvents(sink))).not.toContain('SECRET-OUTPUT')
  })

  it('truncates oversized output loud: truncated flag on, content cut to the cap', async () => {
    const { commands, engine } = makeEngine()
    commands.push({ exitCode: 0, stdout: 'x'.repeat(10_000), stderr: '' })

    const result = await engine.run('agent-1', '/repo/wt', 'npm test')

    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBeLessThanOrEqual(4000)
    expect(result.stdout.endsWith('…')).toBe(true)
  })

  it('fails loud on a command timeout (infra error, not a result)', async () => {
    const { commands, engine } = makeEngine()
    commands.push({ exitCode: TIMEOUT_EXIT_CODE, stdout: '', stderr: '[spawn] timed out' })

    await expect(engine.run('agent-1', '/repo/wt', 'npm test')).rejects.toThrow(/timed out/)
  })

  it('rejects non-allowlisted commands with invalid_input naming the allowlist, without spawning', async () => {
    const { commands, engine } = makeEngine()

    await expect(engine.run('agent-1', '/repo/wt', 'rm -rf /')).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('allowlist'),
    })
    await expect(engine.run('agent-1', '/repo/wt', 'npm test; rm -rf /')).rejects.toMatchObject({
      code: 'invalid_input',
    })
    expect(commands.calls).toHaveLength(0)
  })

  it('resolves mkdir/cp/mv targets against the worktree and rejects escapes at the engine seam', async () => {
    const { commands, engine } = makeEngine()

    await expect(engine.run('agent-1', '/repo/wt', 'mkdir ../escape')).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('unsafe fs argument'),
    })
    expect(commands.calls).toHaveLength(0)

    commands.push({ exitCode: 0, stdout: '', stderr: '' })
    await engine.run('agent-1', '/repo/wt', 'mkdir src/new-dir')
    expect(commands.calls.at(-1)).toMatchObject({ cmd: 'mkdir', args: ['src/new-dir'], cwd: '/repo/wt' })
  })
})

describe('RepoEngine.writeFile / readFile', () => {
  let wt: string

  afterEach(async () => {
    if (wt) await rm(wt, { recursive: true, force: true })
  })

  async function makeRealWorktree(): Promise<string> {
    wt = await mkdtemp(path.join(tmpdir(), 'ee-repo-spec-'))
    return wt
  }

  it('writes files (mkdir -p semantics) and emits file_written with the path only', async () => {
    const worktreePath = await makeRealWorktree()
    const { sink, engine } = makeEngine()

    const result = await engine.writeFile('agent-1', worktreePath, 'src/deep/dir/new.ts', 'export {}\n')

    expect(result).toEqual({ path: 'src/deep/dir/new.ts' })
    await expect(readFile(path.join(worktreePath, 'src/deep/dir/new.ts'), 'utf8')).resolves.toBe(
      'export {}\n',
    )
    expect(repoEvents(sink)).toEqual([
      { type: 'repo.file_written', payload: { path: 'src/deep/dir/new.ts' } },
    ])
  })

  it('reads files back', async () => {
    const worktreePath = await makeRealWorktree()
    await writeFile(path.join(worktreePath, 'note.txt'), 'hello', 'utf8')
    const { engine } = makeEngine()

    await expect(engine.readFile(worktreePath, 'note.txt')).resolves.toEqual({ content: 'hello' })
  })

  it('rejects path escapes and secret paths for writes and reads, loud, before touching the fs', async () => {
    const worktreePath = await makeRealWorktree()
    const { sink, engine } = makeEngine()

    for (const sub of ['../escape.ts', '/etc/hosts', '.env', 'config/.env.local', 'certs/server.key', 'certs/server.pem']) {
      await expect(
        engine.writeFile('agent-1', worktreePath, sub, 'x'),
        `write ${sub}`,
      ).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(engine.readFile(worktreePath, sub), `read ${sub}`).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
    expect(repoEvents(sink)).toEqual([])
  })
})

describe('RepoEngine.merge', () => {
  const wt = '/ee-agent-abc123ab'

  function harnessForVerification(vitestExit = 0, checkExit = 0): Harness {
    const harness = makeEngine()
    harness.commands.failWhen((spec) => spec.cmd === 'git' && spec.args[0] === 'rev-parse', {
      exitCode: 0,
      stdout: '/repo\n',
      stderr: '',
    })
    harness.commands.failWhen(
      (spec) => spec.cmd === 'npx',
      { exitCode: vitestExit, stdout: vitestExit === 0 ? '' : '', stderr: vitestExit === 0 ? '' : '2 failed' },
    )
    harness.commands.failWhen(
      (spec) => spec.cmd === 'npm',
      { exitCode: checkExit, stdout: '', stderr: checkExit === 0 ? '' : 'check failed' },
    )
    return harness
  }

  it('verifies, commits pending changes, merges, cleans up, and emits repo.merged', async () => {
    const { commands, sink, engine } = harnessForVerification()
    await engine.worktreeCreate('agent-1')
    commands.push({ exitCode: 0, stdout: ' M src/x.ts\n', stderr: '' }) // git status --porcelain
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git add -A
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git commit -m
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git merge --no-edit
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git worktree remove
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git branch -d
    commands.push({ exitCode: 0, stdout: '[fix] add thing\n', stderr: '' }) // git log -1 --format=%s

    const result = await engine.merge('agent-1', wt, '[fix] add thing')

    expect(result).toEqual({ verified: true, committed: true, merged: true, commitSubject: '[fix] add thing' })
    expect(commands.lines()).toEqual([
      'git rev-parse --show-toplevel',
      expect.stringMatching(/^git worktree add/),
      // merge re-resolves the repo root, then verifies INSIDE the worktree
      'git rev-parse --show-toplevel',
      `npx vitest run ${REPO_VERIFY_TARGETS.join(' ')}`,
      'npm run check',
      `git status --porcelain`,
      `git add -A`,
      `git commit -m [fix] add thing`,
      'git merge --no-edit wt/agent-abc123ab',
      `git worktree remove ${wt}`,
      'git branch -d wt/agent-abc123ab',
      'git log -1 --format=%s',
    ])
    const verifyCalls = commands.calls.filter((c) => c.cmd === 'npx' || c.cmd === 'npm')
    for (const call of verifyCalls) expect(call.cwd).toBe(wt)
    const mergeCalls = commands.calls.filter((c) => c.cmd === 'git' && ['merge', 'worktree', 'branch'].includes(c.args[0]!))
    for (const call of mergeCalls) expect(call.cwd).toBe('/repo')
    expect(repoEvents(sink).at(-1)).toEqual({
      type: 'repo.merged',
      payload: { path: wt, branch: 'wt/agent-abc123ab', commitSubject: '[fix] add thing' },
    })
    // the engine releases its worktree slot: the next create is fresh
    const next = await engine.worktreeCreate('agent-1')
    expect(next.created).toBe(true)
    expect(next.path).not.toBe(wt)
  })

  it('skips the commit cleanly when the worktree has nothing to commit (states it in output)', async () => {
    const { commands, engine } = harnessForVerification()
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git status --porcelain (clean)
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git merge --no-edit
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git worktree remove
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git branch -d
    commands.push({ exitCode: 0, stdout: 'merge subject\n', stderr: '' })

    const result = await engine.merge('agent-1', wt, 'unused message')

    expect(result.committed).toBe(false)
    expect(commands.lines()).not.toContain('git add -A')
    expect(commands.lines().join('\n')).not.toContain('git commit')
  })

  it('refuses to merge when the vitest gate is red: verify_failed event + loud structured error, no git merge', async () => {
    const { commands, sink, engine } = harnessForVerification(1, 0)

    await expect(engine.merge('agent-1', wt, 'message')).rejects.toThrow(
      /verification gate failed.*vitest exit 1.*fix the worktree before merging/s,
    )
    expect(repoEvents(sink)).toEqual([
      { type: 'repo.verify_failed', payload: { path: wt, vitestExit: 1, checkExit: 0 } },
    ])
    expect(commands.lines().join('\n')).not.toContain('git merge')
    expect(commands.lines().join('\n')).not.toContain('git worktree remove')
  })

  it('refuses to merge when the typecheck gate is red', async () => {
    const { sink, engine } = harnessForVerification(0, 2)

    await expect(engine.merge('agent-1', wt, 'message')).rejects.toThrow(/check exit 2/)
    expect(repoEvents(sink)).toEqual([
      { type: 'repo.verify_failed', payload: { path: wt, vitestExit: 0, checkExit: 2 } },
    ])
  })

  it('on merge conflicts: loud structured error telling the agent to stop and ask the owner; no cleanup', async () => {
    const { commands, engine } = harnessForVerification()
    commands.push({ exitCode: 0, stdout: '', stderr: '' }) // git status --porcelain (clean)
    commands.failWhen(
      (spec) => spec.cmd === 'git' && spec.args[0] === 'merge',
      { exitCode: 1, stdout: '', stderr: 'CONFLICT (content): Merge conflict in src/x.ts' },
    )

    await expect(engine.merge('agent-1', wt, 'message')).rejects.toThrow(
      /git merge failed.*ask the owner.*do not resolve conflicts yourself.*CONFLICT/s,
    )
    expect(commands.lines().join('\n')).not.toContain('git worktree remove')
    expect(commands.lines().join('\n')).not.toContain('git branch -d')
  })

  it('rejects worktree paths that are not ee-agent-* worktrees (merge only lands agent worktrees)', async () => {
    const { commands, engine } = makeEngine()

    await expect(engine.merge('agent-1', '/tmp/arbitrary', 'message')).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('ee-agent-'),
    })
    await expect(engine.merge('agent-1', '/ee-da-xyz', 'message')).rejects.toMatchObject({
      code: 'invalid_input',
    })
    expect(commands.calls).toHaveLength(0)
  })
})

describe('createRepoTools descriptors', () => {
  const tools = createRepoTools({ engine: makeEngine().engine })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  it('builds exactly the manifest tools with mission audit classes and roles', () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual([...REPO_TOOL_NAMES].sort())
    expect(byName.get('repo.worktree_create')?.auditClass).toBe('external')
    expect(byName.get('repo.worktree_create')?.permission.roles).toEqual(['admin', 'agent'])
    expect(byName.get('repo.run')?.auditClass).toBe('external')
    expect(byName.get('repo.run')?.permission.roles).toEqual(['admin', 'agent'])
    expect(byName.get('repo.write_file')?.auditClass).toBe('mutate')
    expect(byName.get('repo.write_file')?.permission.roles).toEqual(['admin', 'agent'])
    expect(byName.get('repo.read_file')?.auditClass).toBe('read')
    expect(byName.get('repo.read_file')?.permission.roles).toEqual(['admin', 'agent'])
    expect(byName.get('repo.merge')?.auditClass).toBe('mutate')
    expect(byName.get('repo.merge')?.permission.roles).toEqual(['admin', 'agent', 'owner'])
    for (const tool of tools) {
      expect(tool.module).toBe('orchestrator')
    }
  })

  it('validates inputs with zod', () => {
    expect(byName.get('repo.worktree_create')?.inputSchema.safeParse({}).success).toBe(true)
    expect(
      byName.get('repo.run')?.inputSchema.safeParse({ worktreePath: '/x', command: 'git status' })
        .success,
    ).toBe(true)
    expect(byName.get('repo.run')?.inputSchema.safeParse({ worktreePath: '/x' }).success).toBe(false)
    expect(byName.get('repo.run')?.inputSchema.safeParse({ command: 'x' }).success).toBe(false)
    expect(
      byName.get('repo.write_file')?.inputSchema.safeParse({ worktreePath: '/x', path: 'a.ts', content: '' })
        .success,
    ).toBe(true)
    expect(
      byName.get('repo.write_file')?.inputSchema.safeParse({ worktreePath: '/x', path: 'a.ts' }).success,
    ).toBe(false)
    expect(
      byName.get('repo.read_file')?.inputSchema.safeParse({ worktreePath: '/x', path: 'a.ts' }).success,
    ).toBe(true)
    expect(byName.get('repo.merge')?.inputSchema.safeParse({ worktreePath: '/x', message: 'm' }).success).toBe(
      true,
    )
    expect(byName.get('repo.merge')?.inputSchema.safeParse({ worktreePath: '/x' }).success).toBe(false)
  })
})

describe('repo tools through the kernel registry pipeline', () => {
  function makeRegistry() {
    const harness = makeEngine()
    const activations = new InMemoryActivationStore()
    const approvals = new InMemoryApprovalStore()
    const registry = new KernelRegistry({
      eventSink: harness.sink,
      activationStore: activations,
      approvalPolicy: new StaticApprovalPolicy(new Set(['repo.merge'])),
      approvalStore: approvals,
      vcsCommitter: null,
    })
    for (const descriptor of createRepoTools({ engine: harness.engine })) {
      registry.register(descriptor)
    }
    return { ...harness, activations, approvals, registry }
  }

  it('activation gates the surface (fail closed)', async () => {
    const { registry, activations } = makeRegistry()
    await activations.set('orchestrator', false)
    await expect(
      registry.execute('repo.worktree_create', {}, ctxAgent),
    ).rejects.toMatchObject({ code: 'module_inactive' })
  })

  it('agent and admin drive the hands; repo.merge is approval-gated before execution', async () => {
    const { registry, activations, approvals, commands, sink } = makeRegistry()
    await activations.set('orchestrator', true)

    const worktreePath = await mkdtemp(path.join(tmpdir(), 'ee-repo-registry-'))
    const write = await registry.execute(
      'repo.write_file',
      { worktreePath, path: 'note.md', content: 'hello' },
      ctxAdmin,
    )
    expect(write).toEqual({ path: 'note.md' })
    await expect(
      registry.execute('repo.read_file', { worktreePath, path: 'note.md' }, ctxAgent),
    ).resolves.toEqual({ content: 'hello' })
    await rm(worktreePath, { recursive: true, force: true })

    // repo.merge is in APPROVAL_REQUIRED_TOOLS: the gate halts the agent before the handler runs
    await expect(
      registry.execute('repo.merge', { worktreePath: '/ee-agent-abc123ab', message: 'm' }, ctxAgent),
    ).rejects.toMatchObject({ code: 'approval_required' })
    // the owner passes the permission gate too — and still stops at the approval gate
    await expect(
      registry.execute('repo.merge', { worktreePath: '/ee-agent-abc123ab', message: 'm' }, ctxOwner),
    ).rejects.toMatchObject({ code: 'approval_required' })
    const pending = await approvals.listPending()
    expect(pending).toHaveLength(2)
    expect(pending[0]).toMatchObject({ toolName: 'repo.merge', status: 'pending' })
    // the handler never ran — no git was touched
    expect(commands.lines().join('\n')).not.toContain('git merge')

    expect(sink.events.some((event) => event.type === 'repo.file_written')).toBe(true)
  })
})

describe('createRepoEngine default wiring', () => {
  it('composes production seams without spawning or connecting', () => {
    const sink = new InMemoryEventSink()
    const engine = createRepoEngine({ eventSink: sink })
    expect(engine).toBeInstanceOf(RepoEngine)
  })
})
