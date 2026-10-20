import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { getDb } from '$lib/server/db'
import { kernelEvents } from '$lib/server/db/kernel.schema'
import { buildOverview } from '$lib/server/overview/overview'
import { humanContext, overviewResultSources } from '$lib/server/overview/sources'
import { bootstrapKernel } from '../../../../modules/index'

/** How many recent agent actions the overview shows; the chat holds the rest. */
const RECENT_ACTIONS = 10

/**
 * /overview: which module is active, and where the work can be seen.
 * Read-only: module results come from kernel read tools as the signed-in
 * owner; actions and approvals are store reads.
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const userId = event.locals.user.id
  const kernel = bootstrapKernel()
  const isAdmin = await isUserAdmin(userId)

  const overview = await buildOverview({
    manifests: kernel.modules.list(),
    activations: await kernel.activations.list(),
    registry: kernel.registry,
    ctx: humanContext(userId, isAdmin),
    canReadResults: isAdmin,
    resultSources: overviewResultSources(),
    // Agent actions = tool executions that changed something; reads (including
    // this page's own) are audited too but are not work to show.
    recentToolEvents: async () => {
      const rows = await getDb()
        .select({ ts: kernelEvents.ts, payload: kernelEvents.payload })
        .from(kernelEvents)
        .where(
          and(
            eq(kernelEvents.type, 'tool.executed'),
            ne(sql`${kernelEvents.payload}->>'auditClass'`, 'read'),
          ),
        )
        .orderBy(desc(kernelEvents.ts))
        .limit(RECENT_ACTIONS)
      return rows.map((row) => ({ ts: row.ts.toISOString(), payload: row.payload }))
    },
    pendingApprovals: () => kernel.approvals.listPending(),
  })

  return { overview }
}
