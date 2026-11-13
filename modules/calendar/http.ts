import type { Actor, CalendarDeps } from './service'
import { error, fail, redirect } from '@sveltejs/kit'
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

/** A form action: a CalendarError comes back as `{ action, error }` with its status. */
export async function calendarAction<T>(action: string, run: () => Promise<T>) {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CalendarError) return fail(ERROR_STATUS[err.code], { action, error: err.message })
    throw err
  }
}

/** A page load: a bad address is a 400, someone not in the company a 403. */
export async function calendarLoad<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof CalendarError) error(ERROR_STATUS[err.code], err.message)
    throw err
  }
}
