import { spawn, type ChildProcess } from 'node:child_process'
import { buildPiPrompt } from './prompt'

/**
 * Shell seam so every process boundary in this module is injectable (tests
 * never spawn real pi or real git). Implementations must resolve (never
 * reject): failures surface as non-zero exit codes.
 */
export type CommandSpec = {
  cmd: string
  args: string[]
  cwd: string
  /** Kill the child when the wall clock exceeds this; exitCode 124. */
  timeoutMs?: number
}

export type CommandResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type CommandRunner = {
  run(spec: CommandSpec): Promise<CommandResult>
  /** Signal (kill) every in-flight child process — abort path and pi timeout. */
  killAll(): Promise<void>
}

/** Conventional "timed out" exit code. */
export const TIMEOUT_EXIT_CODE = 124

/** Real runner: spawns children, collects output, enforces per-command timeouts. */
export class NodeCommandRunner implements CommandRunner {
  private readonly active = new Set<ChildProcess>()

  async run(spec: CommandSpec): Promise<CommandResult> {
    return new Promise<CommandResult>((resolve) => {
      const child = spawn(spec.cmd, spec.args, {
        cwd: spec.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.active.add(child)

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
        spec.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              child.kill('SIGKILL')
            }, spec.timeoutMs)
      timer?.unref()

      const settle = (exitCode: number) => {
        if (timer !== undefined) clearTimeout(timer)
        this.active.delete(child)
        resolve({
          exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
          stdout,
          stderr: timedOut ? `${stderr}\n[dev-agent] timed out after ${spec.timeoutMs}ms` : stderr,
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
  }

  async killAll(): Promise<void> {
    for (const child of this.active) {
      child.kill('SIGKILL')
    }
    this.active.clear()
  }
}

export type PiRunResult = {
  ok: boolean
  output: string
  durationMs: number
}

/** Headless pi coding agent seam. */
export type PiRunner = {
  run(task: string, cwd: string): Promise<PiRunResult>
}

export const DEFAULT_PI_TIMEOUT_MS = 15 * 60 * 1000

/** Binary name 'pi', overridable via PI_BIN (binary-name override, not an env fallback). */
export function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_BIN ?? 'pi'
}

/**
 * Real PiRunner: `pi -p --mode json <prompt>` (prompt = task + mandatory
 * engineering contract) via the injected CommandRunner. Timeout kills the pi
 * process and resolves ok:false.
 */
export class CliPiRunner implements PiRunner {
  constructor(
    private readonly commands: CommandRunner,
    private readonly timeoutMs: number = DEFAULT_PI_TIMEOUT_MS,
  ) {}

  async run(task: string, cwd: string): Promise<PiRunResult> {
    const startedAtMs = Date.now()
    const runPromise = this.commands.run({
      cmd: resolvePiBin(),
      args: ['-p', '--mode', 'json', buildPiPrompt(task)],
      cwd,
    })
    // The runner resolves the killed run on killAll; the catch keeps a late
    // rejection from turning into an unhandled rejection after a timeout.
    runPromise.catch(() => undefined)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void this.commands.killAll()
    }, this.timeoutMs)
    timer.unref()

    try {
      const result = await runPromise
      if (timedOut) {
        return {
          ok: false,
          output: `[dev-agent] pi run timed out after ${this.timeoutMs}ms`,
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

/** Scopes verified after every pi run (kernel + cli + mcp + all modules). */
export const VERIFY_TARGETS = ['src/cli', 'src/lib/kernel', 'src/lib/server/mcp', 'modules'] as const

export type VerificationResult = {
  green: boolean
  summary: string
}

/**
 * Verification gate: `npx vitest run <targets>` + `npm run check` inside the
 * run's worktree (env inherits whatever the server process has). Green = both
 * exit 0. Summaries only — never task text or full output.
 */
export async function verifyWorktree(
  commands: CommandRunner,
  cwd: string,
): Promise<VerificationResult> {
  const vitest = await commands.run({ cmd: 'npx', args: ['vitest', 'run', ...VERIFY_TARGETS], cwd })
  const check = await commands.run({ cmd: 'npm', args: ['run', 'check'], cwd })
  const green = vitest.exitCode === 0 && check.exitCode === 0
  const parts = [`verification: vitest exit ${vitest.exitCode}, check exit ${check.exitCode}`]
  if (vitest.exitCode !== 0) parts.push(`[vitest] ${tail(vitest.stderr || vitest.stdout)}`)
  if (check.exitCode !== 0) parts.push(`[check] ${tail(check.stderr || check.stdout)}`)
  return { green, summary: parts.join('\n') }
}

function tail(text: string, max = 500): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}
