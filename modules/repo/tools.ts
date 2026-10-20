import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { moduleSource } from '$lib/kernel/cloudevents'
import { KernelError } from '$lib/kernel/errors'
import { emitKernelEvent, type EventSink } from '$lib/kernel/events'
import type { ToolDescriptor } from '$lib/kernel/types'
import { parseAllowlistedCommand } from './allowlist'
import { assertSafeSubpath } from './paths'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  TIMEOUT_EXIT_CODE,
  truncateOutput,
  verifyWorktree,
  type CommandRunner,
  type VerificationResult,
} from './runner'

type WorktreeRecord = {
  id: string
  path: string
  branch: string
}

export type RepoEngineDeps = {
  commands: CommandRunner
  eventSink: EventSink
  /** Where `git rev-parse --show-toplevel` runs to find the MAIN repo. */
  baseCwd?: string
  /** Wall-clock budget per repo.run command. */
  timeoutMs?: number
  /** Verification seam (tests inject a fixture gate; production pins the vitest+check gate). */
  verify?: (commands: CommandRunner, cwd: string) => Promise<VerificationResult>
}

/**
 * The agent's repo hands: worktree sandbox per calling principal, allowlisted
 * commands, safe file read/write, and a verified + approval-gated merge back
 * into the instance repo. All process boundaries are injected; nothing here
 * spawns by itself. No DB state — git history + kernel_events are the log.
 */
export class RepoEngine {
  private readonly commands: CommandRunner
  private readonly eventSink: EventSink
  private readonly baseCwd: string
  private readonly timeoutMs: number
  private readonly verify: (commands: CommandRunner, cwd: string) => Promise<VerificationResult>
  /** One live worktree per calling principal (the calling session's context). */
  private readonly worktrees = new Map<string, WorktreeRecord>()

  constructor(deps: RepoEngineDeps) {
    this.commands = deps.commands
    this.eventSink = deps.eventSink
    this.baseCwd = deps.baseCwd ?? process.cwd()
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    this.verify = deps.verify ?? verifyWorktree
  }

  /**
   * Create the caller's worktree: `git worktree add ../ee-agent-<id> -b
   * wt/agent-<id>` in the MAIN repo. Idempotent per principal: an existing
   * worktree returns `{ created: false, path }`; real git failures fail loud.
   */
  async worktreeCreate(principalId: string): Promise<{ created: boolean; path: string; branch: string }> {
    const existing = this.worktrees.get(principalId)
    if (existing) {
      return { created: false, path: existing.path, branch: existing.branch }
    }

    const repoRoot = await this.resolveRepoRoot()
    const id = randomUUID().replaceAll('-', '').slice(0, 8)
    const worktreePath = path.join(repoRoot, '..', `ee-agent-${id}`)
    const branch = `wt/agent-${id}`

    await this.gitOrThrow(
      ['worktree', 'add', worktreePath, '-b', branch],
      repoRoot,
      'git worktree add failed',
    )
    const record: WorktreeRecord = { id, path: worktreePath, branch }
    this.worktrees.set(principalId, record)
    await emitKernelEvent(this.eventSink, {
      type: 'repo.worktree_created',
      principalId,
      source: moduleSource('repo'),
      payload: { id, path: worktreePath, branch },
    })
    return { created: true, path: worktreePath, branch }
  }

  /**
   * Run an allowlisted command in the worktree. Non-zero exits are RESULTS
   * (the agent must see failures); infra errors (timeout) throw loud.
   * Events carry command + exitCode only, never output content.
   */
  async run(
    principalId: string,
    worktreePath: string,
    command: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }> {
    const parsed = parseAllowlistedCommand(command)
    this.assertArgsInsideWorktree(parsed, worktreePath)

    const result = await this.commands.run({
      cmd: parsed.cmd,
      args: parsed.args,
      cwd: worktreePath,
      timeoutMs: this.timeoutMs,
    })
    if (result.exitCode === TIMEOUT_EXIT_CODE) {
      throw new Error(`repo.run command timed out after ${this.timeoutMs}ms: ${command}`)
    }

    const stdout = truncateOutput(result.stdout)
    const stderr = truncateOutput(result.stderr)
    await emitKernelEvent(this.eventSink, {
      type: 'repo.command_run',
      principalId,
      source: moduleSource('repo'),
      payload: { command, exitCode: result.exitCode },
    })
    return {
      exitCode: result.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
    }
  }

