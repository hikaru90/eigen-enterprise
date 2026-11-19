import type { AssignedTask, AssignedTaskStore } from './store'
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'
import { assignedTaskComments, assignedTasks } from '$lib/server/db/assigned-tasks.schema'
import type { AppDatabase } from '$lib/server/db/context'

/** The Postgres AssignedTaskStore (migration 0158; company-level tables, no RLS — the service decides access). */
export function dbAssignedTaskStore(db: () => AppDatabase): AssignedTaskStore {
  return {
    async insert(task) {
      await db().insert(assignedTasks).values(task)
    },
    async get(id) {
      const [row] = await db().select().from(assignedTasks).where(eq(assignedTasks.id, id)).limit(1)
      return (row as AssignedTask | undefined) ?? null
    },
    async listFor(userId) {
      return (await db()
        .select()
        .from(assignedTasks)
        .where(or(eq(assignedTasks.assignerId, userId), eq(assignedTasks.assigneeId, userId)))
        .orderBy(desc(assignedTasks.createdAt), desc(assignedTasks.id))) as AssignedTask[]
    },
    async complete(id, at) {
      // Conditional on status: two completions at once leave exactly one winner.
      const [row] = await db()
        .update(assignedTasks)
        .set({ status: 'done', completedAt: at, updatedAt: at, assignerUpdate: 'completed', assignerUpdateAt: at, assigneeSeenAt: at })
        .where(and(eq(assignedTasks.id, id), eq(assignedTasks.status, 'open')))
        .returning()
      return (row as AssignedTask | undefined) ?? null
    },
    async addComment(comment, authorSide) {
      return db().transaction(async (tx) => {
        await tx.insert(assignedTaskComments).values(comment)
        const at = comment.createdAt
        const [row] = await tx
          .update(assignedTasks)
          .set(
            authorSide === 'assigner'
              ? { updatedAt: at, assigneeUpdate: 'commented', assigneeUpdateAt: at, assignerSeenAt: at }
              : { updatedAt: at, assignerUpdate: 'commented', assignerUpdateAt: at, assigneeSeenAt: at },
          )
          .where(eq(assignedTasks.id, comment.taskId))
          .returning()
        if (!row) throw new Error(`assigned task ${comment.taskId} not found`)
        return row as AssignedTask
      })
    },
    async markSeen(id, side, at) {
      const rows = await db()
        .update(assignedTasks)
        .set(side === 'assigner' ? { assignerSeenAt: at } : { assigneeSeenAt: at })
        .where(eq(assignedTasks.id, id))
        .returning({ id: assignedTasks.id })
      if (rows.length !== 1) throw new Error(`assigned task ${id} not found`)
    },
    async comments(taskIds) {
      if (taskIds.length === 0) return []
      return db()
        .select()
        .from(assignedTaskComments)
        .where(inArray(assignedTaskComments.taskId, [...taskIds]))
        .orderBy(asc(assignedTaskComments.createdAt), asc(assignedTaskComments.id))
    },
  }
}
