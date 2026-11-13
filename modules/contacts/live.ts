import type { ContactsAudit, ContactsDeps } from './service'
import type { Directory } from './store'
import { dbContactsStore } from './db-store'
import { dayIn } from './types'

/**
 * Live wiring: the DB store over the app pool (company-level table, no RLS),
 * company roles and member names from the members tables, kernel events for
 * the audit trail.
 */

let depsPromise: Promise<ContactsDeps> | null = null

const directory: Directory = {
  async names() {
    const { dbMemberStore } = await import('$lib/server/members/db-store')
    return new Map((await dbMemberStore.listMembers()).map((m) => [m.id, m.name || m.email]))
  },
}

const kernelAudit: ContactsAudit = async ({ type, principalId, payload }) => {
  const { appKernel } = await import('$lib/server/boot')
  const { emitKernelEvent } = await import('$lib/kernel/events')
  const { moduleSource } = await import('$lib/kernel/cloudevents')
  const kernel = await appKernel()
  await emitKernelEvent(kernel.eventSink, { type, principalId, source: moduleSource('contacts'), payload })
}

export function contactsDeps(): Promise<ContactsDeps> {
  depsPromise ??= (async (): Promise<ContactsDeps> => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const { getUserRole } = await import('$lib/server/auth/user-role')
    return {
      store: dbContactsStore(createScopedDrizzle(appSql)),
      directory,
      roleOf: getUserRole,
      audit: kernelAudit,
    }
  })().catch((err) => {
    depsPromise = null
    throw err
  })
  return depsPromise
}

/** Where this person lives: their preferred timezone, as Memory's agenda uses it. */
export async function timeZoneFor(userId: string): Promise<string> {
  const { getUserPreferredTimezone } = await import('$lib/server/memory/user-timezone')
  return getUserPreferredTimezone(userId)
}

/** Today (`YYYY-MM-DD`) where this person lives. */
export async function todayFor(userId: string, at: Date = new Date()): Promise<string> {
  return dayIn(await timeZoneFor(userId), at)
}
