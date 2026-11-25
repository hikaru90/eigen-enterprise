import { inAudience, type TeamQuestion, type TeamQuestionAnswer, type TeamQuestionStore } from './store'

/** In-memory TeamQuestionStore for tests: the same contract as the Postgres store. */
export function memoryTeamQuestionStore(): TeamQuestionStore & {
  questions: Map<string, TeamQuestion>
  answerRows: TeamQuestionAnswer[]
} {
  const questions = new Map<string, TeamQuestion>()
  const answerRows: TeamQuestionAnswer[] = []
  const copy = (q: TeamQuestion): TeamQuestion => ({
    ...q,
    tags: [...q.tags],
    audienceGroupIds: [...q.audienceGroupIds],
    audienceUserIds: [...q.audienceUserIds],
  })
  return {
    questions,
    answerRows,
    async insert(question) {
      if (questions.has(question.id)) throw new Error(`question ${question.id} exists`)
      questions.set(question.id, copy(question))
    },
    async get(id) {
      const q = questions.get(id)
      return q ? copy(q) : null
    },
    async listVisible(viewer) {
      return [...questions.values()]
        .filter((q) => inAudience(q, viewer))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
        .map(copy)
    },
    async addAnswer(answer) {
      const q = questions.get(answer.questionId)
      if (!q || q.status !== 'open') return null
      answerRows.push({ ...answer })
      q.updatedAt = answer.createdAt
      return copy(q)
    },
    async close(id, at) {
      const q = questions.get(id)
      if (!q || q.status !== 'open') return null
      Object.assign(q, { status: 'closed', closedAt: at, updatedAt: at })
      return copy(q)
    },
    async answers(questionIds) {
      return answerRows
        .filter((a) => questionIds.includes(a.questionId))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((a) => ({ ...a }))
    },
  }
}
