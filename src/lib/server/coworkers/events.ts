import type { Conversation, Person } from '../../../../modules/messages/store'
import type { CoworkerRunRow, NewCoworkerRun } from './run-store'
import type { CoworkerView } from './service'
import type { HeardMessage } from './turns'
import { randomUUID } from 'node:crypto'
import {
  COWORKER_EVENT_KINDS,
  COWORKER_EVENT_OUTCOMES,
  COWORKER_EVENT_ROUTE_OUTCOMES,
  type CoworkerEventKind,
  type CoworkerEventOutcome,
  type CoworkerEventRouteOutcome,
} from '$lib/server/db/coworker-events.schema'
import type { DecideManyItem, DecideManyOptions, DecisionResult } from '$lib/server/decisions/decide'
import type { DecisionKind } from '$lib/server/decisions/kind'
import { mentionedIds } from '../../../../modules/messages/notify'
import { threadRootOf } from './triggers'

/**
 * AI co-workers notice company events without being @mentioned (plan/phase-ai-coworkers.md
 * §2 "proactive too", §8 C7). The company's assistant (the brain) reads each event ONCE and
 * routes it to the co-workers it belongs to (owner decision 2026-11-24).
 *
 * 1. **Sources** (structure, a closed set — COWORKER_EVENT_KINDS): `channel_message`, a person's
 *    new message in a channel (ChannelMessageSource).
 * 2. **Candidates** (structure, no meaning): the enabled co-workers an admin switched on for
 *    the kind (coworker_event_subscription; coworkers.event_subscriptions_get/set) for whom the
 *    message is an event — a member of the channel who may read it, not @mentioned (a mention
 *    is already a C3 turn), the author a person (`channelMessageEvent`). None → no call.
 * 3. **Routing, once:** the event is claimed once across every app process and redelivery
 *    (coworker_event_route's unique index), with one coworker_event_observation row per
 *    candidate. Then ONE Jev call (decideMany, kind `coworkers.event_mine` — "is this co-worker's
 *    to act on?", a yes/no question, so Jev, never a chat model or keywords): the event is the
 *    state, one question per candidate with its role card as context. Each candidate gets its
 *    own decision row (subject = the co-worker), so "Would pick up", labels and agreement are
 *    per co-worker as before.
 * 4. **Cost and caps:** the routing call is the assistant's work on the author's message, so it
 *    is billed to the author (requestedBy); their member daily AI cap spent → nothing is asked,
 *    every candidate counted `skipped_author_cap`, logged loud. A candidate whose own daily cap
 *    is spent is left out of the question set and counted `skipped_daily_cap`. Nothing is
 *    dropped silently: every candidate has its row and outcome; the route has its own.
 *    (The per-co-worker hourly decision limit is gone with routing; `skipped_rate_limit` is only
 *    in rows from before 0177.)
 * 5. **Acting is behind the kind's status.** In `shadow` (today, with no current judge)
 *    decideMany() returns `observed` with `act: false` per co-worker: logged, nothing happens.
 *    PROMOTION: after reviewing agreement (decisions.kinds, the profile's "Would pick up"),
 *    a commit changes `status: 'shadow'` to `status: 'enforced'` in
 *    modules/coworkers/decision-kinds.ts. From then on each co-worker Jev says "yes" for gets one
 *    'event' run (coworker_run, trigger key event:<kind>:<event id>) that answers in the event's
 *    thread as the co-worker (turns.ts prepareEvent). No other change.
 */

export {
  COWORKER_EVENT_KINDS,
  COWORKER_EVENT_OUTCOMES,
  COWORKER_EVENT_ROUTE_OUTCOMES,
  type CoworkerEventKind,
  type CoworkerEventOutcome,
  type CoworkerEventRouteOutcome,
}

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

export type EventRouteRow = {
  id: string
  eventKind: CoworkerEventKind
  eventId: string
  conversationId: string | null
  authorUserId: string
  outcome: CoworkerEventRouteOutcome
  candidates: number
  questions: number
  error: string | null
  createdAt: Date
  updatedAt: Date
}

export type EventObservationRow = {
  id: string
  coworkerUserId: string
  eventKind: CoworkerEventKind
  eventId: string
  conversationId: string | null
  outcome: CoworkerEventOutcome
  decisionId: string | null
  runId: string | null
  routeId: string | null
  error: string | null
  createdAt: Date
  updatedAt: Date
}

type ObservationPatch = { outcome: CoworkerEventOutcome; decisionId?: string | null; runId?: string | null; error?: string | null }

