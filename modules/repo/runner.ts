import { createNodeSpawnRunner, TIMEOUT_EXIT_CODE } from '$lib/kernel/pi-engine'

/**
 * Shell seam so every process boundary in this module is injectable (tests
 * never spawn real git/node). Same shape as the kernel spawn seam — failures
 * surface as non-zero exit codes, the runner never rejects.
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
  killAll(): Promise<void>
}

export { TIMEOUT_EXIT_CODE }

/** Real runner: spawns children (no shell), collects output, per-command timeout. */
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

/** Wall-clock budget per repo.run command: 10 minutes, then SIGKILL (exit 124). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000

/** Max chars kept per output stream (dev-agent's result-summary rule). */
export const OUTPUT_MAX_CHARS = 4000

export function truncateOutput(text: string, max: number = OUTPUT_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max - 1)}…`, truncated: true }
}

/** Scopes the merge gate verifies in the worktree (mirrors the dev-agent gate). */
export const REPO_VERIFY_TARGETS = ['src/cli', 'src/lib/kernel', 'src/lib/server/mcp', 'modules'] as const

export type VerificationResult = {
  green: boolean
  vitestExit: number
  checkExit: number
  summary: string
}

/**
 * Verification gate: `npx vitest run <targets>` + `npm run check` inside the
 * worktree. Green = both exit 0. Summary carries exit codes + tails only.
 */
export async function verifyWorktree(
  commands: CommandRunner,
  cwd: string,
): Promise<VerificationResult> {
  const vitest = await commands.run({ cmd: 'npx', args: ['vitest', 'run', ...REPO_VERIFY_TARGETS], cwd })
  const check = await commands.run({ cmd: 'npm', args: ['run', 'check'], cwd })
  const green = vitest.exitCode === 0 && check.exitCode === 0
  const parts = [`verification: vitest exit ${vitest.exitCode}, check exit ${check.exitCode}`]
  if (vitest.exitCode !== 0) parts.push(`[vitest] ${tail(vitest.stderr || vitest.stdout)}`)
  if (check.exitCode !== 0) parts.push(`[check] ${tail(check.stderr || check.stdout)}`)
  return { green, vitestExit: vitest.exitCode, checkExit: check.exitCode, summary: parts.join('\n') }
}

function tail(text: string, max = 500): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`
}
