import type { CalendarAudit, CalendarDeps } from './service'
import { dbCalendarStore } from './db-store'

/**
 * Live wiring: the DB store over the app pool (company-level tables, no RLS),
 * company roles and member names from the members tables, kernel events for
 * the audit trail, Calls for a call on an event (wired outside modules/).
 */

let depsPromise: Promise<CalendarDeps> | null = null

const kernelAudit: CalendarAudit = async ({ type, principalId, payload }) => {
  const { appKernel } = await import('$lib/server/boot')
  const { emitKernelEvent } = await import('$lib/kernel/events')
  const { moduleSource } = await import('$lib/kernel/cloudevents')
  const kernel = await appKernel()
  await emitKernelEvent(kernel.eventSink, { type, principalId, source: moduleSource('calendar'), payload })
}

export function calendarDeps(): Promise<CalendarDeps> {
  depsPromise ??= (async (): Promise<CalendarDeps> => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const { getUserRole } = await import('$lib/server/auth/user-role')
    const { dbMemberStore } = await import('$lib/server/members/db-store')
    const { liveCalendarCalls } = await import('$lib/server/calendar/calls-port')
    return {
      store: dbCalendarStore(createScopedDrizzle(appSql)),
      members: async () => (await dbMemberStore.listMembers()).map((m) => ({ id: m.id, name: m.name, email: m.email })),
      roleOf: getUserRole,
      audit: kernelAudit,
      calls: liveCalendarCalls(),
    }
  })().catch((err) => {
    depsPromise = null
    throw err
  })
  return depsPromise
}

/** The person's own time zone (their preferred one, as Memory's agenda uses it). */
export async function timeZoneFor(userId: string): Promise<string> {
  const { getUserPreferredTimezone } = await import('$lib/server/memory/user-timezone')
  return getUserPreferredTimezone(userId)
}