export type EventObservationStore = {
  /**
   * Claims one event for routing, in one step across processes: null when it was claimed
   * already (another process or a redelivery won); else the new `claimed` route and one
   * `claimed` observation per candidate co-worker, in the order given.
   */
  claimRoute(input: {
    eventKind: CoworkerEventKind
    eventId: string
    conversationId: string | null
    authorUserId: string
    coworkerUserIds: readonly string[]
    now: Date
  }): Promise<{ route: EventRouteRow; observations: EventObservationRow[] } | null>
  finishRoute(id: string, patch: { outcome: CoworkerEventRouteOutcome; questions?: number; error?: string | null }, at: Date): Promise<void>
  finish(id: string, patch: ObservationPatch, at: Date): Promise<void>
  /** Counts per outcome of a co-worker's rows made at or after `since`. */
  counts(coworkerUserId: string, since: Date): Promise<Record<CoworkerEventOutcome, number>>
}

export type EventSubscriptionStore = {
  list(coworkerUserId: string): Promise<CoworkerEventKind[]>
  /** Who is switched on for this kind (one read per event, not one per co-worker). */
  subscribers(kind: CoworkerEventKind): Promise<string[]>
  /** Replaces the co-worker's switched-on kinds. */
  set(coworkerUserId: string, kinds: readonly CoworkerEventKind[], by: string, at: Date): Promise<void>
}

export const zeroCounts = (): Record<CoworkerEventOutcome, number> =>
  Object.fromEntries(COWORKER_EVENT_OUTCOMES.map((o) => [o, 0])) as Record<CoworkerEventOutcome, number>

/** In memory, for specs: the same contract, one process. */
export class MemoryEventStores implements EventObservationStore, EventSubscriptionStore {
  readonly routes: EventRouteRow[] = []
  readonly observations: EventObservationRow[] = []
  readonly subscriptions: { coworkerUserId: string; eventKind: CoworkerEventKind; createdBy: string; createdAt: Date }[] = []

  async claimRoute(input: Parameters<EventObservationStore['claimRoute']>[0]): Promise<{ route: EventRouteRow; observations: EventObservationRow[] } | null> {
    if (input.coworkerUserIds.length === 0) throw new Error('an event is routed only when some co-worker could be its')
    if (this.routes.some((r) => r.eventKind === input.eventKind && r.eventId === input.eventId)) return null
    const route: EventRouteRow = {
      id: randomUUID(),
      eventKind: input.eventKind,
      eventId: input.eventId,
      conversationId: input.conversationId,
      authorUserId: input.authorUserId,
      outcome: 'claimed',
      candidates: input.coworkerUserIds.length,
      questions: 0,
      error: null,
      createdAt: input.now,
      updatedAt: input.now,
    }
    this.routes.push(route)
    const made: EventObservationRow[] = []
    for (const coworkerUserId of input.coworkerUserIds) {
      // A row from before routing (the same co-worker and event) stays as it was.
      if (this.observations.some((r) => r.coworkerUserId === coworkerUserId && r.eventKind === input.eventKind && r.eventId === input.eventId)) continue
      const row: EventObservationRow = {
        id: randomUUID(),
        coworkerUserId,
        eventKind: input.eventKind,
        eventId: input.eventId,
        conversationId: input.conversationId,
        outcome: 'claimed',
        decisionId: null,
        runId: null,
        routeId: route.id,
        error: null,
        createdAt: input.now,
        updatedAt: input.now,
      }
      this.observations.push(row)
      made.push({ ...row })
    }
    return { route: { ...route }, observations: made }
  }

  async finishRoute(id: string, patch: Parameters<EventObservationStore['finishRoute']>[1], at: Date): Promise<void> {
    const row = this.routes.find((r) => r.id === id)
    if (!row) throw new Error(`no coworker event route ${id}`)
    Object.assign(row, patch, { updatedAt: at })
  }

