import {
  createNodeSpawnRunner,
  DEFAULT_PI_TIMEOUT_MS,
  PiEngine,
  resolvePiBin,
  TIMEOUT_EXIT_CODE,
  type PiExecution,
  type SpawnHandle,
  type SpawnOptions,
} from '$lib/kernel/pi-engine'

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

export { DEFAULT_PI_TIMEOUT_MS, resolvePiBin, TIMEOUT_EXIT_CODE }

/** Real runner: spawns children, collects output, enforces per-command timeouts. */
export class NodeCommandRunner implements CommandRunner {
  private readonly spawn = createNodeSpawnRunner()

  async run(spec: CommandSpec): Promise<CommandResult> {
    return this.spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    }).done
  }

  async killAll(): Promise<void> {
    this.spawn.killAll()
  }
}

export type PiRunResult = PiExecution

/** Headless pi coding agent seam. */
export type PiRunner = {
  run(task: string, cwd: string): Promise<PiRunResult>
}

/**
 * Thin shell over the kernel PiEngine (phase 1b: the kernel owns pi spawning).
 * Composes the prompt via the kernel and spawns through the engine; the
 * handle's kill is routed to the shared CommandRunner so a pi timeout/abort
 * still kills every in-flight child this module started.
 */
export class CliPiRunner implements PiRunner {
  private readonly engine: PiEngine

  constructor(
    commands: CommandRunner,
    timeoutMs: number = DEFAULT_PI_TIMEOUT_MS,
  ) {
    this.engine = new PiEngine({
      timeoutMs,
      spawnRunner: (cmd, args, opts: SpawnOptions): SpawnHandle => {
        const done = commands.run({ cmd, args, cwd: opts.cwd })
        done.catch(() => undefined)
        return {
          done,
          kill: () => {
            void commands.killAll()
          },
        }
      },
    })
  }

  async run(task: string, cwd: string): Promise<PiRunResult> {
    return this.engine.execute(task, cwd)
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
