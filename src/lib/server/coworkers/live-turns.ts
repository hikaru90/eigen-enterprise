import type { MessagesDeps } from '../../../../modules/messages/service'
import type { CoworkerRunStore } from './run-store'
import type { CoworkerView } from './service'
import type { AgentRuntime } from '$lib/kernel/agent-runtime'
import type { KernelRegistry } from '$lib/kernel/registry'
import { randomUUID } from 'node:crypto'
import { coworkerPrincipal } from '$lib/kernel/principals'
import { coworkerAgentSource, CoworkerTriggerListener, type MessageFrames } from './agents'
import { onCoworkersChanged } from './changes'
import { coworkerAgentId } from './service'
import { CoworkerTurns, STALE_AFTER_MS, TurnPrompts, type CompanyContext, type CoworkerDirectory, type CoworkerTurnsDeps } from './turns'

/**
 * Composition of the co-worker turns (plan/phase-ai-coworkers.md C3): the
 * runtime's co-worker agents (loaded from the database), the trigger listener
 * on the messages hub, the turn queue, and the reply posted through the kernel
 * as the co-worker (messages.post as its own principal: permission, audit and
 * push like any member's post). `startCoworkerTurns` is the production wiring
 * boot.ts starts; `composeCoworkerTurns` is the same with every port injected.
 */

export type CoworkerTurnsHandle = {
  turns: CoworkerTurns
  listener: CoworkerTriggerListener
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
} & Pick<CoworkerTurnsDeps, 'now' | 'threadTurnBudget' | 'heartbeatMs' | 'staleAfterMs'>

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
        { principal: coworkerPrincipal(coworkerId, coworkerAgentId(coworkerId)), requestId: randomUUID() },
      )) as { message?: { id?: unknown } }
      const id = out.message?.id
      if (typeof id !== 'string') throw new Error('messages.post answered without the posted message')
      return { id }
    },
    turnCost: input.turnCost,
    inTrace: input.inTrace,
    ...(input.now ? { now: input.now } : {}),
    ...(input.threadTurnBudget === undefined ? {} : { threadTurnBudget: input.threadTurnBudget }),
    ...(input.heartbeatMs === undefined ? {} : { heartbeatMs: input.heartbeatMs }),
    ...(input.staleAfterMs === undefined ? {} : { staleAfterMs: input.staleAfterMs }),
  })
  const listener = new CoworkerTriggerListener({ hub: input.hub, listEnabled: () => input.coworkers.listEnabled(), turns })
  return {
    turns,
    listener,
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
 * Production: the database co-workers, the process's messages hub, the
 * coworker_run queue. Reloads after every co-worker change in this process,
 * resumes unfinished turns at start and sweeps for lost ones.
 */
export async function startCoworkerTurns(input: {
  registry: Pick<KernelRegistry, 'execute'>
  runtime: Pick<AgentRuntime, 'loadAgents' | 'dispatchAsAgent'>
}): Promise<CoworkerTurnsHandle> {
  const [{ messagesDeps, messagesHub }, coworkers, { liveCoworkerRunStore }, { liveCompanyContext }, { runWithTrace }] = await Promise.all([
    import('../../../../modules/messages/live'),
    import('./index'),
    import('./db-run-store'),
    import('./company-context'),
    import('$lib/server/activity/trace-context'),
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
