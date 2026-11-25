/**
 * Team questions: the store port (live: db-store.ts over migration 0183,
 * company-level tables; tests: memory-store.ts). The store filters by the
 * structural audience match (the viewer's id and groups); the rules — who may
 * ask, answer, close — live in service.ts.
 */

export type QuestionStatus = 'open' | 'closed'
export type QuestionVia = 'person' | 'assistant'

export type TeamQuestion = {
  id: string
  authorId: string
  text: string
  tags: string[]
  audienceKind: 'company' | 'chosen'
  audienceGroupIds: string[]
  audienceUserIds: string[]
  status: QuestionStatus
  createdVia: QuestionVia
  createdAt: Date
  updatedAt: Date
  closedAt: Date | null
}

export type TeamQuestionAnswer = {
  id: string
  questionId: string
  authorId: string
  body: string
  createdVia: QuestionVia
  createdAt: Date
}

/** Who reads: the person and the groups they are in right now. */
export type QuestionViewer = { userId: string; groupIds: string[] }

export type TeamQuestionStore = {
  insert(question: TeamQuestion): Promise<void>
  get(id: string): Promise<TeamQuestion | null>
  /** Questions the viewer asked or is in the audience of, newest first. */
  listVisible(viewer: QuestionViewer): Promise<TeamQuestion[]>
  /** Adds the answer while the question is open; null when it is gone or closed. */
  addAnswer(answer: TeamQuestionAnswer): Promise<TeamQuestion | null>
  /** Closes an open question; null when it is gone or already closed. */
  close(id: string, at: Date): Promise<TeamQuestion | null>
  /** The answers of these questions, oldest first. */
  answers(questionIds: string[]): Promise<TeamQuestionAnswer[]>
}

/** The structural audience match both stores apply (and the service re-checks on get). */
export function inAudience(q: TeamQuestion, viewer: QuestionViewer): boolean {
  if (q.authorId === viewer.userId) return true
  if (q.audienceKind === 'company') return true
  if (q.audienceUserIds.includes(viewer.userId)) return true
  return q.audienceGroupIds.some((g) => viewer.groupIds.includes(g))
}
