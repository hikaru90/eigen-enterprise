import type { CalendarError } from '../../../../modules/calendar/errors'
import type { CalendarCallsPort } from '../../../../modules/calendar/event-calls'

/**
 * Calendar ↔ Calls (plan/calendar.md K3): a call on an event is booked
 * through Calls' own schedule (the same service call as calls.schedule and
 * the New call dialog, as the same person), and a linked call must be one the
 * person is in. Outside modules/, since modules never import each other.
 * A Calls refusal comes back as a CalendarError carrying Calls' reason, so the
 * dialog and the tools show it.
 */

const CODE: Record<string, CalendarError['code']> = {
  not_found: 'not_found',
  forbidden: 'forbidden',
  invalid: 'invalid',
  conflict: 'invalid',
  not_configured: 'upstream',
  unavailable: 'upstream',
}

async function asCalendarError<T>(run: () => Promise<T>): Promise<T> {
  const { CallsError } = await import('../../../../modules/calls/errors')
  const { CalendarError } = await import('../../../../modules/calendar/errors')
  try {
    return await run()
  } catch (err) {
    if (err instanceof CallsError) {
      const code = CODE[err.code]
      if (!code) throw new Error(`calendar: unmapped Calls error code "${err.code}"`, { cause: err })
      throw new CalendarError(code, `Calls: ${err.message}`, { cause: err })
    }
    throw err
  }
}

export function liveCalendarCalls(): CalendarCallsPort {
  const service = async () => (await import('../../../../modules/index')).liveCallsService()
  return {
    async book(userId, input) {
      const calls = await service()
      const out = await asCalendarError(() =>
        calls.schedule(
          { kind: 'user', userId },
          {
            userIds: input.memberIds,
            guests: input.guests.length > 0 ? input.guests : undefined,
            title: input.title,
            startsAt: input.startsAt,
            durationMinutes: input.durationMinutes,
            externalUrl: input.externalUrl,
            timeZone: input.timeZone,
          },
        ),
      )
      return { callId: out.call.id, invited: out.invitations.length }
    },
    async canJoin(userId, callId) {
      const calls = await service()
      const { CallsError } = await import('../../../../modules/calls/errors')
      try {
        await calls.get(userId, callId)
        return true
      } catch (err) {
        if (err instanceof CallsError && (err.code === 'not_found' || err.code === 'forbidden')) return false
        throw err
      }
    },
  }
}
