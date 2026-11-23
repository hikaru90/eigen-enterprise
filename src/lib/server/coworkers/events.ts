import type { Conversation, Person } from '../../../../modules/messages/store'
import type { CoworkerRunRow, NewCoworkerRun } from './run-store'
import type { CoworkerView } from './service'
import type { HeardMessage } from './turns'
import { randomUUID } from 'node:crypto'
import {
  COWORKER_EVENT_KINDS,
  COWORKER_EVENT_OUTCOMES,
  type CoworkerEventKind,
  type CoworkerEventOutcome,
} from '$lib/server/db/coworker-events.schema'
import type { DecideOptions, DecisionResult } from '$lib/server/decisions/decide'
import type { DecisionKind } from '$lib/server/decisions/kind'
import { mentionedIds } from '../../../../modules/messages/notify'
import { threadRootOf } from './triggers'

/**
 * AI co-workers notice company events without being @mentioned (plan/phase-ai-coworkers.md
 * §2 "proactive too", §8 C7).
 *
 * 1. **Sources** (structure, a closed set — COWORKER_EVENT_KINDS): `channel_message`, a new
 *    message in a channel the co-worker is a member of and may read, that does not @mention it
 *    (a mention is already a C3 turn) and is not by an AI co-worker (`channelMessageEvent`).
 * 2. **Subscription:** a co-worker hears only the kinds an admin switched on for it
 *    (coworker_event_subscription; coworkers.event_subscriptions_get/set).
 * 3. **Observation:** each such event is one Jev decision of kind `coworkers.event_mine`
 *    ("is this mine to act on?" — a yes/no question, so Jev, never a chat model or keywords),
 *    claimed once per co-worker and event across every app process
 *    (coworker_event_observation's unique index). The cost is on the co-worker; a spent daily
 *    cap means no decision (counted `skipped_daily_cap`, logged loud, never retried); past
 *    EVENT_DECISIONS_PER_HOUR in the last hour it is counted `skipped_rate_limit`. Nothing is
 *    dropped silently: every event the co-worker heard has its row and outcome.
 * 4. **Acting is behind the kind's status.** In `shadow` (today, with no current judge)
 *    decide() returns `observed` with `act: false`: the decision is logged and nothing happens.
 *    PROMOTION: after reviewing agreement (decisions.kinds, the profile's "Would pick up"),
 *    a commit changes `status: 'shadow'` to `status: 'enforced'` in
 *    modules/coworkers/decision-kinds.ts. From then on decide() returns Jev's choice and a
 *    "yes" queues one 'event' run (coworker_run, trigger key event:<kind>:<event id>) that
 *    answers in the event's thread as the co-worker (turns.ts prepareEvent). No other change.
 */

export { COWORKER_EVENT_KINDS, COWORKER_EVENT_OUTCOMES, type CoworkerEventKind, type CoworkerEventOutcome }

/** At most this many event decisions per co-worker in any hour; the rest are counted skipped_rate_limit. */
export const EVENT_DECISIONS_PER_HOUR = 20
/** What Jev reads of the event's text. */
export const EVENT_STATE_BODY_CHARS = 4_000
/** What the decision log keeps of the text (public channels only). */
export const EVENT_LOG_EXCERPT_CHARS = 200

/** A new channel message as the co-worker heard it (structure, no meaning). */
export type ChannelMessageEvent = {
  kind: 'channel_message'
  /** The message id. */
  id: string
  conversationId: string
  channelName: string
  /** A private channel's text never leaves Jev's state (the log keeps no excerpt). */
  privateChannel: boolean
  /** The thread it is in (a top-level message opens its own). */
  threadRootId: string
  isReply: boolean
  authorId: string
  authorName: string
  body: string
  at: string
}

export type CoworkerEvent = ChannelMessageEvent

/** The input of a coworkers.event_mine decision: the co-worker's role card and the event. */
export type CoworkerEventMineInput = {
  coworker: {
    id: string
    name: string
    title: string | null
    accountabilities: string[]
    lens: string
    accountableHumanId: string | null
  }
  event: CoworkerEvent
}

export type EventMineChoice = 'yes' | 'no'

/**
 * The event a new message is for this co-worker, or null (pure): a live, non-call message in a
 * channel it is a member of and may read, by a person, that does not @mention it.
 */