  async finish(id: string, patch: ObservationPatch, at: Date): Promise<void> {
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

  async subscribers(kind: CoworkerEventKind): Promise<string[]> {
    return this.subscriptions.filter((s) => s.eventKind === kind).map((s) => s.coworkerUserId)
  }

  async set(coworkerUserId: string, kinds: readonly CoworkerEventKind[], by: string, at: Date): Promise<void> {
    const keep = this.subscriptions.filter((s) => s.coworkerUserId !== coworkerUserId)
    this.subscriptions.length = 0
    this.subscriptions.push(...keep, ...[...new Set(kinds)].map((eventKind) => ({ coworkerUserId, eventKind, createdBy: by, createdAt: at })))
  }
}

// --- the router -----------------------------------------------------------------

export type CoworkerRouteResult = { outcome: CoworkerEventOutcome; observationId: string; decisionId: string | null; runId: string | null }

export type RouteResult =
  /** Another process or a redelivery routed this event already. */
  | { outcome: 'duplicate' }
  | { outcome: CoworkerEventRouteOutcome; routeId: string; coworkers: Record<string, CoworkerRouteResult> }

export type EventDecideMany = (
  kind: DecisionKind<CoworkerEventMineInput, EventMineChoice>,
  items: readonly DecideManyItem<CoworkerEventMineInput>[],
  opts: DecideManyOptions<CoworkerEventMineInput, EventMineChoice>,
) => Promise<DecisionResult<EventMineChoice>[]>

export type CoworkerEventRouterDeps = {
  /** The kind decided (modules/coworkers/decision-kinds.ts coworkerEventMine; specs pass an enforced copy). */
  kind: DecisionKind<CoworkerEventMineInput, EventMineChoice>
  subscriptions: Pick<EventSubscriptionStore, 'subscribers'>
  observations: EventObservationStore
  /** The enabled co-workers (the candidates are among them). */
  coworkers: { listEnabled(): Promise<CoworkerView[]> }
  /** What a co-worker's model calls cost today (UTC), from the cost ledger. */
  spentToday(userId: string): Promise<number>
  /**
   * Why the author's member daily AI cap refuses a call now, or null when it allows one
   * (live: the gateway's own cap check, $lib/server/llm/member-daily-cap).
   */
  authorCapRefusal(userId: string): Promise<string | null>
  /** decideMany() for the author (live: in the author's database session; the call is theirs). */
  decideMany: EventDecideMany
  /** Queues an 'event' run and starts it (enforced "yes" only); null when it was queued already. */
  queueRun(run: NewCoworkerRun): Promise<CoworkerRunRow | null>
  now?: () => Date
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

const mineInput = (view: CoworkerView, event: CoworkerEvent): CoworkerEventMineInput => ({
  coworker: {
    id: view.id,
    name: view.name,
    title: view.title,
    accountabilities: [...view.accountabilities],
    lens: view.lens,
    accountableHumanId: view.accountableHuman?.id ?? null,
  },
  event,
})

/**
 * The company's assistant routing an event: once per event, one Jev call for every co-worker it
 * could be for, one counted outcome per co-worker.
 */
export class CoworkerEventRouter {
  private readonly now: () => Date

  constructor(private readonly deps: CoworkerEventRouterDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** The enabled co-workers switched on for this kind (a source builds the candidates from them). */
  async listening(kind: CoworkerEventKind): Promise<CoworkerView[]> {
    const on = new Set(await this.deps.subscriptions.subscribers(kind))
    if (on.size === 0) return []
    return (await this.deps.coworkers.listEnabled()).filter((c) => on.has(c.id) && c.enabled && !c.removedAt)
  }

  /** One event and the co-workers it could be for (at least one): claimed once, at most one Jev call. */
  async route(event: CoworkerEvent, candidates: readonly CoworkerView[]): Promise<RouteResult> {
    if (candidates.length === 0) throw new Error(`route(${event.kind} ${event.id}) needs at least one candidate co-worker`)
    const claimed = await this.deps.observations.claimRoute({
      eventKind: event.kind,
      eventId: event.id,
      conversationId: event.conversationId,
      authorUserId: event.authorId,
      coworkerUserIds: candidates.map((c) => c.id),
      now: this.now(),
    })
    if (!claimed) return { outcome: 'duplicate' }
    const { route } = claimed
    const rowOf = new Map(claimed.observations.map((o) => [o.coworkerUserId, o]))
    const views = candidates.filter((c) => rowOf.has(c.id))
    const coworkers: Record<string, CoworkerRouteResult> = {}
    const finish = async (coworkerId: string, outcome: CoworkerEventOutcome, extra: { decisionId?: string | null; runId?: string | null; error?: string | null } = {}) => {
      const row = rowOf.get(coworkerId)!
      await this.deps.observations.finish(row.id, { outcome, ...extra }, this.now())
      coworkers[coworkerId] = { outcome, observationId: row.id, decisionId: extra.decisionId ?? null, runId: extra.runId ?? null }
    }
    const done = async (outcome: CoworkerEventRouteOutcome, extra: { questions?: number; error?: string | null } = {}): Promise<RouteResult> => {
      await this.deps.observations.finishRoute(route.id, { outcome, ...extra }, this.now())
      return { outcome, routeId: route.id, coworkers }
    }

    try {
      // A co-worker whose own daily cap is spent is left out of the question set.
      const asked: CoworkerView[] = []
      for (const view of views) {
        const spent = await this.deps.spentToday(view.id)
        if (spent < view.dailyCapUsd) {
          asked.push(view)
          continue
        }
        console.error('[coworkers] event not routed to a co-worker: it reached its daily cap', { coworkerId: view.id, event: event.id, spent, cap: view.dailyCapUsd })
        await finish(view.id, 'skipped_daily_cap', { error: `the daily AI budget is spent (${spent} >= ${view.dailyCapUsd} USD today, UTC)` })
      }
      if (asked.length === 0) return await done('skipped_daily_cap')

      // The routing call is the assistant's work on the author's message: it is billed to them.
      const refusal = await this.deps.authorCapRefusal(event.authorId)
      if (refusal !== null) {
        console.error('[coworkers] event not routed: the author reached their daily AI cap', { author: event.authorId, event: event.id, coworkers: asked.length, refusal })
        const error = `the author’s daily AI budget is spent: ${refusal}`
        for (const view of asked) await finish(view.id, 'skipped_author_cap', { error })
        return await done('skipped_author_cap', { error })
      }

      const results = await this.deps.decideMany(
        this.deps.kind,
        asked.map((view) => ({ input: mineInput(view, event), subjectUserId: view.id })),
        { requestedBy: event.authorId, judge: { none: true } },
      )
      for (const [n, view] of asked.entries()) {
        const r = results[n]!
        if (r.outcome === 'observed') {
          if (r.jev === null) await finish(view.id, 'failed', { decisionId: r.decisionId, error: 'Jev gave no answer (see the decision log)' })
          else await finish(view.id, 'observed', { decisionId: r.decisionId })
          continue
        }
        if (r.outcome === 'pending' || r.choice !== 'yes') {
          await finish(view.id, 'observed', { decisionId: r.decisionId })
          continue
        }
        // Enforced and Jev says it is the co-worker's: one 'event' run answers in the event's thread.
        try {
          const run = await this.deps.queueRun(eventRun(view.id, event, this.now()))
          await finish(view.id, 'queued', { decisionId: r.decisionId, runId: run?.id ?? null, ...(run ? {} : { error: 'the event run was queued already' }) })
        } catch (err) {
          console.error('[coworkers] queueing an event run failed', { coworkerId: view.id, event: event.id, err })
          await finish(view.id, 'failed', { decisionId: r.decisionId, error: errorText(err) })
        }
      }
      return await done('decided', { questions: asked.length })
    } catch (err) {
      console.error('[coworkers] routing an event failed', { event: event.id, err })
      const error = errorText(err)
      for (const view of views) if (!coworkers[view.id]) await finish(view.id, 'failed', { error })
      return done('failed', { error })
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

/** How many recently heard message ids a process remembers, so co-workers' frames of one message route it once. */
export const HEARD_MESSAGES_REMEMBERED = 512

/**
 * The `channel_message` source: every created message the co-workers hear on the messages hub
 * (CoworkerTriggerListener, one frame per co-worker that may see it) comes here; the first frame
 * of a message routes it, the others join that (one process), and the route's claim makes it
 * once across processes. The candidates are the enabled co-workers switched on for channel
 * messages for whom the message is an event (channelMessageEvent); none → no call.
 */
export class ChannelMessageSource {
  private readonly heard = new Map<string, Promise<RouteResult | null>>()
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(
    private readonly deps: ChannelMessageSourceDeps,
    private readonly router: Pick<CoworkerEventRouter, 'listening' | 'route'>,
  ) {}

  onMessage(message: HeardMessage): Promise<RouteResult | null> {
    const known = this.heard.get(message.id)
    if (known) return known
    const p = this.handle(message)
    this.heard.set(message.id, p)
    while (this.heard.size > HEARD_MESSAGES_REMEMBERED) this.heard.delete(this.heard.keys().next().value!)
    this.inFlight.add(p)
    void p.finally(() => this.inFlight.delete(p)).catch(() => {})
    return p
  }

  /** Resolves once nothing is being routed in this process (specs). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
  }

  private async handle(message: HeardMessage): Promise<RouteResult | null> {
    const listening = await this.router.listening('channel_message')
    if (listening.length === 0) return null
    const c = await this.deps.getConversation(message.conversationId)
    if (!c) return null
    const people = await this.deps.listPeople()
    const candidates: CoworkerView[] = []
    let event: ChannelMessageEvent | null = null
    for (const view of listening) {
      const access = await this.deps.access(view.id, c)
      const mine = channelMessageEvent({ coworkerId: view.id, message, conversation: c, people, isMember: access.member, canRead: access.read })
      if (!mine) continue
      event ??= mine
      candidates.push(view)
    }
    if (!event) return null
    return this.router.route(event, candidates)
  }
}
