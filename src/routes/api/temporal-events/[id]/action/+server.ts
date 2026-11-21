import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import type { TemporalEventActionInput } from '$lib/server/memory/apply-temporal-event-action'
import { failed, refuse } from '$lib/server/memory/route-errors'
import {
  applyNlTemporalEventAction,
  applyQuickTemporalEventAction,
  applyStructuredRescheduleAction,
  applyStructuredSnoozeAction,
} from '$lib/server/memory/temporal-event-service'

export const POST: RequestHandler = async (event) => {
  const ctx = { attempted: 'Changing a timeline item (done, reopen, archive, reschedule, snooze)' }
  const user = event.locals.user
  if (!user) return refuse(401, 'Unauthorized', ctx)

  const eventId = event.params.id?.trim()
  if (!eventId) return refuse(400, 'Event id is required', ctx)

  let body: {
    action?: string
    instruction?: string
    startAt?: string
    endAt?: string | null
    snoozedUntil?: string
  }
  try {
    body = await event.request.json()
  } catch {
    return refuse(400, 'Invalid JSON body', ctx)
  }

  const action = typeof body.action === 'string' ? body.action.trim() : ''
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : ''

  if (action === 'reschedule') {
    const startAt = typeof body.startAt === 'string' ? body.startAt.trim() : ''
    if (!startAt) return refuse(400, 'startAt is required for reschedule', ctx)
    try {
      const result = await applyStructuredRescheduleAction(user.id, eventId, {
        startAt,
        endAt: typeof body.endAt === 'string' ? body.endAt : (body.endAt ?? null),
      })
      return json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('not found')) return failed(404, err, ctx)
      return failed(400, err, ctx)
    }
  }

  if (action === 'snooze') {
    const snoozedUntil = typeof body.snoozedUntil === 'string' ? body.snoozedUntil.trim() : ''
    if (!snoozedUntil) return refuse(400, 'snoozedUntil is required for snooze', ctx)
    try {
      const result = await applyStructuredSnoozeAction(user.id, eventId, snoozedUntil)
      return json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('not found')) return failed(404, err, ctx)
      return failed(400, err, ctx)
    }
  }

  const quickActions = new Set(['mark_done', 'reopen', 'archive', 'cancel', 'dismiss', 'delete'])
  if (action && quickActions.has(action)) {
    try {
      const result = await applyQuickTemporalEventAction(
        user.id,
        eventId,
        action as TemporalEventActionInput,
      )
      return json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('not found')) return failed(404, err, ctx)
      return failed(400, err, ctx)
    }
  }

  if (instruction) {
    try {
      const result = await applyNlTemporalEventAction(user.id, eventId, instruction)
      return json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('not found')) return failed(404, err, ctx)
      return failed(400, err, ctx)
    }
  }

  return refuse(400, 'Provide action (mark_done|reopen|archive) or instruction', ctx)
}
