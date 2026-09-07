import { describe, expect, it } from 'vitest'
import { buildPiPrompt } from './prompt'
import {
  CliPiRunner,
  NodeCommandRunner,
  TIMEOUT_EXIT_CODE,
  resolvePiBin,
  verifyWorktree,
  VERIFY_TARGETS,
  type CommandResult,
  type CommandRunner,
  type CommandSpec,
} from './runner'

/** Records every call; returns scripted results (default success). */
class FakeCommands implements CommandRunner {
  readonly calls: CommandSpec[] = []
  killAllCount = 0
  private readonly queue: CommandResult[] = []

  push(...results: CommandResult[]): this {
    this.queue.push(...results)
    return this
  }

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec)
    return this.queue.shift() ?? { exitCode: 0, stdout: '', stderr: '' }
  }

  async killAll(): Promise<void> {
    this.killAllCount++
  }
}

/** run() never settles until killAll() — models a hung child process. */
class HangingCommands implements CommandRunner {
  readonly calls: CommandSpec[] = []
  killAllCount = 0
  private pending: ((result: CommandResult) => void) | null = null

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec)
    return new Promise((resolve) => {
      this.pending = resolve
    })
  }

  async killAll(): Promise<void> {
    this.killAllCount++
    const resolve = this.pending
    this.pending = null
    resolve?.({ exitCode: TIMEOUT_EXIT_CODE, stdout: '', stderr: '[fake] killed' })
  }
}

describe('resolvePiBin', () => {
  it('defaults to the pi binary name; PI_BIN overrides it', () => {
    const prev = process.env.PI_BIN
    delete process.env.PI_BIN
    try {
      expect(resolvePiBin()).toBe('pi')
      process.env.PI_BIN = '/usr/local/bin/pi-wrapper'
      expect(resolvePiBin()).toBe('/usr/local/bin/pi-wrapper')
    } finally {
      if (prev === undefined) delete process.env.PI_BIN
      else process.env.PI_BIN = prev
    }
  })
})

describe('CliPiRunner', () => {
  it('spawns `pi -p --mode json <task+guardrails>` in the given cwd', async () => {
    const commands = new FakeCommands()
    const runner = new CliPiRunner(commands)
    const task = 'Add a rate limiter to the gateway.'

    const result = await runner.run(task, '/worktree')

    expect(result.ok).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(commands.calls).toHaveLength(1)
    const spec = commands.calls[0]
    expect(spec.cmd).toBe('pi')
    expect(spec.cwd).toBe('/worktree')
    expect(spec.args).toEqual(['-p', '--mode', 'json', buildPiPrompt(task)])
  })

  it('maps non-zero exit to ok:false and carries stdout+stderr as output', async () => {
    const commands = new FakeCommands().push({
      exitCode: 1,
      stdout: 'partial progress',
      stderr: 'boom',
    })
    const result = await new CliPiRunner(commands).run('t', '/w')
    expect(result.ok).toBe(false)
    expect(result.output).toContain('partial progress')
    expect(result.output).toContain('boom')
  })

  it('times out: kills the child and resolves ok:false', async () => {
    const commands = new HangingCommands()
    const result = await new CliPiRunner(commands, 10).run('t', '/w')
    expect(result.ok).toBe(false)
    expect(result.output).toContain('timed out')
    expect(commands.killAllCount).toBe(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('verifyWorktree', () => {
  it('is green when both vitest and check exit 0, running inside the worktree', async () => {
    const commands = new FakeCommands()
    const result = await verifyWorktree(commands, '/worktree')

    expect(result.green).toBe(true)
    expect(commands.calls).toHaveLength(2)
    expect(commands.calls[0]).toEqual({
      cmd: 'npx',
      args: ['vitest', 'run', ...VERIFY_TARGETS],
      cwd: '/worktree',
    })
    expect(commands.calls[1]).toEqual({ cmd: 'npm', args: ['run', 'check'], cwd: '/worktree' })
    expect(VERIFY_TARGETS).toEqual(['src/cli', 'src/lib/kernel', 'src/lib/server/mcp', 'modules'])
  })

  it('is red when vitest fails; summary names the exit code', async () => {
    const commands = new FakeCommands().push({
      exitCode: 1,
      stdout: '',
      stderr: '23 tests failed',
    })
    const result = await verifyWorktree(commands, '/worktree')
    expect(result.green).toBe(false)
    expect(result.summary).toContain('vitest exit 1')
    expect(result.summary).toContain('23 tests failed')
  })

  it('is red when only the typecheck fails (short-circuits nothing: both run)', async () => {
    const commands = new FakeCommands().push({ exitCode: 0, stdout: '', stderr: '' }, {
      exitCode: 2,
      stdout: '',
      stderr: 'svelte-check found 7 errors',
    })
    const result = await verifyWorktree(commands, '/worktree')
    expect(result.green).toBe(false)
    expect(result.summary).toContain('vitest exit 0')
    expect(result.summary).toContain('check exit 2')
    expect(result.summary).toContain('svelte-check found 7 errors')
  })
})

describe('NodeCommandRunner (real spawn plumbing, no pi/git)', () => {
  it('collects stdout/stderr and the exit code', async () => {
    const runner = new NodeCommandRunner()
    const result = await runner.run({
      cmd: 'node',
      args: ['-e', 'console.log("out"); console.error("err")'],
      cwd: process.cwd(),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('out')
    expect(result.stderr).toContain('err')
  })

  it('resolves (never rejects) with 127 for a missing binary', async () => {
    const runner = new NodeCommandRunner()
    const result = await runner.run({
      cmd: 'definitely-not-a-real-binary-e7f2',
      args: [],
      cwd: process.cwd(),
    })
    expect(result.exitCode).toBe(127)
  })

  it('kills on timeout and reports exit code 124', async () => {
    const runner = new NodeCommandRunner()
    const result = await runner.run({
      cmd: 'node',
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      cwd: process.cwd(),
      timeoutMs: 100,
    })
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE)
    expect(result.stderr).toContain('timed out after 100ms')
  }, 5_000)
})
