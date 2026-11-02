import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Shell seam so every process boundary in this module is injectable (tests
 * never spawn real git/node). Failures
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

/** Conventional "timed out" exit code. */
export const TIMEOUT_EXIT_CODE = 124

/**
 * Real runner: spawns children (no shell), collects stdout/stderr, resolves
 * (never rejects) with exit codes (127 for ENOENT), enforces an optional
 * per-command timeout (SIGKILL, exitCode 124).
 */
export class NodeCommandRunner implements CommandRunner {
  private readonly active = new Set<ChildProcess>()

  run(spec: CommandSpec): Promise<CommandResult> {
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

    return new Promise<CommandResult>((resolve) => {
      const settle = (exitCode: number) => {
        if (timer !== undefined) clearTimeout(timer)
        this.active.delete(child)
        resolve({
          exitCode: timedOut ? TIMEOUT_EXIT_CODE : exitCode,
          stdout,
          stderr: timedOut ? `${stderr}\n[spawn] timed out after ${spec.timeoutMs}ms` : stderr,
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
    for (const child of this.active) child.kill('SIGKILL')
    this.active.clear()
  }
}

/** Wall-clock budget per repo.run command: 10 minutes, then SIGKILL (exit 124). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000

/** Max chars kept per output stream (result-summary rule). */
export const OUTPUT_MAX_CHARS = 4000

export function truncateOutput(text: string, max: number = OUTPUT_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max - 1)}…`, truncated: true }
}

/** Scopes the merge gate verifies in the worktree. */
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
