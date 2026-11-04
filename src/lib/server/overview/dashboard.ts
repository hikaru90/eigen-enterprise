import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { getUserRole, isAdminRole } from '$lib/server/auth/user-role'
import { backupNotice, type BackupNotice } from '$lib/server/backups/health'
import { appKernel } from '$lib/server/boot'
import { getDb } from '$lib/server/db'
import { kernelEvents } from '$lib/server/db/kernel.schema'
import { EeClient, SubstrateUnavailableError } from '$lib/server/ee/client'
import { buildOverview, type Overview } from '$lib/server/overview/overview'
import { humanContext, overviewResultSources } from '$lib/server/overview/sources'

/** How many recent agent actions the dashboard shows; Assistant › Activity holds the rest. */
const RECENT_ACTIONS = 10

export type Dashboard = {
  overview: Overview
  /** The owner's nightly-backup problem, if any (plan/phase-backups.md). */
  backup: BackupNotice | null
}

/**
 * The dashboard at `/` (polish P-2, formerly /overview): which modules are
 * active, what needs the member, and the work the agent did. Read-only:
 * module results come from kernel read tools as the signed-in member;
 * actions and approvals are store reads.
 */
export async function loadDashboard(userId: string): Promise<Dashboard> {
  const kernel = await appKernel()
  const role = await getUserRole(userId)
  const isAdmin = isAdminRole(role)

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

  return { overview, backup: role === 'owner' ? await ownerBackupNotice() : null }
}

/** A failed or missing nightly backup is the owner's to fix (plan/phase-backups.md). */
async function ownerBackupNotice(): Promise<BackupNotice | null> {
  try {
    return backupNotice(await new EeClient().backups())
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) return null // not on an ee box: no backups to watch
    throw err
  }
}
