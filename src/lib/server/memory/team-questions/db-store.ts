import type { TeamQuestion, TeamQuestionAnswer, TeamQuestionStore } from './store'
import { and, arrayContains, arrayOverlaps, asc, desc, eq, inArray, or } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { teamQuestionAnswers, teamQuestions } from '$lib/server/db/team-questions.schema'

/** The Postgres TeamQuestionStore (migration 0183; company-level tables, no RLS — the service decides access). */
export function dbTeamQuestionStore(db: () => AppDatabase): TeamQuestionStore {
  const row = (r: unknown) => (r as TeamQuestion | undefined) ?? null
  return {
    async insert(question) {
      await db().insert(teamQuestions).values(question)
    },
    async get(id) {
      const [r] = await db().select().from(teamQuestions).where(eq(teamQuestions.id, id)).limit(1)
      return row(r)
    },
    async listVisible(viewer) {
      const audience = [
        eq(teamQuestions.authorId, viewer.userId),
        eq(teamQuestions.audienceKind, 'company'),
        arrayContains(teamQuestions.audienceUserIds, [viewer.userId]),
      ]
      if (viewer.groupIds.length > 0) audience.push(arrayOverlaps(teamQuestions.audienceGroupIds, viewer.groupIds))
      return (await db()
        .select()
        .from(teamQuestions)
        .where(or(...audience))
        .orderBy(desc(teamQuestions.createdAt), desc(teamQuestions.id))) as TeamQuestion[]
    },
    async addAnswer(answer) {
      return db().transaction(async (tx) => {
        // Conditional on status: an answer never lands on a question closed meanwhile.
        const [r] = await tx
          .update(teamQuestions)
          .set({ updatedAt: answer.createdAt })
          .where(and(eq(teamQuestions.id, answer.questionId), eq(teamQuestions.status, 'open')))
          .returning()
        if (!r) return null
        await tx.insert(teamQuestionAnswers).values(answer)
        return r as TeamQuestion
      })
    },
    async close(id, at) {
      const [r] = await db()
        .update(teamQuestions)
        .set({ status: 'closed', closedAt: at, updatedAt: at })
        .where(and(eq(teamQuestions.id, id), eq(teamQuestions.status, 'open')))
        .returning()
      return row(r)
    },
    async answers(questionIds) {
      if (questionIds.length === 0) return []
      return (await db()
        .select()
        .from(teamQuestionAnswers)
        .where(inArray(teamQuestionAnswers.questionId, questionIds))
        .orderBy(asc(teamQuestionAnswers.createdAt), asc(teamQuestionAnswers.id))) as TeamQuestionAnswer[]
    },
  }
}