  /** Write a file inside the worktree (mkdir -p semantics). Secret paths are refused. */
  async writeFile(
    principalId: string,
    worktreePath: string,
    subPath: string,
    content: string,
  ): Promise<{ path: string }> {
    const resolved = assertSafeSubpath(worktreePath, subPath, 'write')
    await mkdir(path.dirname(resolved), { recursive: true })
    await writeFile(resolved, content, 'utf8')
    await emitKernelEvent(this.eventSink, {
      type: 'repo.file_written',
      principalId,
      source: moduleSource('repo'),
      payload: { path: subPath },
    })
    return { path: subPath }
  }

  /** Read a file from inside the worktree. Secret paths are refused (exfiltration). */
  async readFile(worktreePath: string, subPath: string): Promise<{ content: string }> {
    const resolved = assertSafeSubpath(worktreePath, subPath, 'read')
    return { content: await readFile(resolved, 'utf8') }
  }

  /**
   * Verified landing: server-side verification gate IN the worktree (red = no
   * merge), commit pending changes, `git merge --no-edit` into the instance
   * repo, worktree + branch cleanup. Merge conflicts fail loud with owner-ask
   * guidance — no resolution attempts. The approval gate (owner yes in chat)
   * fires in the kernel BEFORE this handler runs.
   */
  async merge(
    principalId: string,
    worktreePath: string,
    message: string,
  ): Promise<{ verified: true; committed: boolean; merged: true; commitSubject: string }> {
    const branch = branchForWorktree(worktreePath)
    const repoRoot = await this.resolveRepoRoot()

    const verification = await this.verify(this.commands, worktreePath)
    if (!verification.green) {
      await emitKernelEvent(this.eventSink, {
        type: 'repo.verify_failed',
        principalId,
        source: moduleSource('repo'),
        payload: { path: worktreePath, vitestExit: verification.vitestExit, checkExit: verification.checkExit },
      })
      throw new KernelError(
        'invalid_input',
        `verification gate failed: ${verification.summary} — fix the worktree before merging; the merge was refused`,
      )
    }

    const status = await this.commands.run({
      cmd: 'git',
      args: ['status', '--porcelain'],
      cwd: worktreePath,
    })
    let committed = false
    if (status.stdout.trim() !== '') {
      await this.gitOrThrow(['add', '-A'], worktreePath, 'git add -A failed')
      await this.gitOrThrow(['commit', '-m', message], worktreePath, 'git commit failed')
      committed = true
    }

    try {
      await this.gitOrThrow(['merge', '--no-edit', branch], repoRoot, 'git merge failed')
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new KernelError(
        'invalid_input',
        `git merge failed — STOP and ask the owner; do not resolve conflicts yourself. ${detail}`,
      )
    }

    await this.gitOrThrow(['worktree', 'remove', worktreePath], repoRoot, 'git worktree remove failed')
    await this.gitOrThrow(['branch', '-d', branch], repoRoot, 'git branch -d failed')
    this.worktrees.delete(principalId)

    const subject = await this.commands.run({
      cmd: 'git',
      args: ['log', '-1', '--format=%s'],
      cwd: repoRoot,
    })
    const commitSubject = subject.stdout.trim()
    await emitKernelEvent(this.eventSink, {
      type: 'repo.merged',
      principalId,
      source: moduleSource('repo'),
      payload: { path: worktreePath, branch, commitSubject },
    })
    return { verified: true, committed, merged: true, commitSubject }
  }

  /** fs-path and node-script args must resolve inside the worktree (engine-side double check). */
  private assertArgsInsideWorktree(parsed: ReturnType<typeof parseAllowlistedCommand>, worktreePath: string): void {
    if (parsed.kind === 'fs-paths') {
      for (const arg of parsed.args) assertSafeSubpath(worktreePath, arg, 'write')
    }
    if (parsed.kind === 'node-script') {
      assertSafeSubpath(worktreePath, parsed.args[0]!, 'read')
    }
  }

