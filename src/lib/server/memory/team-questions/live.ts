import type { TeamQuestionDeps } from './service'
import { dbTeamQuestionStore } from './db-store'

/**
 * Live wiring: the Postgres store over the app pool (company-level tables, no
 * RLS — like assigned tasks), the company's members as the directory (the user
 * table, production accounts only — never contacts) and the member groups.
 */

let deps: TeamQuestionDeps | null = null

export async function teamQuestionDeps(): Promise<TeamQuestionDeps> {
  if (deps) return deps
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  const { dbMemberStore } = await import('$lib/server/members/db-store')
  const { dbGroupStore } = await import('$lib/server/members/groups-db-store')
  const db = createScopedDrizzle(appSql)
  deps = {
    store: dbTeamQuestionStore(() => db),
    directory: {
      async get(id) {
        const m = await dbMemberStore.getMember(id)
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
