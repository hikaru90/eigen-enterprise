import type { QuestionNotification, TeamQuestionDeps } from './service'
import { dbTeamQuestionStore } from './db-store'

/** Web push to a person asked a question, when they turned notifications on (as assigned tasks do). */
async function liveNotify(userId: string, n: QuestionNotification): Promise<void> {
  const { withDbUser } = await import('$lib/server/db')
  const { listPushSubscriptionsForUser } = await import('$lib/server/push/subscription')
  const { sendPushToUser } = await import('$lib/server/push/send')
  await withDbUser(userId, async () => {
    if ((await listPushSubscriptionsForUser(userId)).length > 0) await sendPushToUser(userId, n)
  })
}

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
 */

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
    directory: {
      async get(id) {
        const m = (await dbMemberStore.getMember(id)) ?? (await accountOf(id))
        return m ? { id: m.id, name: m.name } : null
      },
      async list() {
        return (await dbMemberStore.listMembers()).map((m) => ({ id: m.id, name: m.name }))
      },
    },
    notify: liveNotify,
    groups: {
      list: async () => (await dbGroupStore.listGroups()).map((g) => ({ id: g.id, name: g.name, memberIds: g.memberIds })),
    },
  }
  return deps
}
