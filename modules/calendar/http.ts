import type { Actor, CalendarDeps } from './service'
import { error, fail, redirect } from '@sveltejs/kit'
import { errorReport } from '$lib/server/errors/report'
import { CalendarError, ERROR_STATUS } from './errors'

/**
 * The /m/calendar page's seam onto the service: signed-in people only,
 * CalendarError → the page's error or a form failure the dialog shows.
 * Anything else is a real failure and is rethrown.
 */

export async function liveCalendarDeps(): Promise<CalendarDeps> {
  const { calendarDeps } = await import('./live')
  return calendarDeps()
}

/** The signed-in person as a Calendar actor (else to /login). */
export function personActor(user: { id: string } | null | undefined): Actor & { kind: 'user' } {
  if (!user) throw redirect(302, '/login')
  return { kind: 'user', userId: user.id }
}

/** The one error shape for a CalendarError: its sentence for the person, the agent half with its code. */
export function calendarErrorReport(err: CalendarError, attempted: string) {
  return errorReport(err, {
    attempted,
    plain: () => err.message,
    nextSteps: [
      `The calendar service (modules/calendar/service.ts) refused with CalendarError code "${err.code}" (HTTP ${ERROR_STATUS[err.code]}).`,
    ],
  })
}

/**
 * A form action: a CalendarError comes back as `{ action, error, agent }`
 * with its status (`attempted` says what the person was doing, for the agent).
 */
export async function calendarAction<T>(action: string, attempted: string, run: () => Promise<T>) {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CalendarError)
      return fail(ERROR_STATUS[err.code], { action, ...calendarErrorReport(err, attempted) })
    throw err
  }
}

/** A page load: a bad address is a 400, someone not in the company a 403. */
export async function calendarLoad<T>(attempted: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CalendarError)
      error(ERROR_STATUS[err.code], {
        message: err.message,
        agent: calendarErrorReport(err, attempted).agent,
      })
    throw err
  }
}
