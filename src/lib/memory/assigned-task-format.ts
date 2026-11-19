import type { AssignedTaskView } from '$lib/server/memory/assigned-tasks/service'

/**
 * How an assigned task reads on the dashboard's Needs you and in Memory ›
 * Tasks: who gave it to whom, its due day and what is new for the viewer.
 */

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** "due 21 Nov 2026" — the stored calendar day as is (no time zone shift); null without a due day. */
export function dueLabel(dueOn: string | null): string | null {
  return dueOn ? `due ${dayFormat.format(new Date(`${dueOn}T00:00:00Z`))}` : null
}

/** "From Alex" for the assignee, "To Ony" for the assigner. */
export function partyLabel(task: Pick<AssignedTaskView, 'role' | 'assigner' | 'assignee'>): string {
  return task.role === 'assignee' ? `From ${task.assigner.name}` : `To ${task.assignee.name}`
}

/** The unseen update in one line ("Ony completed 'X'"); null when nothing is new for the viewer. */
export function updateLine(task: Pick<AssignedTaskView, 'title' | 'update' | 'assigner' | 'assignee' | 'role'>): string | null {
  if (!task.update) return null
  const other = task.role === 'assignee' ? task.assigner.name : task.assignee.name
  switch (task.update.kind) {
    case 'assigned':
      return `${task.assigner.name} assigned you '${task.title}'`
    case 'completed':
      return `${task.assignee.name} completed '${task.title}'`
    case 'commented':
      return `${other} commented on '${task.title}'`
  }
}

/** The meta line under a task's title: who, when due, and whether it is done. */
export function metaLine(task: Pick<AssignedTaskView, 'role' | 'assigner' | 'assignee' | 'dueOn' | 'status' | 'createdVia'>): string {
  return [
    partyLabel(task),
    task.createdVia === 'assistant' ? 'via the assistant' : null,
    dueLabel(task.dueOn),
    task.status === 'done' ? 'done' : null,
  ]
    .filter(Boolean)
    .join(' · ')
}
