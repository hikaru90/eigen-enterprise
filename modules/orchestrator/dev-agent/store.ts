import { desc, eq, inArray } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import type { AppDatabase } from '$lib/server/db/context'
import { kernelDevagentRuns } from '$lib/server/db/devagent.schema'
import {
  ACTIVE_RUN_STATUSES,
  type DevAgentRunStatus,
  invalidRunState,
} from './state'

export type DevAgentRun = {
  id: string
  task: string
  status: DevAgentRunStatus
  branch: string
  worktreePath: string
  /** ISO-8601. */
  startedAt: string
  finishedAt: string | null
  /** pi output tail + verification summary (truncated before persisting). */
  resultSummary: string | null
  green: boolean | null
  error: string | null
}

export type CreateDevAgentRun = {
  id: string
  task: string
  status: DevAgentRunStatus
  branch: string
  worktreePath: string
  startedAt: string
}

export type DevAgentRunPatch = {
  status?: DevAgentRunStatus
  finishedAt?: string | null
  resultSummary?: string | null
  green?: boolean | null
  error?: string | null
}

export type DevAgentRunStore = {
  create(run: CreateDevAgentRun): Promise<DevAgentRun>
  get(id: string): Promise<DevAgentRun | null>
  /** All runs, most recent first. */
  list(): Promise<DevAgentRun[]>
  /** Unknown id fails loud. */
  update(id: string, patch: DevAgentRunPatch): Promise<DevAgentRun>
  /** The run currently holding the sandbox slot (dispatched|running), or null. */
  findActive(): Promise<DevAgentRun | null>
}

/** In-memory DevAgentRunStore for tests and in-memory kernel wiring. */
export class InMemoryDevAgentRunStore implements DevAgentRunStore {
  private readonly runs = new Map<string, DevAgentRun>()
  private order: string[] = []

  async create(run: CreateDevAgentRun): Promise<DevAgentRun> {
    if (this.runs.has(run.id)) {
      throw new Error(`duplicate dev-agent run id: ${run.id}`)
    }
    const row: DevAgentRun = {
      id: run.id,
      task: run.task,
      status: run.status,
      branch: run.branch,
      worktreePath: run.worktreePath,
      startedAt: run.startedAt,
      finishedAt: null,
      resultSummary: null,
      green: null,
      error: null,
    }
    this.runs.set(row.id, row)
    this.order.unshift(row.id)
    return row
  }

  async get(id: string): Promise<DevAgentRun | null> {
    return this.runs.get(id) ?? null
  }

  async list(): Promise<DevAgentRun[]> {
    return this.order.map((id) => this.runs.get(id)).filter((run) => run !== undefined)
  }

  async update(id: string, patch: DevAgentRunPatch): Promise<DevAgentRun> {
    const current = this.runs.get(id)
    if (!current) throw invalidRunState(`unknown dev-agent run: ${id}`)
    const updated: DevAgentRun = {
      ...current,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.finishedAt === undefined ? {} : { finishedAt: patch.finishedAt }),
      ...(patch.resultSummary === undefined ? {} : { resultSummary: patch.resultSummary }),
      ...(patch.green === undefined ? {} : { green: patch.green }),
      ...(patch.error === undefined ? {} : { error: patch.error }),
    }
    this.runs.set(id, updated)
    return updated
  }

  async findActive(): Promise<DevAgentRun | null> {
    for (const id of this.order) {
      const run = this.runs.get(id)
      if (run && ACTIVE_RUN_STATUSES.includes(run.status)) return run
    }
    return null
  }
}

type RunRow = typeof kernelDevagentRuns.$inferSelect

function toRun(row: RunRow): DevAgentRun {
  return {
    id: row.id,
    task: row.task,
    status: row.status as DevAgentRunStatus,
    branch: row.branch,
    worktreePath: row.worktreePath,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    resultSummary: row.resultSummary,
    green: row.green,
    error: row.error,
  }
}

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

/** DevAgentRunStore persisting to kernel_devagent_runs. */
export class DbDevAgentRunStore implements DevAgentRunStore {
  constructor(private readonly db: DbHandle) {}

  async create(run: CreateDevAgentRun): Promise<DevAgentRun> {
    const rows = await (
      await resolveDb(this.db)
    )
      .insert(kernelDevagentRuns)
      .values({
        id: run.id,
        task: run.task,
        status: run.status,
        branch: run.branch,
        worktreePath: run.worktreePath,
        startedAt: new Date(run.startedAt),
      })
      .returning()
    if (!rows[0]) throw new Error('dev-agent run insert returned no row')
    return toRun(rows[0])
  }

  async get(id: string): Promise<DevAgentRun | null> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select()
      .from(kernelDevagentRuns)
      .where(eq(kernelDevagentRuns.id, id))
      .limit(1)
    return rows[0] ? toRun(rows[0]) : null
  }

  async list(): Promise<DevAgentRun[]> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select()
      .from(kernelDevagentRuns)
      .orderBy(desc(kernelDevagentRuns.startedAt))
    return rows.map(toRun)
  }

  async update(id: string, patch: DevAgentRunPatch): Promise<DevAgentRun> {
    const rows = await (
      await resolveDb(this.db)
    )
      .update(kernelDevagentRuns)
      .set({
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.finishedAt === undefined
          ? {}
          : { finishedAt: patch.finishedAt === null ? null : new Date(patch.finishedAt) }),
        ...(patch.resultSummary === undefined ? {} : { resultSummary: patch.resultSummary }),
        ...(patch.green === undefined ? {} : { green: patch.green }),
        ...(patch.error === undefined ? {} : { error: patch.error }),
      })
      .where(eq(kernelDevagentRuns.id, id))
      .returning()
    if (!rows[0]) throw invalidRunState(`unknown dev-agent run: ${id}`)
    return toRun(rows[0])
  }

  async findActive(): Promise<DevAgentRun | null> {
    const rows = await (
      await resolveDb(this.db)
    )
      .select()
      .from(kernelDevagentRuns)
      .where(inArray(kernelDevagentRuns.status, [...ACTIVE_RUN_STATUSES]))
      .orderBy(desc(kernelDevagentRuns.startedAt))
      .limit(1)
    return rows[0] ? toRun(rows[0]) : null
  }
}

/**
 * Production store handle: lazily resolves the request-scoped DB (when inside
 * a request/ALS context) or the pooled app handle, so wiring never opens a
 * connection.
 */
export function defaultDevAgentStore(): DevAgentRunStore {
  const db: DbHandle = async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    const scoped = appDbAsyncLocal.getStore()
    if (scoped) return scoped
    return createScopedDrizzle(appSql)
  }
  return new DbDevAgentRunStore(db)
}