export function channelMessageEvent(input: {
  coworkerId: string
  message: HeardMessage
  conversation: Pick<Conversation, 'id' | 'kind' | 'name' | 'private' | 'archived'>
  people: readonly Person[]
  /** The co-worker is a member of the channel: it may post there (Messages' canUse 'edit' — a public channel's every member, a private one's invited). */
  isMember: boolean
  /** The co-worker may read the conversation (Messages' canUse 'view'). */
  canRead: boolean
}): ChannelMessageEvent | null {
  const { coworkerId, message: m, conversation: c } = input
  if (c.kind !== 'channel' || c.archived || !input.isMember || !input.canRead) return null
  if (m.deleted || m.call !== null || m.authorId === coworkerId) return null
  const author = input.people.find((p) => p.id === m.authorId)
  // A former member's message (no longer in the directory) is nobody's event.
  if (!author) return null
  if (author.kind === undefined) throw new Error(`the people directory gives no kind (human | coworker) for ${author.id}`)
  if (author.kind !== 'human') return null
  if (mentionedIds(m.body, input.people).includes(coworkerId)) return null
  return {
    kind: 'channel_message',
    id: m.id,
    conversationId: c.id,
    channelName: c.name ?? '',
    privateChannel: c.private,
    threadRootId: threadRootOf(m, 'channel')!,
    isReply: m.parentId !== null,
    authorId: author.id,
    authorName: author.name.trim() || author.email,
    body: m.body,
    at: m.createdAt,
  }
}

/** The 'event' run an enforced "yes" queues (pure). */
export function eventRun(coworkerUserId: string, event: CoworkerEvent, at: Date): NewCoworkerRun {
  return {
    coworkerUserId,
    triggerKind: 'event',
    conversationId: event.conversationId,
    threadRootId: event.threadRootId,
    triggerMessageId: event.id,
    requestedByUserId: event.authorId,
    triggeredAt: at,
    rhythmId: null,
    taskId: null,
    triggerKey: eventRunKey(event),
    delegationChain: [],
  }
}

export const eventRunKey = (e: Pick<CoworkerEvent, 'kind' | 'id'>) => `event:${e.kind}:${e.id}`

// --- stores -----------------------------------------------------------------

export type EventObservationRow = {
  id: string
  coworkerUserId: string
  eventKind: CoworkerEventKind
  eventId: string
  conversationId: string | null
  outcome: CoworkerEventOutcome
  decisionId: string | null
  runId: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
}

/** Outcomes that count against the hourly limit: a decision was (being) asked. */
export const COUNTED_OUTCOMES: readonly CoworkerEventOutcome[] = ['claimed', 'observed', 'queued', 'failed']

export type EventObservationStore = {
  /**
   * Claims one event for one co-worker, in one step across processes: null when it already has
   * a row for that event (another process or a redelivery won); else the new row — `claimed`,
   * or `skipped_rate_limit` when `hourlyLimit` counted rows were made in the hour before `now`.
   */
  claim(input: {
    coworkerUserId: string
    eventKind: CoworkerEventKind
    eventId: string
    conversationId: string | null
    now: Date
    hourlyLimit: number
  }): Promise<EventObservationRow | null>
  finish(id: string, patch: { outcome: CoworkerEventOutcome; decisionId?: string | null; runId?: string | null; error?: string | null }, at: Date): Promise<void>
  /** Counts per outcome of a co-worker's rows made at or after `since`. */
  counts(coworkerUserId: string, since: Date): Promise<Record<CoworkerEventOutcome, number>>
}

export type EventSubscriptionStore = {
  list(coworkerUserId: string): Promise<CoworkerEventKind[]>
  /** Replaces the co-worker's switched-on kinds. */
  set(coworkerUserId: string, kinds: readonly CoworkerEventKind[], by: string, at: Date): Promise<void>
}

export const zeroCounts = (): Record<CoworkerEventOutcome, number> =>
  Object.fromEntries(COWORKER_EVENT_OUTCOMES.map((o) => [o, 0])) as Record<CoworkerEventOutcome, number>

const HOUR_MS = 3_600_000

/** In memory, for specs: the same contract, one process. */
export class MemoryEventStores implements EventObservationStore, EventSubscriptionStore {
  readonly observations: EventObservationRow[] = []
  readonly subscriptions: { coworkerUserId: string; eventKind: CoworkerEventKind; createdBy: string; createdAt: Date }[] = []

