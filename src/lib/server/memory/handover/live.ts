import type { HandoverDeps } from './service'
import { dbHandoverStore } from './db-store'

/**
 * Live wiring: the Postgres store over the app pool (company-level tables, no
 * RLS — like assigned tasks), the assigned tasks' member directory (people and
 * AI co-workers, never contacts), and assigning through the assigned-task
 * service itself — so an assigned entry is an ordinary assigned task: Needs
 * you, Memory › Tasks, push and email, an AI co-worker's turn.
 */

let deps: HandoverDeps | null = null

export async function handoverDeps(): Promise<HandoverDeps> {
  if (deps) return deps
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  const { assignedTaskDeps } = await import('$lib/server/memory/assigned-tasks/live')
  const { assignTask } = await import('$lib/server/memory/assigned-tasks/service')
  const db = createScopedDrizzle(appSql)
  const tasks = await assignedTaskDeps()
  deps = {
    store: dbHandoverStore(() => db),
    directory: tasks.directory,
    tasks: {
      assign: async (actor, input) => ({ id: (await assignTask(tasks, actor, input)).id }),
      status: async (taskId) => (await tasks.store.get(taskId))?.status ?? null,
    },
  }
  return deps
}
