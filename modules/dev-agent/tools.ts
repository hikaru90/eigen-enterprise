import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { emitKernelEvent, type EventSink } from '$lib/kernel/events'
import type { ToolDescriptor } from '$lib/kernel/types'
import { verifyWorktree, type CommandRunner, type PiRunner } from './runner'
import {
  ACTIVE_RUN_STATUSES,
  assertTransition,
  canTransition,
  invalidRunState,
  runInProgressError,
  type DevAgentRunStatus,
} from './state'
import { type DevAgentRun, type DevAgentRunStore } from './store'

/** pi output + verification summary are persisted truncated to this size. */
const SUMMARY_MAX_CHARS = 4000

function truncate(text: string, max = SUMMARY_MAX_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function nowIso(): string {
  return new Date().toISOString()
}

export type DevAgentEngineDeps = {
  store: DevAgentRunStore
  pi: PiRunner
  commands: CommandRunner
  eventSink: EventSink
  /** Where `git rev-parse --show-toplevel` runs to find the MAIN repo. */
  baseCwd?: string
}

/**
 * The dev-agent run lifecycle: dispatch (single-flight) -> worktree sandbox ->
 * headless pi -> verification gate -> owner-gated merge | abort. All process
 * boundaries are injected; nothing here spawns by itself.
 */
export class DevAgentEngine {
  private readonly store: DevAgentRunStore
  private readonly pi: PiRunner
  private readonly commands: CommandRunner
  private readonly eventSink: EventSink
  private readonly baseCwd: string
  /** Serializes the single-flight gate so two dispatches cannot both pass it. */
  private chain: Promise<unknown> = Promise.resolve()
  private readonly inflight = new Map<string, Promise<void>>()

  constructor(deps: DevAgentEngineDeps) {
    this.store = deps.store
    this.pi = deps.pi
    this.commands = deps.commands
    this.eventSink = deps.eventSink
    this.baseCwd = deps.baseCwd ?? process.cwd()
  }

  /** Await all in-flight run executions (tests use this for determinism). */
  async settle(): Promise<void> {
    await Promise.all([...this.inflight.values()])
  }

  async dispatch(task: string, principalId: string): Promise<{ runId: string; status: 'dispatched' }> {
    const result = this.chain.then(() => this.dispatchLocked(task, principalId))
    this.chain = result.catch(() => undefined)
    return result
  }

  private async dispatchLocked(
    task: string,
    principalId: string,
  ): Promise<{ runId: string; status: 'dispatched' }> {
    const active = await this.store.findActive()
    if (active) throw runInProgressError(active.id)

    const repoRoot = await this.resolveRepoRoot()
    const runId = randomUUID()
    const branch = `wt/da/${runId}`
    const worktreePath = path.join(repoRoot, '..', `ee-da-${runId}`)

    await this.store.create({
      id: runId,
      task,
      status: 'dispatched',
      branch,
      worktreePath,
      startedAt: nowIso(),
    })
    await emitKernelEvent(this.eventSink, {
      type: 'dev-agent.dispatched',
      principalId,
      payload: { runId },
    })

    const execution = this.executeRun(runId, task, repoRoot, principalId).finally(() => {
      this.inflight.delete(runId)
    })
    this.inflight.set(runId, execution)

    return { runId, status: 'dispatched' }
  }

  /**
   * Sandbox execution: worktree add -> running -> pi -> verification gate.
   * pi failure = 'failed'; verification failure = 'red'; both green = 'green'.
   * Never logs task text or pi output — summaries only.
   */
  private async executeRun(
    runId: string,
    task: string,
    repoRoot: string,
    principalId: string,
  ): Promise<void> {
    try {
      const run = await this.requireRun(runId)
      await this.gitOrThrow(
        ['worktree', 'add', run.worktreePath, '-b', run.branch],
        repoRoot,
        'git worktree add failed',
      )
      await this.transition(runId, 'running')

      const piResult = await this.pi.run(task, run.worktreePath)
      if (!piResult.ok) {
        await this.store.update(runId, {
          status: 'failed',
          finishedAt: nowIso(),
          green: false,
          error: 'pi exited non-zero',
          resultSummary: truncate(piResult.output),
        })
        await this.emitCompleted(runId, principalId, false, false)
        return
      }

      const verification = await verifyWorktree(this.commands, run.worktreePath)
      const status: DevAgentRunStatus = verification.green ? 'green' : 'red'
      await this.transition(runId, status)
      await this.store.update(runId, {
        finishedAt: nowIso(),
        green: verification.green,
        resultSummary: truncate(`${verification.summary}\n--- pi output ---\n${piResult.output}`),
      })
      await this.emitCompleted(runId, principalId, verification.green, true)
    } catch (err) {
      const fresh = await this.store.get(runId)
      if (fresh && ACTIVE_RUN_STATUSES.includes(fresh.status)) {
        const message = err instanceof Error ? err.message : String(err)
        await this.store.update(runId, {
          status: 'failed',
          finishedAt: nowIso(),
          green: false,
          error: truncate(message, 500),
        })
        await this.emitCompleted(runId, principalId, false, false)
      }
      // Otherwise the run was aborted mid-flight; the abort path owns reporting.
    }
  }

  /**
   * Owner-approved landing: requires status 'green'; `git merge --no-edit` in
   * the MAIN repo, then worktree + branch cleanup. Any git failure throws loud
   * and the run stays 'green' (retryable).
   */
  async merge(runId: string, principalId: string): Promise<{ runId: string; branch: string; status: 'merged' }> {
    const run = await this.requireRun(runId)
    if (run.status !== 'green') {
      throw invalidRunState(`merge requires a green run; run ${runId} is ${run.status}`)
    }
    const repoRoot = await this.resolveRepoRoot()
    await this.gitOrThrow(['merge', '--no-edit', run.branch], repoRoot, 'git merge failed')
    await this.gitOrThrow(['worktree', 'remove', run.worktreePath], repoRoot, 'git worktree remove failed')
    await this.gitOrThrow(['branch', '-d', run.branch], repoRoot, 'git branch -d failed')

    assertTransition((await this.requireRun(runId)).status, 'merged')
    await this.store.update(runId, { status: 'merged', finishedAt: nowIso() })
    await emitKernelEvent(this.eventSink, {
      type: 'dev-agent.merged',
      principalId,
      payload: { runId },
    })
    return { runId, branch: run.branch, status: 'merged' }
  }

  /**
   * Abort a running run (kills pi / verification children) or a terminal one
   * (worktree cleanup). 'dispatched' is rejected — the worktree does not exist
   * yet; retry once the run is running. Git cleanup failures are loud and
   * leave the run in its current status (retryable).
   */
  async abort(runId: string, principalId: string): Promise<{ runId: string; status: 'aborted' }> {
    let run = await this.requireRun(runId)
    if (!canTransition(run.status, 'aborted')) {
      throw invalidRunState(`run ${runId} cannot be aborted from status ${run.status}`)
    }
    if (run.status === 'running') {
      await this.commands.killAll()
      await this.settle()
      run = await this.requireRun(runId)
    }

    const repoRoot = await this.resolveRepoRoot()
    await this.gitOrThrow(['worktree', 'remove', '--force', run.worktreePath], repoRoot, 'git worktree remove failed')
    await this.gitOrThrow(['branch', '-D', run.branch], repoRoot, 'git branch -D failed')
    assertTransition(run.status, 'aborted')
    await this.store.update(runId, { status: 'aborted', finishedAt: nowIso() })
    await emitKernelEvent(this.eventSink, {
      type: 'dev-agent.aborted',
      principalId,
      payload: { runId },
    })
    return { runId, status: 'aborted' }
  }

  /** One run or, without a runId, all runs (most recent first). */
  async status(runId?: string): Promise<DevAgentRun | DevAgentRun[]> {
    if (runId === undefined) return this.store.list()
    const run = await this.store.get(runId)
    if (!run) throw invalidRunState(`unknown dev-agent run: ${runId}`)
    return run
  }

  /** Full run row including the persisted (truncated) pi output. */
  async logs(runId: string): Promise<DevAgentRun> {
    const run = await this.store.get(runId)
    if (!run) throw invalidRunState(`unknown dev-agent run: ${runId}`)
    return run
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

  private async requireRun(runId: string): Promise<DevAgentRun> {
    const run = await this.store.get(runId)
    if (!run) throw invalidRunState(`unknown dev-agent run: ${runId}`)
    return run
  }

  private async transition(runId: string, to: DevAgentRunStatus): Promise<void> {
    const run = await this.requireRun(runId)
    assertTransition(run.status, to)
    await this.store.update(runId, { status: to })
  }

  private async gitOrThrow(args: string[], cwd: string, label: string): Promise<void> {
    const result = await this.commands.run({ cmd: 'git', args, cwd })
    if (result.exitCode !== 0) {
      throw new Error(`${label} (exit ${result.exitCode}): ${(result.stderr || result.stdout).trim()}`)
    }
  }

  private async emitCompleted(
    runId: string,
    principalId: string,
    green: boolean,
    ok: boolean,
  ): Promise<void> {
    await emitKernelEvent(this.eventSink, {
      type: 'dev-agent.completed',
      principalId,
      payload: { runId, green, ok },
    })
  }
}

const dispatchInput = z.object({ task: z.string().min(1) })
const runIdInput = z.object({ runId: z.string().uuid() })
const statusInput = z.object({ runId: z.string().uuid().optional() })

export type DevAgentToolDeps = {
  engine: DevAgentEngine
}

/** Kernel descriptors for the dev-agent surface (see DEV_AGENT_TOOL_NAMES). */
export function createDevAgentTools(deps: DevAgentToolDeps): ToolDescriptor[] {
  const engine = deps.engine
  return [
    {
      name: 'dev-agent.dispatch',
      module: 'dev-agent',
      summary:
        'Dispatch one code task to the headless pi coding agent in a fresh git worktree sandbox. One run at a time; fails with run_in_progress while another run is active.',
      auditClass: 'external',
      inputSchema: dispatchInput,
      permission: { roles: ['owner', 'agent'] },
      handler: async (ctx, input) => {
        const parsed = dispatchInput.parse(input)
        return engine.dispatch(parsed.task, ctx.principal.id)
      },
    },
    {
      name: 'dev-agent.status',
      module: 'dev-agent',
      summary: 'Run status: one run by id, or all runs (most recent first).',
      auditClass: 'read',
      inputSchema: statusInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const parsed = statusInput.parse(input)
        return engine.status(parsed.runId)
      },
    },
    {
      name: 'dev-agent.logs',
      module: 'dev-agent',
      summary: 'Full log of one run, including the stored (truncated) pi output.',
      auditClass: 'read',
      inputSchema: runIdInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const parsed = runIdInput.parse(input)
        return engine.logs(parsed.runId)
      },
    },
    {
      name: 'dev-agent.merge',
      module: 'dev-agent',
      summary:
        'Owner-approved landing: merge a green run branch into main, then remove its worktree and branch. Fails loud, run stays green, on any git failure.',
      auditClass: 'mutate',
      inputSchema: runIdInput,
      permission: { roles: ['owner'] },
      handler: async (ctx, input) => {
        const parsed = runIdInput.parse(input)
        return engine.merge(parsed.runId, ctx.principal.id)
      },
    },
    {
      name: 'dev-agent.abort',
      module: 'dev-agent',
      summary:
        'Abort a run: kill the in-flight pi/verification processes or clean up a finished run worktree. Not allowed for merged or already aborted runs.',
      auditClass: 'mutate',
      inputSchema: runIdInput,
      permission: { roles: ['owner', 'admin'] },
      handler: async (ctx, input) => {
        const parsed = runIdInput.parse(input)
        return engine.abort(parsed.runId, ctx.principal.id)
      },
    },
  ]
}
