import { canUse, type MessagesDeps } from '../../../../modules/messages/service'
import type { CoworkerRunStore } from './run-store'
import type { CoworkerView } from './service'
import { randomUUID } from 'node:crypto'
import type { AgentRuntime } from '$lib/kernel/agent-runtime'
import { coworkerPrincipal } from '$lib/kernel/principals'
import type { KernelRegistry } from '$lib/kernel/registry'
import { coworkerAgentSource, CoworkerTriggerListener, type MessageFrames } from './agents'
import { ChannelMessageSource, CoworkerEventRouter, type CoworkerEventRouterDeps } from './events'
import { onCoworkersChanged } from './changes'
import { coworkerAgentId } from './service'
import { CoworkerTurns, STALE_AFTER_MS, TurnPrompts, type CompanyContext, type CoworkerDirectory, type CoworkerTurnsDeps } from './turns'

/**
 * Composition of the co-worker turns (plan/phase-ai-coworkers.md C3): the
 * runtime's co-worker agents (loaded from the database), the trigger listener
 * on the messages hub, the turn queue, and the reply posted through the kernel
 * as the co-worker (messages.post as its own principal: permission, audit and
 * push like any member's post). C7: the same frames feed the channel-message
 * event source (events.ts): the assistant routes each message once — one Jev
 * call, in shadow, asking for every co-worker it could be for whether it is
 * that co-worker's to act on. `startCoworkerTurns` is the production wiring
 * boot.ts starts; `composeCoworkerTurns` is the same with every port injected.
 */

export type CoworkerTurnsHandle = {
  turns: CoworkerTurns
  listener: CoworkerTriggerListener
  /** The channel-message event source (C7); absent when no events are wired. */
  events: ChannelMessageSource | null
  /** Reloads the agents into the runtime and follows the current co-workers. */
  reload(): Promise<void>
  /** Stops hearing messages and claiming turns (a running turn finishes). */
  stop(): void
}

export type ComposeCoworkerTurnsInput = {
  registry: Pick<KernelRegistry, 'execute'>
  runtime: Pick<AgentRuntime, 'loadAgents' | 'dispatchAsAgent'>
  messages: MessagesDeps
  hub: MessageFrames
  coworkers: CoworkerDirectory & { listEnabled(): Promise<CoworkerView[]> }
  runs: CoworkerRunStore
  company: (coworkerId: string) => Promise<CompanyContext>
  turnCost: CoworkerTurnsDeps['turnCost']
  inTrace: CoworkerTurnsDeps['inTrace']
  rhythms: CoworkerTurnsDeps['rhythms']
  /** Reads a task as the co-worker (null when it is gone or not its); its comment is posted through the kernel (tasks.comment). */
  readTask: CoworkerTurnsDeps['tasks']['get']
  /**
   * Event reactions (C7): the router's ports but the run queue, which is the turns' own
   * (an enforced "yes" queues an 'event' run on `runs` and starts it here).
   */
  events?: Omit<CoworkerEventRouterDeps, 'queueRun'>
} & Pick<CoworkerTurnsDeps, 'now' | 'threadTurnBudget' | 'heartbeatMs' | 'staleAfterMs'>

const asCoworker = (coworkerId: string) => ({ principal: coworkerPrincipal(coworkerId, coworkerAgentId(coworkerId)), requestId: randomUUID() })

export function composeCoworkerTurns(input: ComposeCoworkerTurnsInput): CoworkerTurnsHandle {
  const prompts = new TurnPrompts()
  const source = coworkerAgentSource({ listEnabled: () => input.coworkers.listEnabled(), prompts })
  const turns = new CoworkerTurns({
    runs: input.runs,
    messages: input.messages,
    coworkers: input.coworkers,
    company: input.company,
    prompts,
    agents: {
      reload: async () => {
        await input.runtime.loadAgents(source)
      },
      dispatch: (agentId, sessionId, text, options) => input.runtime.dispatchAsAgent(agentId, sessionId, text, undefined, options),
    },
    post: async (coworkerId, p) => {
      const out = (await input.registry.execute(
        'messages.post',
        { conversation_id: p.conversationId, body: p.body, ...(p.parentId ? { parent_id: p.parentId } : {}) },
        asCoworker(coworkerId),
      )) as { message?: { id?: unknown } }
      const id = out.message?.id
      if (typeof id !== 'string') throw new Error('messages.post answered without the posted message')
      return { id }
    },
    turnCost: input.turnCost,
    inTrace: input.inTrace,
    rhythms: input.rhythms,
    tasks: {
      get: input.readTask,
      // tasks.comment as the co-worker itself: permission, audit and the assigner's push like any assignee's comment.
      comment: async (coworkerId, taskId, body) => {
        await input.registry.execute('tasks.comment', { task_id: taskId, body }, asCoworker(coworkerId))
      },
    },
    ...(input.now ? { now: input.now } : {}),
    ...(input.threadTurnBudget === undefined ? {} : { threadTurnBudget: input.threadTurnBudget }),
    ...(input.heartbeatMs === undefined ? {} : { heartbeatMs: input.heartbeatMs }),
    ...(input.staleAfterMs === undefined ? {} : { staleAfterMs: input.staleAfterMs }),
  })
  const events = input.events
    ? new ChannelMessageSource(
        {
          getConversation: (id) => input.messages.store.getConversation(id),
          listPeople: () => input.messages.directory.listPeople(),
          access: async (userId, c) => ({ read: await canUse(input.messages, userId, c, 'view'), member: await canUse(input.messages, userId, c, 'edit') }),
        },
        new CoworkerEventRouter({
          ...input.events,
          queueRun: async (run) => {
            const row = await input.runs.enqueue(run)
            if (row) turns.work(row.id).catch((err: unknown) => console.error('[coworkers] an event run failed', { runId: row.id, err }))
            return row
          },
        }),
      )
    : null
  const listener = new CoworkerTriggerListener({ hub: input.hub, listEnabled: () => input.coworkers.listEnabled(), turns, ...(events ? { events } : {}) })
  return {
    turns,
    listener,
    events,
    reload: async () => {
      await input.runtime.loadAgents(source)
      await listener.refresh()
    },
    stop: () => {
      listener.stop()
      turns.stop()
    },
  }
}

