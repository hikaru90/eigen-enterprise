import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { getUserRole, isAdminRole } from '$lib/server/auth/user-role'
import { backupNotice, type BackupNotice } from '$lib/server/backups/health'
import type { DecisionQuestionView } from '$lib/kernel/decision-tools'
import { appKernel } from '$lib/server/boot'
import { needsYouNotices, type CoworkerNotice } from '$lib/server/coworkers/notices'
import { liveNoticeDeps } from '$lib/server/coworkers/rhythm-live'
import { getDb } from '$lib/server/db'
import { needsYouDecisionQuestions } from '$lib/server/decisions/live'
import { kernelEvents } from '$lib/server/db/kernel.schema'
import { EeClient, SubstrateUnavailableError } from '$lib/server/ee/client'
import { assignedTaskDeps } from '$lib/server/memory/assigned-tasks/live'
import { needsYouTasks, type NeedsYouTasks } from '$lib/server/memory/assigned-tasks/service'
import { reminderDeps } from '$lib/server/memory/reminders/live'
import { needsYouReminders, type ReminderView } from '$lib/server/memory/reminders/service'
import type { ModuleNotice } from '$lib/kernel/module-host/notices'
import { buildOverview, type Overview } from '$lib/server/overview/overview'
import type { PatternToolView } from '$lib/kernel/pattern-tools'
import { dashboardPatterns } from '$lib/server/patterns/dashboard-read'
import { updateNotice, type UpdateNotice } from '$lib/server/settings/update-notice'
import { liveModuleNotices } from '../../../../modules/company-modules/notices-live'
import { humanContext, overviewResultSources } from '$lib/server/overview/sources'

/** How many recent agent actions the dashboard shows; Assistant › Activity holds the rest. */
const RECENT_ACTIONS = 10

export type Dashboard = {
  overview: Overview
  /** The owner's nightly-backup problem, if any (plan/phase-backups.md). */
  backup: BackupNotice | null
  /** The owner's failed or rolled-back eigenEnterprise update, if any (plan/phase-upgrades.md §6.4 step 7). */
  update: UpdateNotice | null
  /** Tasks other members assigned to this person (open), and news on the ones they assigned (unseen). */
  tasks: NeedsYouTasks
  /** The person's own reminders with an open occurrence and no running snooze (one item per reminder). */
  reminders: ReminderView[]
  /** AI co-workers' finished or stopped rhythm and assignment runs this person answers for or asked for, until acknowledged (C6). */
  coworkerNotices: CoworkerNotice[]
  /** Decision questions asked of this person: Jev was unsure, the person answers from the closed set (CB2, decisions.questions). */
  decisionQuestions: DecisionQuestionView[]
  /** The company's own modules: a failed one (owner + admins), a deploy waiting for an admin's click, the owner's one-time sharing OK (U2). */
  moduleNotices: ModuleNotice[]
  /** What's happening (wish 75a4e570): the brain's latest activity digest, as this person may see it (dashboard.patterns). */
  patterns: PatternToolView
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

  return {
    overview,
    backup: role === 'owner' ? await ownerBackupNotice() : null,
    update: role === 'owner' ? await ownerUpdateNotice() : null,
    tasks: await needsYouTasks(await assignedTaskDeps(), userId),
    reminders: await needsYouReminders(await reminderDeps(), userId),
    coworkerNotices: await needsYouNotices(await liveNoticeDeps(), userId),
    decisionQuestions: await needsYouDecisionQuestions(userId),
    moduleNotices: await liveModuleNotices({ userId, isOwner: role === 'owner', isAdmin }),
    patterns: await dashboardPatterns(userId),
  }
}

/** A failed or rolled-back update is the owner's to look at (plan/phase-upgrades.md §6.4). */
async function ownerUpdateNotice(): Promise<UpdateNotice | null> {
  try {
    return updateNotice(await new EeClient().upgrade())
  } catch (err) {
    if (err instanceof SubstrateUnavailableError) return null // not on an ee box: no updates to watch
    throw err
  }
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
