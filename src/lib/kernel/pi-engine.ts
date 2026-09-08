import type { KernelEvent } from './events'
import type { PrincipalKind } from './types'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { KERNEL_EVENT_SOURCE } from './cloudevents'

/**
 * The pi prompt contract: the dispatched task text verbatim, followed by the
 * MANDATORY engineering contract carried from AGENTS.md. Pure function — the
 * template is data, testable without spawning anything. Canonical home is the
 * kernel (the engine owns spawning AND the prompt contract); module code
 * re-exports from here.
 */

export const PI_GUARDRAILS = [
  'MANDATORY ENGINEERING CONTRACT (binding; AGENTS.md is law for this repo):',
  '- Make every test pass: run `npx vitest run` for every scope you touched (at minimum `npx vitest run src/cli src/lib/kernel src/lib/server/mcp modules`).',
  '- Run `npm run check` before finishing: it must not add errors beyond the 5 known baseline errors (web-push/vapid x3, posthog x2).',
  '- Land your work as a single commit with an imperative commit message.',
  '- Never commit or log secrets; never print raw credentials, keys, or tokens.',
  '- Never weaken tests or assertions to make a build green — fix root causes, never work around them.',
  '- No fallbacks, no silent degradation, no temporary shims: fail loud with explicit errors.',
].join('\n')

export function buildPiPrompt(task: string): string {
  return `${task}\n\n${PI_GUARDRAILS}`
}

/** Conventional "timed out" exit code. */
export const TIMEOUT_EXIT_CODE = 124

/** Default pi wall-clock budget: 15 minutes. */
export const DEFAULT_PI_TIMEOUT_MS = 15 * 60 * 1000

/** Binary name 'pi', overridable via PI_BIN (binary-name override, not an env fallback). */
export function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_BIN ?? 'pi'
}

/**
 * Process-boundary seam for the engine: spawn a child, collect its output,
 * never reject — failures surface as exit codes on the resolved result.
 */
export type SpawnOptions = {
  cwd: string
  /** Kill the child when the wall clock exceeds this; exitCode 124. */
  timeoutMs?: number
}

export type SpawnResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type SpawnHandle = {
  /** Resolves when the child settles (never rejects). */
  done: Promise<SpawnResult>
  /** SIGKILL this child — engine timeout and abort paths. */
  kill(): void
}

export type SpawnRunner = (cmd: string, args: string[], opts: SpawnOptions) => SpawnHandle

export type NodeSpawnRunner = SpawnRunner & {
  /** SIGKILL every child this runner spawned (abort / shared-timeout paths). */
  killAll(): void
}

/**
 * Real spawn mechanics ported from the dev-agent's NodeCommandRunner: spawns
 * children, collects stdout/stderr, resolves (never rejects) with exit codes
 * (127 for ENOENT), enforces an optional per-child timeout (exitCode 124).
 */
export function createNodeSpawnRunner(): NodeSpawnRunner {
  const active = new Set<ChildProcess>()

  const runner = (cmd: string, args: string[], opts: SpawnOptions): SpawnHandle => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    active.add(child)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill('SIGKILL')
          }, opts.timeoutMs)
    timer?.unref()

    const done = new Promise<SpawnResult>((resolve) => {
      const settle = (exitCode: number) => {
        if (timer !== undefined) clearTimeout(timer)
        active.delete(child)
        resolve({
          exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
          stdout,
          stderr: timedOut ? `${stderr}\n[spawn] timed out after ${opts.timeoutMs}ms` : stderr,
        })
      }
      child.on('error', (err: NodeJS.ErrnoException) => {
        // e.g. ENOENT — resolve loud instead of rejecting.
        settle(err.code === 'ENOENT' ? 127 : 1)
      })
      child.on('close', (code) => {
        settle(code ?? 1)
      })
    })

    return {
      done,
      kill: () => {
        child.kill('SIGKILL')
      },
    }
  }

  return Object.assign(runner, {
    killAll(): void {
      for (const child of active) {
        child.kill('SIGKILL')
      }
      active.clear()
    },
  })
}

/**
 * Structural local mirror of the harness EngineContext (wt/harness owns the
 * canonical `src/lib/kernel/engine.ts` declaration; the orchestrator unifies
 * the types at merge). Function members use method syntax on purpose: method
 * parameters are checked bivariantly, so this stays compatible with the
 * canonical context in both directions.
 *
 * PiEngine itself only reads `principal.id` and calls `emit` — every other
 * member is the harness-provided surface an engine MAY use.
 */
