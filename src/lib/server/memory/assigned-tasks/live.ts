import type { AssignedTaskDeps, TaskNotification } from './service'
import { dbAssignedTaskStore } from './db-store'

/**
 * Live wiring: the Postgres store over the app pool (company-level tables, no
 * RLS — like messages and calls), the company's members as the directory (the
 * user table, production accounts only — never contacts), and the existing
 * notification channels: web push when the recipient turned it on (their
 * subscription, read in their own RLS scope), mirrored to their email through
 * company mail for the assignment and the completion (queueNotificationEmail:
 * a no-op until company mail is set up).
 */

async function liveNotify(userId: string, n: TaskNotification): Promise<void> {
  const payload = { title: n.title, body: n.body, url: n.url, tag: n.tag }
  const { withDbUser } = await import('$lib/server/db')
  const { listPushSubscriptionsForUser } = await import('$lib/server/push/subscription')
  const { sendPushToUser } = await import('$lib/server/push/send')
  await withDbUser(userId, async () => {
    if ((await listPushSubscriptionsForUser(userId)).length > 0) await sendPushToUser(userId, payload)
  })
  if (n.email) {
    const { queueNotificationEmail } = await import('$lib/server/notify/notification-email')
    await queueNotificationEmail(userId, payload)
  }
}

let deps: AssignedTaskDeps | null = null

export async function assignedTaskDeps(): Promise<AssignedTaskDeps> {
  if (deps) return deps
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  const { dbMemberStore } = await import('$lib/server/members/db-store')
  const db = createScopedDrizzle(appSql)
  deps = {
    store: dbAssignedTaskStore(() => db),
    directory: {
      async get(id) {
        const m = await dbMemberStore.getMember(id)
        return m ? { id: m.id, name: m.name, email: m.email } : null
      },
      async list() {
        return (await dbMemberStore.listMembers()).map((m) => ({ id: m.id, name: m.name, email: m.email }))
      },
    },
    notify: liveNotify,
  }
  return deps
}
