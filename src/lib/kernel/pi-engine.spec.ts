import { describe, expect, it } from 'vitest'
import {
  buildPiPrompt,
  createNodeSpawnRunner,
  DEFAULT_PI_TIMEOUT_MS,
  PiEngine,
  PI_GUARDRAILS,
  resolvePiBin,
  TIMEOUT_EXIT_CODE,
  type EngineContext,
  type KernelEvent,
  type SpawnOptions,
  type SpawnResult,
  type SpawnRunner,
} from './pi-engine'

describe('buildPiPrompt (kernel-owned prompt contract)', () => {
  it('embeds the task text verbatim, followed by the guardrails', () => {
    const task = 'Fix the flaky owlery retry test in src/lib/server.'
    const prompt = buildPiPrompt(task)
    expect(prompt.startsWith(task)).toBe(true)
    expect(prompt).toContain(PI_GUARDRAILS)
    expect(prompt.indexOf(task)).toBeLessThan(prompt.indexOf(PI_GUARDRAILS))
  })

  it('carries the mandatory engineering contract markers', () => {
    const prompt = buildPiPrompt('t')
    // tests must pass, per touched scope
    expect(prompt).toContain('npx vitest run')
    // typecheck must not add errors beyond the known baseline
    expect(prompt).toContain('npm run check')
    expect(prompt).toContain('5 known baseline errors')
    // commit conventions
    expect(prompt).toContain('single commit')
    expect(prompt).toContain('imperative commit message')
    // secrets
    expect(prompt).toContain('Never commit or log secrets')
    // no weakening tests
    expect(prompt).toContain('Never weaken tests')
    // AGENTS.md is law
    expect(prompt).toContain('AGENTS.md is law')
    // no fallbacks
    expect(prompt).toContain('fail loud')
  })

  it('is a pure function: identical inputs produce identical prompts', () => {
    expect(buildPiPrompt('a')).toBe(buildPiPrompt('a'))
    expect(buildPiPrompt('a')).not.toBe(buildPiPrompt('b'))
  })
})

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

/** Records every spawn; returns scripted results (default success). */
class FakeSpawn {
  readonly calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = []
  private readonly queue: SpawnResult[] = []

  push(...results: SpawnResult[]): this {
    this.queue.push(...results)
    return this
  }

  spawnRunner: SpawnRunner = (cmd, args, opts) => {
    this.calls.push({ cmd, args, opts })
    return {
      done: Promise.resolve(this.queue.shift() ?? { exitCode: 0, stdout: '', stderr: '' }),
      kill: () => undefined,
    }
  }
}

/** done() never settles until kill() — models a hung pi process. */
class HangingSpawn {
  readonly calls: Array<{ cmd: string; args: string[]; opts: SpawnOptions }> = []
  killCount = 0
  private pending: ((result: SpawnResult) => void) | null = null

  spawnRunner: SpawnRunner = (cmd, args, opts) => {
    this.calls.push({ cmd, args, opts })
    return {
      done: new Promise<SpawnResult>((resolve) => {
        this.pending = resolve
      }),
      kill: () => {
        this.killCount++
        const resolve = this.pending
        this.pending = null
        resolve?.({ exitCode: TIMEOUT_EXIT_CODE, stdout: '', stderr: '[fake] killed' })
      },
    }
  }
}

/** Minimal in-memory harness context; only emit and principal matter here. */
function fakeContext(): { ctx: EngineContext; events: KernelEvent[] } {
  const events: KernelEvent[] = []
  const ctx: EngineContext = {
    agent: { id: 'agent-1' },
    principal: { id: 'principal-1', kind: 'agent', roles: ['owner'] },
    executeTool: async () => {
      throw new Error('pi engine never calls executeTool')
    },
    listTools: async () => [],
    emit: async (event) => {
      events.push(event)
    },
    spendUsd: () => {},
  }
  return { ctx, events }
}