export type EngineContext = {
  /** Harness agent descriptor (AgentConfig at integration); only `id` is assumed. */
  agent: { id: string }
  principal: { id: string; kind: PrincipalKind; roles: string[] }
  executeTool(name: string, input: unknown): Promise<unknown>
  listTools(): Promise<readonly unknown[]>
  emit(event: KernelEvent): Promise<void>
  spendUsd(amountUsd: number): void | Promise<void>
}

/** Outcome of one headless pi execution. */
export type PiExecution = {
  ok: boolean
  output: string
  durationMs: number
}

export type PiEngineDeps = {
  /** Process seam; defaults to real child-process spawning. */
  spawnRunner?: SpawnRunner
  /** Wall-clock budget per run; the child is SIGKILLed and the run fails. */
  timeoutMs?: number
  /** Task -> prompt; defaults to the kernel's buildPiPrompt (guardrails included). */
  promptBuilder?: (task: string) => string
  /** Applied to the raw task BEFORE the prompt builder (e.g. company context). */
  taskWrapper?: (task: string) => string
  /** Where pi runs; defaults to process.cwd() of the server process. */
  cwd?: string
}

function kernelEvent(principalId: string, type: string, payload: unknown): KernelEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    type,
    principalId,
    source: KERNEL_EVENT_SOURCE,
    payload,
  }
}

function tail(text: string, max = 500): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}

/**
 * The hosted pi loop engine (kernel primitive, phase 1b): runs the headless pi
 * coding agent (`pi -p --mode json <prompt>`) and returns its final text
 * output. Structurally satisfies the LoopEngine contract
 * (`run(sessionId, input, ctx: EngineContext): Promise<string>`).
 *
 * Session semantics: pi is STATELESS per run — every run is a fresh process.
 * `sessionId` is carried for events/correlation only; it never reaches pi.
 *
 * Failure policy: `run` (the LoopEngine path) fails loud by throwing on
 * timeout or non-zero exit; `execute` is the headless primitive that reports
 * `ok:false` instead (the dev-agent run lifecycle consumes that shape and
 * emits its own module events).
 */
export class PiEngine {
  private readonly spawnRunner: SpawnRunner
  private readonly timeoutMs: number
  private readonly promptBuilder: (task: string) => string
  private readonly taskWrapper: ((task: string) => string) | undefined
  private readonly cwd: string

  constructor(deps: PiEngineDeps = {}) {
    this.spawnRunner = deps.spawnRunner ?? createNodeSpawnRunner()
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_PI_TIMEOUT_MS
    this.promptBuilder = deps.promptBuilder ?? buildPiPrompt
    this.taskWrapper = deps.taskWrapper
    this.cwd = deps.cwd ?? process.cwd()
  }

  /**
   * LoopEngine contract. Emits `pi.started` {sessionId} before spawning and
   * `pi.finished` {sessionId, ok, durationMs, outputLength} after — never any
   * output content. Throws on failure; returns pi's final text output on
   * success.
   */
  async run(sessionId: string, input: string, ctx: EngineContext): Promise<string> {
    await ctx.emit(kernelEvent(ctx.principal.id, 'pi.started', { sessionId }))
    const result = await this.execute(input)
    await ctx.emit(
      kernelEvent(ctx.principal.id, 'pi.finished', {
        sessionId,
        ok: result.ok,
        durationMs: result.durationMs,
        outputLength: result.output.length,
      }),
    )
    if (!result.ok) {
      throw new Error(`pi run failed (session ${sessionId}): ${tail(result.output)}`)
    }
    return result.output
  }

  /**
   * Headless primitive: spawn pi, enforce the wall-clock timeout (SIGKILL via
   * the spawn handle), and report the outcome. Never throws for process
   * failures — they surface as ok:false with the combined stdout/stderr as
   * output (the `--mode json` stream is carried through verbatim, exactly as
   * the dev-agent runner did before the kernel owned spawning).
   */
  async execute(task: string, cwd: string = this.cwd): Promise<PiExecution> {
    const startedAtMs = Date.now()
    const prompt = this.promptBuilder(this.taskWrapper ? this.taskWrapper(task) : task)
    const handle = this.spawnRunner(resolvePiBin(), ['-p', '--mode', 'json', prompt], { cwd })
    // The spawn seam never rejects; this catch keeps any contract breach from
    // becoming an unhandled rejection after a timeout kill.
    handle.done.catch(() => undefined)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      handle.kill()
    }, this.timeoutMs)
    timer.unref()

    try {
      const result = await handle.done
      if (timedOut) {
        return {
          ok: false,
          output: `[pi-engine] pi run timed out after ${this.timeoutMs}ms`,
          durationMs: Date.now() - startedAtMs,
        }
      }
      return {
        ok: result.exitCode === 0,
        output: `${result.stdout}\n${result.stderr}`.trim(),
        durationMs: Date.now() - startedAtMs,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