  async claim(input: Parameters<EventObservationStore['claim']>[0]): Promise<EventObservationRow | null> {
    const mine = this.observations.filter((r) => r.coworkerUserId === input.coworkerUserId)
    if (mine.some((r) => r.eventKind === input.eventKind && r.eventId === input.eventId)) return null
    const since = input.now.getTime() - HOUR_MS
    const used = mine.filter((r) => COUNTED_OUTCOMES.includes(r.outcome) && r.createdAt.getTime() > since).length
    const row: EventObservationRow = {
      id: randomUUID(),
      coworkerUserId: input.coworkerUserId,
      eventKind: input.eventKind,
      eventId: input.eventId,
      conversationId: input.conversationId,
      outcome: used >= input.hourlyLimit ? 'skipped_rate_limit' : 'claimed',
      decisionId: null,
      runId: null,
      error: used >= input.hourlyLimit ? `over ${input.hourlyLimit} event decisions in the last hour` : null,
      createdAt: input.now,
      updatedAt: input.now,
    }
    this.observations.push(row)
    return { ...row }
  }

  async finish(id: string, patch: Parameters<EventObservationStore['finish']>[1], at: Date): Promise<void> {
    const row = this.observations.find((r) => r.id === id)
    if (!row) throw new Error(`no coworker event observation ${id}`)
    Object.assign(row, patch, { updatedAt: at })
  }

  async counts(coworkerUserId: string, since: Date): Promise<Record<CoworkerEventOutcome, number>> {
    const out = zeroCounts()
    for (const r of this.observations) if (r.coworkerUserId === coworkerUserId && r.createdAt >= since) out[r.outcome]++
    return out
  }

  async list(coworkerUserId: string): Promise<CoworkerEventKind[]> {
    return this.subscriptions.filter((s) => s.coworkerUserId === coworkerUserId).map((s) => s.eventKind)
  }

  async set(coworkerUserId: string, kinds: readonly CoworkerEventKind[], by: string, at: Date): Promise<void> {
    const keep = this.subscriptions.filter((s) => s.coworkerUserId !== coworkerUserId)
    this.subscriptions.length = 0
    this.subscriptions.push(...keep, ...[...new Set(kinds)].map((eventKind) => ({ coworkerUserId, eventKind, createdBy: by, createdAt: at })))
  }
}

// --- the observer -------------------------------------------------------------

export type ObserveResult =
  | { outcome: 'not_subscribed' | 'unavailable' | 'duplicate' }
  | { outcome: CoworkerEventOutcome; observationId: string; decisionId: string | null; runId: string | null }

export type EventDecide = (
  kind: DecisionKind<CoworkerEventMineInput, EventMineChoice>,
  input: CoworkerEventMineInput,
  opts: DecideOptions<EventMineChoice>,
) => Promise<DecisionResult<EventMineChoice>>

