import { DbModuleStore, DbSharingStore } from '$lib/kernel/module-host/db-stores'
import { moduleNotices, type ModuleNotice, type NoticeViewer } from '$lib/kernel/module-host/notices'

/**
 * The Needs you source of the company's own modules (plan/phase-upgrades-u2.md
 * §4.6, §6.6, D13) for the dashboard: read straight from the kernel tables.
 */
export async function liveModuleNotices(viewer: NoticeViewer): Promise<ModuleNotice[]> {
  const db = async () => (await import('$lib/server/db')).companyDb()
  const [records, sharing] = await Promise.all([new DbModuleStore(db).list(), new DbSharingStore(db).get()])
  return moduleNotices(records, sharing, viewer)
}
