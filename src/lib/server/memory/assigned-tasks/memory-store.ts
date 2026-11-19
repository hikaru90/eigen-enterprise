import type { AssignedTask, AssignedTaskComment, AssignedTaskStore } from './store'

/** In-memory AssignedTaskStore for tests: the same contract as the Postgres store. */
export function memoryAssignedTaskStore(): AssignedTaskStore & { tasks: Map<string, AssignedTask> } {
  const tasks = new Map<string, AssignedTask>()
  const comments: AssignedTaskComment[] = []
  const mustGet = (id: string) => {
    const task = tasks.get(id)
    if (!task) throw new Error(`assigned task ${id} not found`)
    return task
  }
  return {
    tasks,
    async insert(task) {
      if (tasks.has(task.id)) throw new Error(`assigned task ${task.id} exists`)
      tasks.set(task.id, { ...task })
    },
    async get(id) {
      const task = tasks.get(id)
      return task ? { ...task } : null
    },
    async listFor(userId) {
      return [...tasks.values()]
        .filter((t) => t.assignerId === userId || t.assigneeId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((t) => ({ ...t }))
    },
    async complete(id, at) {
      const task = mustGet(id)
      if (task.status !== 'open') return null
      Object.assign(task, {
        status: 'done',
        completedAt: at,
        updatedAt: at,
        assignerUpdate: 'completed',
        assignerUpdateAt: at,
        assigneeSeenAt: at,
      } satisfies Partial<AssignedTask>)
      return { ...task }
    },
    async addComment(comment, authorSide) {
      const task = mustGet(comment.taskId)
      comments.push({ ...comment })
      task.updatedAt = comment.createdAt
      if (authorSide === 'assigner') {
        task.assigneeUpdate = 'commented'
        task.assigneeUpdateAt = comment.createdAt
        task.assignerSeenAt = comment.createdAt
      } else {
        task.assignerUpdate = 'commented'
        task.assignerUpdateAt = comment.createdAt
        task.assigneeSeenAt = comment.createdAt
      }
      return { ...task }
    },
    async markSeen(id, side, at) {
      const task = mustGet(id)
      if (side === 'assigner') task.assignerSeenAt = at
      else task.assigneeSeenAt = at
    },
    async comments(taskIds) {
      const ids = new Set(taskIds)
      return comments
        .filter((c) => ids.has(c.taskId))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((c) => ({ ...c }))
    },
  }
}
