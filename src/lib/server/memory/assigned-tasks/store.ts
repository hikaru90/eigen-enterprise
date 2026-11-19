/**
 * Assigned tasks: the store port (live: db-store.ts over migration 0158;
 * tests: memory-store.ts). The rules — who may read or change what — live in
 * service.ts; a store only persists.
 */

export type AssignedTaskStatus = 'open' | 'done'
/** What happened for the assignee: they were given the task, or the assigner commented. */
export type AssigneeUpdate = 'assigned' | 'commented'
/** What happened for the assigner: the assignee completed the task or commented. */
export type AssignerUpdate = 'completed' | 'commented'
export type TaskSide = 'assigner' | 'assignee'

export type AssignedTask = {
  id: string
  assignerId: string
  assigneeId: string
  title: string
  context: string
  /** YYYY-MM-DD, or null. */
  dueOn: string | null
  status: AssignedTaskStatus
  createdVia: 'person' | 'assistant'
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  assigneeUpdate: AssigneeUpdate | null
  assigneeUpdateAt: Date | null
  assigneeSeenAt: Date | null
  assignerUpdate: AssignerUpdate | null
  assignerUpdateAt: Date | null
  assignerSeenAt: Date | null
}

export type AssignedTaskComment = {
  id: string
  taskId: string
  authorId: string
  body: string
  createdAt: Date
}

export type AssignedTaskStore = {
  insert(task: AssignedTask): Promise<void>
  get(id: string): Promise<AssignedTask | null>
  /** Every task the person assigned or was assigned, newest first. */
  listFor(userId: string): Promise<AssignedTask[]>
  /**
   * Marks an open task done at `at` (the assigner gets a 'completed' update,
   * the assignee's side counts as seen). Null when the task is not open.
   */
  complete(id: string, at: Date): Promise<AssignedTask | null>
  /** Adds a comment; the other side gets a 'commented' update, the author's side counts as seen. */
  addComment(comment: AssignedTaskComment, authorSide: TaskSide): Promise<AssignedTask>
  /** The person on `side` acknowledged everything up to `at`. */
  markSeen(id: string, side: TaskSide, at: Date): Promise<void>
  /** The comments on these tasks, oldest first. */
  comments(taskIds: readonly string[]): Promise<AssignedTaskComment[]>
}