describe('PiEngine', () => {
  it('keeps the 15-minute default timeout budget', () => {
    expect(DEFAULT_PI_TIMEOUT_MS).toBe(900_000)
  })

  it('spawns `pi -p --mode json <task+guardrails>` in the given cwd', async () => {
    const fake = new FakeSpawn()
    const engine = new PiEngine({ spawnRunner: fake.spawnRunner })
    const task = 'Add a rate limiter to the gateway.'

    const result = await engine.execute(task, '/worktree')

    expect(result.ok).toBe(true)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]
    expect(call.cmd).toBe('pi')
    expect(call.opts.cwd).toBe('/worktree')
    expect(call.args).toEqual(['-p', '--mode', 'json', buildPiPrompt(task)])
  })

  it('maps non-zero exit to ok:false and carries stdout+stderr as output', async () => {
    const fake = new FakeSpawn().push({ exitCode: 1, stdout: 'partial progress', stderr: 'boom' })
    const result = await new PiEngine({ spawnRunner: fake.spawnRunner }).execute('t', '/w')
    expect(result.ok).toBe(false)
    expect(result.output).toContain('partial progress')
    expect(result.output).toContain('boom')
  })

  it('carries the `--mode json` stream through verbatim, trimmed', async () => {
    const fake = new FakeSpawn().push({ exitCode: 0, stdout: '{"final":"text"}\n', stderr: '' })
    const result = await new PiEngine({ spawnRunner: fake.spawnRunner }).execute('t', '/w')
    expect(result.ok).toBe(true)
    expect(result.output).toBe('{"final":"text"}')
  })

  it('times out: kills the child and resolves ok:false', async () => {
    const fake = new HangingSpawn()
    const result = await new PiEngine({ spawnRunner: fake.spawnRunner, timeoutMs: 10 }).execute(
      't',
      '/w',
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain('timed out')
    expect(fake.killCount).toBe(1)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('applies the taskWrapper before the prompt builder', async () => {
    const fake = new FakeSpawn()
    let built: string | undefined
    const engine = new PiEngine({
      spawnRunner: fake.spawnRunner,
      taskWrapper: (task) => `wrapped:${task}`,
      promptBuilder: (task) => {
        built = task
        return `prompt:${task}`
      },
    })

    await engine.execute('the-task', '/w')

    expect(built).toBe('wrapped:the-task')
    expect(fake.calls[0].args[3]).toBe('prompt:wrapped:the-task')
  })

  describe('run (LoopEngine contract)', () => {
    it('returns pi’s final output and emits started/finished without output content', async () => {
      const fake = new FakeSpawn().push({ exitCode: 0, stdout: 'the final answer', stderr: '' })
      const engine = new PiEngine({ spawnRunner: fake.spawnRunner, cwd: '/worktree' })
      const { ctx, events } = fakeContext()

      const output = await engine.run('session-1', 'Do the thing.', ctx)

      expect(output).toBe('the final answer')
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0].opts.cwd).toBe('/worktree')
      expect(events.map((event) => event.type)).toEqual(['pi.started', 'pi.finished'])
      expect(events[0].payload).toEqual({ sessionId: 'session-1' })
      expect(events[0].principalId).toBe('principal-1')
      expect(events[1].payload).toEqual({
        sessionId: 'session-1',
        ok: true,
        durationMs: expect.any(Number),
        outputLength: 'the final answer'.length,
      })
      // no output content in events
      expect(JSON.stringify(events)).not.toContain('the final answer')
    })

    it('emits ok:false in pi.finished and fails loud on a red run', async () => {
      const fake = new FakeSpawn().push({ exitCode: 1, stdout: '', stderr: 'boom' })
      const engine = new PiEngine({ spawnRunner: fake.spawnRunner })
      const { ctx, events } = fakeContext()

      await expect(engine.run('session-2', 't', ctx)).rejects.toThrow('pi run failed')

      expect(events.map((event) => event.type)).toEqual(['pi.started', 'pi.finished'])
      expect(events[1].payload).toMatchObject({ sessionId: 'session-2', ok: false })
    })

    it('times out loud: kills the child and rejects with the timeout report', async () => {
      const fake = new HangingSpawn()
      const engine = new PiEngine({ spawnRunner: fake.spawnRunner, timeoutMs: 10 })
      const { ctx, events } = fakeContext()

      await expect(engine.run('session-3', 't', ctx)).rejects.toThrow('timed out')
      expect(fake.killCount).toBe(1)
      expect(events[1]?.payload).toMatchObject({ sessionId: 'session-3', ok: false })
    })

    it('is stateless per run: sessionId is correlation only', async () => {
      const fake = new FakeSpawn().push(
        { exitCode: 0, stdout: 'first', stderr: '' },
        { exitCode: 0, stdout: 'second', stderr: '' },
      )
      const engine = new PiEngine({ spawnRunner: fake.spawnRunner })
      const { ctx } = fakeContext()

      const first = await engine.run('session-a', 't', ctx)
      const second = await engine.run('session-b', 't', ctx)

      expect(first).toBe('first')
      expect(second).toBe('second')
      expect(fake.calls).toHaveLength(2)
    })
  })
})

describe('createNodeSpawnRunner (real spawn plumbing, no pi/network)', () => {
  it('collects stdout/stderr and the exit code', async () => {
    const runner = createNodeSpawnRunner()
    const result = await runner('node', ['-e', 'console.log("out"); console.error("err")'], {
      cwd: process.cwd(),
    }).done
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('out')
    expect(result.stderr).toContain('err')
  })

  it('resolves (never rejects) with 127 for a missing binary', async () => {
    const runner = createNodeSpawnRunner()
    const result = await runner('definitely-not-a-real-binary-e7f2', [], {
      cwd: process.cwd(),
    }).done
    expect(result.exitCode).toBe(127)
  })

  it('kills on the per-child timeout and reports exit code 124', async () => {
    const runner = createNodeSpawnRunner()
    const result = await runner('node', ['-e', 'setTimeout(() => {}, 10_000)'], {
      cwd: process.cwd(),
      timeoutMs: 100,
    }).done
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE)
    expect(result.stderr).toContain('timed out after 100ms')
  }, 5_000)

  it('killAll SIGKILLs every in-flight child', async () => {
    const runner = createNodeSpawnRunner()
    const a = runner('node', ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: process.cwd() })
    const b = runner('node', ['-e', 'setTimeout(() => {}, 10_000)'], { cwd: process.cwd() })
    runner.killAll()
    const [resultA, resultB] = await Promise.all([a.done, b.done])
    expect(resultA.exitCode).not.toBe(0)
    expect(resultB.exitCode).not.toBe(0)
  }, 5_000)
})
