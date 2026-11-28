import type { TeamQuestionBrain, TeamQuestionDeps } from './service'
import { dbTeamQuestionStore } from './db-store'

/**
 * Live wiring: the Postgres store over the app pool (company-level tables, no
 * RLS — like assigned tasks), the company's members as the directory (the user
 * table — never contacts) and the member groups.
 *
 * `list` (the audience picker) is the members listing: production accounts
 * only. `get` answers "is this one of the company's people", which includes a
 * harness account acting on its own box (automated verification signs in as
 * one): the listing filter keeps harness accounts out of member lists and seat
 * counts, it is not who may use the app. A removed AI co-worker is no one.
 *
 * `brain` (Contribute 057cd4d5 follow-up): an answer is captured into the answerer's
 * brain through the normal capture pipeline (enrichment, embedding, graph), linked to
 * the question, then company-sealed so the question's audience can decrypt it
 * (thought_team_question_read, drizzle/0203). It runs in the answerer's session (the
 * registry tool's), so the thought is theirs.
 */

/** The thought's text: the question and the answer, as the brain will read and retrieve it. */
export function answerThoughtText(question: string, answer: string): string {
  return `Team question: ${question}\nAnswer: ${answer}`
}

const brain: TeamQuestionBrain = {
  async rememberAnswer(a) {
    const [{ captureThought }, { reconcileThoughtKeys }] = await Promise.all([
      import('$lib/server/capture/service'),
      import('$lib/server/memory/shared-memory-keys'),
    ])
    const stored = await captureThought(a.answererId, answerThoughtText(a.question, a.answer), {
      source: a.via === 'assistant' ? 'agent' : 'ui',
      teamQuestionId: a.questionId,
    })
    await reconcileThoughtKeys(a.answererId, [stored.id])
    return { thoughtId: stored.id }
  },
}

let deps: TeamQuestionDeps | null = null

export async function teamQuestionDeps(): Promise<TeamQuestionDeps> {
  if (deps) return deps
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  const { dbMemberStore } = await import('$lib/server/members/db-store')
  const { dbGroupStore } = await import('$lib/server/members/groups-db-store')
  const { accountOf } = await import('$lib/server/members/account-of')
  const db = createScopedDrizzle(appSql)
  deps = {
    store: dbTeamQuestionStore(() => db),
    brain,
    directory: {
      async get(id) {
        const m = (await dbMemberStore.getMember(id)) ?? (await accountOf(id))
        return m ? { id: m.id, name: m.name } : null
      },
      async list() {
        return (await dbMemberStore.listMembers()).map((m) => ({ id: m.id, name: m.name }))
      },
    },
    groups: {
      list: async () => (await dbGroupStore.listGroups()).map((g) => ({ id: g.id, name: g.name, memberIds: g.memberIds })),
    },
  }
  return deps
}
