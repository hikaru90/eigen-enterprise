import type { InboxDeps, InboxSourceItem } from './inbox'

/**
 * The inbox's sources (see inbox.ts), mapped structurally: which source an item
 * comes from decides its kind; the words are fixed per kind and status.
 * Handover entries are not a source (the feature is being removed).
 */

type Person = { id: string; name: string }
type TaskLike = { id: string; title: string; assigner: Person; assignee: Person; createdAt: string; update: { kind: string; at: string } | null }

export type InboxSourceData = {
  /** Team questions for the person (questions.list for_me). */
  questions: Array<{ id: string; text: string; author: Person; createdAt: string }>
  /** Needs you tasks (tasks given to the person; news on the ones they gave out). */
  tasks: { assignedToMe: TaskLike[]; updates: TaskLike[] }
  /** AI co-workers' finished or stopped runs (coworkers.needs_you). */
  notices: Array<{ run: { id: string; status: string }; coworker: Person; at: string; href: string }>
}

const QUESTIONS_HREF = '/m/memory/questions'
const TASKS_HREF = '/m/memory/tasks#assigned'
const ASSIGNER_NEWS: Record<string, string> = { completed: 'completed your task', commented: 'commented on your task' }

export function inboxItemsFrom(data: InboxSourceData): InboxSourceItem[] {
  const questions = data.questions.map((q) => ({
    key: `question:${q.id}`,
    kind: 'question' as const,
    title: `${q.author.name} asks`,
    detail: q.text,
    href: QUESTIONS_HREF,
    at: q.createdAt,
  }))
  const given = data.tasks.assignedToMe.map((t) => {
    const at = t.update?.at ?? t.createdAt
    return { key: `task:${t.id}:${at}`, kind: 'task' as const, title: `${t.assigner.name} gave you a task`, detail: t.title, href: TASKS_HREF, at }
  })
  const news = data.tasks.updates.flatMap((t) => {
    if (!t.update) return []
    const verb = ASSIGNER_NEWS[t.update.kind]
    if (!verb) throw new Error(`Unknown task update kind: ${t.update.kind}`)
    return [{ key: `task:${t.id}:${t.update.at}`, kind: 'task_update' as const, title: `${t.assignee.name} ${verb}`, detail: t.title, href: TASKS_HREF, at: t.update.at }]
  })
  const notices = data.notices.map((n) => ({
    key: `coworker:${n.run.id}`,
    kind: 'coworker' as const,
    title: `${n.coworker.name} ${n.run.status === 'done' ? 'finished' : n.run.status}`,
    detail: 'A result is waiting on you',
    href: n.href,
    at: n.at,
  }))
  return [...questions, ...given, ...news, ...notices]
}

/** The live sources: the same services the dashboard's Needs you and Memory › Questions read. */
export async function liveInboxSources(userId: string): Promise<InboxSourceItem[]> {
  const [{ listQuestions }, { teamQuestionDeps }, { needsYouTasks }, { assignedTaskDeps }, { needsYouNotices }, { liveNoticeDeps }] = await Promise.all([
    import('$lib/server/memory/team-questions/service'),
    import('$lib/server/memory/team-questions/live'),
    import('$lib/server/memory/assigned-tasks/service'),
    import('$lib/server/memory/assigned-tasks/live'),
    import('$lib/server/coworkers/notices'),
    import('$lib/server/coworkers/rhythm-live'),
  ])
  const [questions, tasks, notices] = await Promise.all([
    listQuestions(await teamQuestionDeps(), userId, { forMe: true }),
    needsYouTasks(await assignedTaskDeps(), userId),
    needsYouNotices(await liveNoticeDeps(), userId),
  ])
  return inboxItemsFrom({ questions: questions.questions, tasks, notices })
}

export async function liveInboxDeps(): Promise<InboxDeps> {
  const { dbNotificationReads } = await import('./reads-db-store')
  return { sources: liveInboxSources, reads: await dbNotificationReads() }
}