/** What one turn cost: the cost log's rows of the run's trace for the co-worker, read in its own session. */
export async function liveTurnCost(coworkerId: string, runId: string): Promise<number> {
  const [{ withDbUser }, { aggregateActivityCostByGroupId }] = await Promise.all([
    import('$lib/server/db'),
    import('$lib/server/activity/trace-cost'),
  ])
  const aggregate = await withDbUser(coworkerId, (db) => aggregateActivityCostByGroupId(db, coworkerId, runId))
  const usd = Number(aggregate.totalUsd)
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`the cost log sum of co-worker run ${runId} is not a non-negative number: ${aggregate.totalUsd}`)
  return usd
}

/**
 * The live event-reaction ports (C7): the declared kind coworkers.event_mine, the 0176/0177
 * stores, the enabled co-workers, the cost ledger, the member daily cap of the message's author
 * (the routing call is billed to them), and decideMany() inside the author's own database
 * session (the call's cost row is RLS-scoped to them; there is no request outside a turn).
 */
export async function liveEventDeps(): Promise<Omit<CoworkerEventRouterDeps, 'queueRun'>> {
  const [{ coworkerEventMine }, { liveCoworkerEventStores }, coworkers, { ledgerSpentUsdToday }, { decideMany }, { withDbUser }, { assertGatewayCallWithinMemberDailyCap }, { LlmDailyCapError }] =
    await Promise.all([
      import('../../../../modules/coworkers/decision-kinds'),
      import('./db-event-store'),
      import('./index'),
      import('$lib/server/agent/ledger-spend'),
      import('$lib/server/decisions/decide'),
      import('$lib/server/db'),
      import('$lib/server/llm/member-daily-cap'),
      import('$lib/server/llm/errors'),
    ])
  return {
    kind: coworkerEventMine,
    subscriptions: liveCoworkerEventStores,
    observations: liveCoworkerEventStores,
    coworkers: { listEnabled: coworkers.listEnabledCoworkers },
    spentToday: ledgerSpentUsdToday,
    authorCapRefusal: async (userId) => {
      try {
        await withDbUser(userId, () => assertGatewayCallWithinMemberDailyCap(userId))
        return null
      } catch (err) {
        if (err instanceof LlmDailyCapError) return err.message
        throw err
      }
    },
    decideMany: (kind, items, opts) => withDbUser(opts.requestedBy, () => decideMany(kind, items, opts)),
  }
}

/**
 * Production: the database co-workers, the process's messages hub, the
 * coworker_run queue. Reloads after every co-worker change in this process,
 * resumes unfinished turns at start and sweeps for lost ones.
 */
export async function startCoworkerTurns(input: {
  registry: Pick<KernelRegistry, 'execute'>
  runtime: Pick<AgentRuntime, 'loadAgents' | 'dispatchAsAgent'>
}): Promise<CoworkerTurnsHandle> {
  const [{ messagesDeps, messagesHub }, coworkers, { liveCoworkerRunStore }, { liveCompanyContext }, { runWithTrace }, { liveRhythmStore }, { liveReadTask }, events] =
    await Promise.all([
      import('../../../../modules/messages/live'),
      import('./index'),
      import('./db-run-store'),
      import('./company-context'),
      import('$lib/server/activity/trace-context'),
      import('./db-rhythm-store'),
      import('./task-work'),
      liveEventDeps(),
    ])
  const handle = composeCoworkerTurns({
    registry: input.registry,
    runtime: input.runtime,
    messages: await messagesDeps(),
    hub: await messagesHub(),
    coworkers: { get: coworkers.getCoworker, orgChart: coworkers.orgChart, listEnabled: coworkers.listEnabledCoworkers },
    runs: liveCoworkerRunStore,
    company: liveCompanyContext,
    turnCost: liveTurnCost,
    inTrace: runWithTrace,
    rhythms: liveRhythmStore,
    readTask: liveReadTask,
    events,
  })
  await handle.reload()
  const unsubscribe = onCoworkersChanged(() => handle.reload())
  const resume = () =>
    handle.turns.resume().catch((err: unknown) => console.error('[coworkers] resuming unfinished co-worker turns failed', err))
  void resume()
  const sweep = setInterval(resume, STALE_AFTER_MS)
  ;(sweep as { unref?: () => void }).unref?.()
  return {
    ...handle,
    stop: () => {
      clearInterval(sweep)
      unsubscribe()
      handle.stop()
    },
  }
}