  private async resolveRepoRoot(): Promise<string> {
    const result = await this.commands.run({
      cmd: 'git',
      args: ['rev-parse', '--show-toplevel'],
      cwd: this.baseCwd,
    })
    if (result.exitCode !== 0) {
      throw new Error(`cannot resolve repo root (git rev-parse --show-toplevel): ${result.stderr.trim()}`)
    }
    return result.stdout.trim()
  }

  private async gitOrThrow(args: string[], cwd: string, label: string): Promise<void> {
    const result = await this.commands.run({ cmd: 'git', args, cwd })
    if (result.exitCode !== 0) {
      throw new Error(`${label} (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`)
    }
  }
}

/** Only worktrees created by repo.worktree_create (ee-agent-*) may be merged. */
function branchForWorktree(worktreePath: string): string {
  const base = path.basename(worktreePath)
  const match = /^ee-agent-([0-9a-f]+)$/.exec(base)
  if (!match) {
    throw new KernelError(
      'invalid_input',
      `repo.merge only lands agent worktrees named ee-agent-<id> (from repo.worktree_create), got: "${base}"`,
    )
  }
  return `wt/agent-${match[1]}`
}

const worktreeCreateInput = z.object({}).strip()
const runInput = z.object({ worktreePath: z.string().min(1), command: z.string().min(1) })
const writeFileInput = z.object({
  worktreePath: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
})
const readFileInput = z.object({ worktreePath: z.string().min(1), path: z.string().min(1) })
const mergeInput = z.object({ worktreePath: z.string().min(1), message: z.string().min(1) })

export type RepoToolDeps = {
  engine: RepoEngine
}

/** Kernel descriptors for the repo module surface (see REPO_TOOL_NAMES). */
export function createRepoTools(deps: RepoToolDeps): ToolDescriptor[] {
  const engine = deps.engine
  return [
    {
      name: 'repo.worktree_create',
      module: 'repo',
      summary:
        'Create your git worktree sandbox (ee-agent-<id> on wt/agent-<id>) in the main repo. Idempotent: returns the existing worktree with created:false.',
      auditClass: 'external',
      activity: () => 'Opened a workspace for code changes',
      inputSchema: worktreeCreateInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => engine.worktreeCreate(ctx.principal.id),
    },
    {
      name: 'repo.run',
      module: 'repo',
      summary:
        'Run an allowlisted command (npm test, npm run check/lint/db:migrate, npx vitest run, git add/commit -m/status/diff/log, mkdir/cp/mv, node scripts/*) inside your worktree. Non-zero exit is a result, not an error.',
      auditClass: 'external',
      activity: (input: z.infer<typeof runInput>) => `Ran “${input.command}” in the code workspace`,
      inputSchema: runInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const parsed = runInput.parse(input)
        return engine.run(ctx.principal.id, parsed.worktreePath, parsed.command)
      },
    },
    {
      name: 'repo.write_file',
      module: 'repo',
      summary:
        'Write a file inside your worktree (creates parent dirs). Paths must stay inside the worktree; .env*/key/pem material is refused.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof writeFileInput>) => `Wrote the file ${input.path}`,
      inputSchema: writeFileInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const parsed = writeFileInput.parse(input)
        return engine.writeFile(ctx.principal.id, parsed.worktreePath, parsed.path, parsed.content)
      },
    },
    {
      name: 'repo.read_file',
      module: 'repo',
      summary:
        'Read a file from inside your worktree. Paths must stay inside the worktree; .env*/key/pem material is refused.',
      auditClass: 'read',
      inputSchema: readFileInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const parsed = readFileInput.parse(input)
        return engine.readFile(parsed.worktreePath, parsed.path)
      },
    },
    {
      name: 'repo.merge',
      module: 'repo',
      summary:
        'Land your worktree branch on the main repo: server-side verification gate first (vitest + typecheck must be green), then commit, merge, and cleanup. Owner approval required; on conflicts, stop and ask the owner.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof mergeInput>) => `Merged code changes: “${input.message}”`,
      approvalRisk: 'destructive',
      inputSchema: mergeInput,
      permission: { roles: ['admin', 'agent', 'owner'] },
      handler: async (ctx, input) => {
        const parsed = mergeInput.parse(input)
        return engine.merge(ctx.principal.id, parsed.worktreePath, parsed.message)
      },
    },
  ]
}
