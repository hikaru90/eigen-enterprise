import type { EventObservationStore, EventSubscriptionStore } from './events'
import type { CoworkerActor, CoworkerView } from './service'
import { isAdminRole } from '$lib/server/auth/roles'
import { COWORKER_EVENT_KINDS, type CoworkerEventKind, type CoworkerEventOutcome } from './events'
import { CoworkerError } from './service'

/**
 * Which company events an AI co-worker notices (C7): coworkers.event_subscriptions_get (every
 * member reads them, with the counted outcomes of what it heard — skipped events included)
 * and coworkers.event_subscriptions_set (owner and admins).
 */

export type EventSubscriptionDeps = {
  subscriptions: EventSubscriptionStore
  observations: Pick<EventObservationStore, 'counts'>
  coworkers: { get(userId: string): Promise<CoworkerView> }
  now?: () => Date
}

export type EventSubscriptionsView = {
  userId: string
  /** Every kind of the closed set, on or off. */
  kinds: { kind: CoworkerEventKind; on: boolean }[]
  /** What became of the events it heard, by outcome: in the last hour and the last 24 hours. */
  lastHour: Record<CoworkerEventOutcome, number>
  lastDay: Record<CoworkerEventOutcome, number>
}

export async function getEventSubscriptions(d: EventSubscriptionDeps, userId: string): Promise<EventSubscriptionsView> {
  await d.coworkers.get(userId)
  const now = (d.now ?? (() => new Date()))()
  const [on, lastHour, lastDay] = await Promise.all([
    d.subscriptions.list(userId),
    d.observations.counts(userId, new Date(now.getTime() - 3_600_000)),
    d.observations.counts(userId, new Date(now.getTime() - 86_400_000)),
  ])
  return { userId, kinds: COWORKER_EVENT_KINDS.map((kind) => ({ kind, on: on.includes(kind) })), lastHour, lastDay }
}

export async function setEventSubscriptions(
  d: EventSubscriptionDeps,
  actor: CoworkerActor,
  input: { userId: string; kinds: readonly CoworkerEventKind[] },
): Promise<EventSubscriptionsView> {
  if (actor.kind === 'coworker' || !isAdminRole(actor.role)) {
    throw new CoworkerError('forbidden', 'Only the owner or an admin chooses which events an AI co-worker notices.')
  }
  const view = await d.coworkers.get(input.userId)
  if (view.removedAt) throw new CoworkerError('removed', `${view.name} was removed; it notices nothing.`)
  for (const k of input.kinds) {
    if (!(COWORKER_EVENT_KINDS as readonly string[]).includes(k)) throw new CoworkerError('invalid_input', `“${k}” is not an event kind (${COWORKER_EVENT_KINDS.join(', ')}).`)
  }
  await d.subscriptions.set(input.userId, input.kinds, actor.id, (d.now ?? (() => new Date()))())
  return getEventSubscriptions(d, input.userId)
}