export type CoworkerEventObserverDeps = {
  /** The kind decided (modules/coworkers/decision-kinds.ts coworkerEventMine; specs pass an enforced copy). */
  kind: DecisionKind<CoworkerEventMineInput, EventMineChoice>
  subscriptions: Pick<EventSubscriptionStore, 'list'>
  observations: EventObservationStore
  coworkers: { get(userId: string): Promise<CoworkerView> }
  /** What the co-worker's model calls cost today (UTC), from the cost ledger. */
  spentToday(userId: string): Promise<number>
  /** decide() with the co-worker's database session (live: withDbUser). */
  decide: EventDecide
  /** Queues an 'event' run and starts it (enforced "yes" only); null when it was queued already. */
  queueRun(run: NewCoworkerRun): Promise<CoworkerRunRow | null>
  now?: () => Date
  hourlyLimit?: number
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class CoworkerEventObserver {
  private readonly now: () => Date
  private readonly hourlyLimit: number

  constructor(private readonly deps: CoworkerEventObserverDeps) {
    this.now = deps.now ?? (() => new Date())
    this.hourlyLimit = deps.hourlyLimit ?? EVENT_DECISIONS_PER_HOUR
    if (!Number.isInteger(this.hourlyLimit) || this.hourlyLimit < 1) throw new Error(`the hourly event decision limit must be a positive integer (got ${this.hourlyLimit})`)
  }

  /** Whether an admin switched this kind on for the co-worker (a source checks this before it builds the event). */
  async wants(coworkerId: string, kind: CoworkerEventKind): Promise<boolean> {
    return (await this.deps.subscriptions.list(coworkerId)).includes(kind)
  }

  /** One event the co-worker heard: at most one decision, its outcome counted. */
  async observe(coworkerId: string, event: CoworkerEvent): Promise<ObserveResult> {
    if (!(await this.wants(coworkerId, event.kind))) return { outcome: 'not_subscribed' }
    const view = await this.deps.coworkers.get(coworkerId)
    if (!view.enabled || view.removedAt) return { outcome: 'unavailable' }
    const now = this.now()
    const claimed = await this.deps.observations.claim({
      coworkerUserId: coworkerId,
      eventKind: event.kind,
      eventId: event.id,
      conversationId: event.conversationId,
      now,
      hourlyLimit: this.hourlyLimit,
    })
    if (!claimed) return { outcome: 'duplicate' }
    const done = (outcome: CoworkerEventOutcome, extra: { decisionId?: string | null; runId?: string | null; error?: string | null } = {}) => ({
      outcome,
      observationId: claimed.id,
      decisionId: extra.decisionId ?? null,
      runId: extra.runId ?? null,
    })
    if (claimed.outcome === 'skipped_rate_limit') {
      console.warn('[coworkers] event skipped: hourly decision limit reached', { coworkerId, event: event.id, limit: this.hourlyLimit })
      return done('skipped_rate_limit')
    }
    const finish = async (outcome: CoworkerEventOutcome, extra: { decisionId?: string | null; runId?: string | null; error?: string | null } = {}) => {
      await this.deps.observations.finish(claimed.id, { outcome, ...extra }, this.now())
      return done(outcome, extra)
    }
    try {
      const spent = await this.deps.spentToday(coworkerId)
      if (spent >= view.dailyCapUsd) {
        const error = `the daily AI budget is spent (${spent} >= ${view.dailyCapUsd} USD today, UTC)`
        console.error('[coworkers] event not decided: the co-worker reached its daily cap', { coworkerId, event: event.id, spent, cap: view.dailyCapUsd })
        return await finish('skipped_daily_cap', { error })
      }
      const input: CoworkerEventMineInput = {
        coworker: {
          id: view.id,
          name: view.name,
          title: view.title,
          accountabilities: [...view.accountabilities],
          lens: view.lens,
          accountableHumanId: view.accountableHuman?.id ?? null,
        },
        event,
      }
      const r = await this.deps.decide(this.deps.kind, input, { requestedBy: coworkerId, subjectUserId: coworkerId, judge: { none: true } })
      if (r.outcome === 'observed') {
        if (r.jev === null) return await finish('failed', { decisionId: r.decisionId, error: 'Jev gave no answer (see the decision log)' })
        return await finish('observed', { decisionId: r.decisionId })
      }
      if (r.outcome === 'pending') return await finish('observed', { decisionId: r.decisionId })
      if (r.choice !== 'yes') return await finish('observed', { decisionId: r.decisionId })
      // Enforced and Jev says it is the co-worker's: one 'event' run answers in the event's thread.
      const run = await this.deps.queueRun(eventRun(coworkerId, event, this.now()))
      return await finish('queued', { decisionId: r.decisionId, runId: run?.id ?? null, ...(run ? {} : { error: 'the event run was queued already' }) })
    } catch (err) {
      console.error('[coworkers] observing an event failed', { coworkerId, event: event.id, err })
      return finish('failed', { error: errorText(err) })
    }
  }
}

/** What a channel-message source needs of Messages. */
export type ChannelMessageSourceDeps = {
  getConversation(id: string): Promise<Conversation | null>
  listPeople(): Promise<Person[]>
  /** Messages' canUse: `read` = 'view', `member` = 'edit' (it may post there, as C3 and the rhythms define a member). */
  access(userId: string, c: Conversation): Promise<{ read: boolean; member: boolean }>
}

/**
 * The `channel_message` source: every created message a co-worker hears on the messages hub
 * (CoworkerTriggerListener) goes here too; when the co-worker is switched on for channel
 * messages and the message is its event (channelMessageEvent), the observer decides.
 */
export class ChannelMessageSource {
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(
    private readonly deps: ChannelMessageSourceDeps,
    private readonly observer: Pick<CoworkerEventObserver, 'wants' | 'observe'>,
  ) {}

  onMessage(coworkerId: string, message: HeardMessage): Promise<ObserveResult | null> {
    const p = this.handle(coworkerId, message)
    this.inFlight.add(p)
    void p.finally(() => this.inFlight.delete(p)).catch(() => {})
    return p
  }

  /** Resolves once nothing is being observed in this process (specs). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
  }

  private async handle(coworkerId: string, message: HeardMessage): Promise<ObserveResult | null> {
    if (!(await this.observer.wants(coworkerId, 'channel_message'))) return null
    const c = await this.deps.getConversation(message.conversationId)
    if (!c) return null
    const [people, access] = await Promise.all([this.deps.listPeople(), this.deps.access(coworkerId, c)])
    const event = channelMessageEvent({ coworkerId, message, conversation: c, people, isMember: access.member, canRead: access.read })
    if (!event) return null
    return this.observer.observe(coworkerId, event)
  }
}
