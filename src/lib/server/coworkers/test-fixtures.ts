import type { CoworkerView, OrgChartEntry } from './service'
import type { AgentConfig, CoworkerSource } from '$lib/kernel/agent'
import type { AgentRuntime } from '$lib/kernel/agent-runtime'
import { KernelRegistry } from '$lib/kernel/registry'
import { memoryAssignedTaskStore } from '$lib/server/memory/assigned-tasks/memory-store'
import { AssignedTaskError, getTask, type AssignedTaskDeps, type TaskNotification } from '$lib/server/memory/assigned-tasks/service'
import { createTaskTools } from '../../../../modules/memory/task-tools'
import { MessagesHub } from '../../../../modules/messages/hub'
import { addCoworker, fixture } from '../../../../modules/messages/test-fixtures'
import { createMessagesTools } from '../../../../modules/messages/tools'
import { TypingBoard } from '../../../../modules/messages/typing'
import { composeCoworkerTurns, type ComposeCoworkerTurnsInput } from './live-turns'
import { MemoryRhythmStore } from './rhythms'
import { MemoryCoworkerRunStore } from './run-store'
import { coworkerAgentId, coworkerEmail } from './service'
import { checkCoworkerDelegation, queueTaskWork } from './task-work'

/**
 * The co-worker turns over in-memory Messages (owner Olga, members Bea and
 * Carl, co-workers Marketing @marketing and GTM @gtm), the real messages tools
 * on a kernel registry (the reply is posted as the co-worker), the real hub
 * (the memory store's onEvent stands in for pg_notify) and a scripted runtime
 * that runs each agent's own instructions and records what every turn carried.
 * C6: assigned tasks in memory with the real tasks.* tools (a co-worker comments
 * and completes as itself; assigning to one queues its turn) and the rhythms.
 */

export type DispatchCall = { agentId: string; sessionId: string; input: string; system: string; modelId: string | undefined; requestedBy?: string }

export type Script = (call: DispatchCall, n: number) => string | Promise<string>

const view = (id: string, slug: string, name: string, title: string, modelId: string): CoworkerView => ({
  id,
  name,
  email: coworkerEmail(slug, id),
  slug,
  image: null,
  title,
  accountabilities: [`${title} outcomes`],
  lens: `${title} lens`,
  modelId,
  enabled: true,
  dailyCapUsd: 5,
  templateId: null,
  reportsToUserId: null,
  reportsToUserIds: [],
  accountableHuman: { id: 'owner', name: 'Olga Owner', reason: 'owner' },
  accountableHumans: [{ id: 'owner', name: 'Olga Owner', reason: 'owner' }],
  agentId: coworkerAgentId(id),
  createdBy: 'owner',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  removedAt: null,
})

export function turnsFixture(opts: { script: Script; budget?: number; staleAfterMs?: number; extra?: Partial<ComposeCoworkerTurnsInput> }) {
  const f = fixture()
  addCoworker(f, { id: 'cw-mkt', slug: 'marketing', name: 'Marketing' })
  addCoworker(f, { id: 'cw-gtm', slug: 'gtm', name: 'GTM' })
  const coworkers = new Map<string, CoworkerView>([
    ['cw-mkt', view('cw-mkt', 'marketing', 'Marketing', 'Marketing Manager', 'google/gemini-3.8-flash')],
    ['cw-gtm', view('cw-gtm', 'gtm', 'GTM', 'Go-to-Market Manager', 'google/gemini-3.8-flash')],
  ])
  const chart = (): { people: OrgChartEntry[] } => ({
    people: [
      ...[
        ['owner', 'Olga Owner', 'owner'],
        ['bea', 'Bea Member', 'member'],
        ['carl', 'Carl Member', 'member'],
      ].map(([id, name, role]) => ({
        id: id!,
        name: name!,
        image: null,
        kind: 'human' as const,
        role: role as OrgChartEntry['role'],
        title: id === 'owner' ? 'CEO' : null,
        accountabilities: [],
        reportsToUserId: null,
        reportsToUserIds: [],
        accountableHuman: null,
        accountableHumans: [],
        enabled: null,
      })),
      ...[...coworkers.values()].map((c) => ({
        id: c.id,
        name: c.name,
        image: c.image,
        kind: 'coworker' as const,
        role: 'member' as const,
        title: c.title,
        accountabilities: c.accountabilities,
        reportsToUserId: c.reportsToUserId,
        reportsToUserIds: c.reportsToUserIds,
        accountableHuman: c.accountableHuman,
        accountableHumans: c.accountableHumans,
        enabled: c.enabled,
      })),
    ],
  })

  const registry = new KernelRegistry()
  for (const t of createMessagesTools({ deps: async () => f.deps, push: () => {} })) registry.register(t)

  const runs = new MemoryCoworkerRunStore()
  const rhythms = new MemoryRhythmStore(runs)
  const notified: Array<{ userId: string; n: TaskNotification }> = []
  // The turns' handle, once composed: a task event starts its run there.
  let startWork: (runId: string) => void = () => {
    throw new Error('the co-worker turns are not composed yet')
  }
  const taskDeps: AssignedTaskDeps = {
    store: memoryAssignedTaskStore(),
    directory: {
      get: async (id) => f.directory.people.find((p) => p.id === id) ?? null,
      list: async () => f.directory.people,
    },
    notify: async (userId, n) => {
      notified.push({ userId, n })
    },
    coworkerWork: async (e) => {
      await queueTaskWork({ runs, start: (id) => startWork(id) }, e)
    },
    coworkerDelegation: (assigner, assigneeId) => checkCoworkerDelegation(runs, assigner, assigneeId),
    now: f.deps.now,
  }
  const writerOf = async (ctx: { principal: { id: string; kind: string } }) => {
    if (ctx.principal.kind === 'coworker') {
      const c = coworkers.get(ctx.principal.id)
      if (!c) throw new Error(`no co-worker ${ctx.principal.id}`)
      return { kind: 'coworker' as const, userId: c.id, name: c.name }
    }
    return { kind: 'self' as const, userId: ctx.principal.id }
  }
  for (const t of createTaskTools({ deps: async () => taskDeps, writerOf })) registry.register(t)

  const calls: DispatchCall[] = []
  const costs = new Map<string, number>()
  let configs: AgentConfig[] = []
  let loads = 0
  const runtime: Pick<AgentRuntime, 'loadAgents' | 'dispatchAsAgent'> = {
    loadAgents: async (source: CoworkerSource) => {
      loads += 1
      configs = await source.listAgentConfigs()
      return { registered: configs.map((c) => c.id), replaced: [], unregistered: [] }
    },
    dispatchAsAgent: async (agentId, sessionId, input, _sinks, options) => {
      const config = configs.find((c) => c.id === agentId)
      if (!config || config.actsAs === 'person' || config.instructions === 'engine-default') throw new Error(`unknown co-worker agent ${agentId}`)
      const principal = await config.actsAs.principalFor({ agentId, sessionId })
      const system = await config.instructions({ agentId, sessionId, principal, input })
      const call: DispatchCall = { agentId, sessionId, input, system, modelId: config.modelId, ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}) }
      calls.push(call)
      return opts.script(call, calls.length)
    },
  }

  const hub = new MessagesHub(f.deps)
  const typing = new TypingBoard()
  const handle = composeCoworkerTurns({
    aiSource: async () => 'byok' as const,
    typing,
    registry,
    runtime,
    messages: f.deps,
    hub,
    coworkers: {
      get: async (id) => {
        const c = coworkers.get(id)
        if (!c) throw new Error(`no co-worker ${id}`)
        return c
      },
      orgChart: async () => chart(),
      listEnabled: async () => [...coworkers.values()].filter((c) => c.enabled && !c.removedAt),
    },
    runs,
    company: async () => ({ name: 'Kindred Labs', profile: 'We build calm software.', brandVoice: 'warm, plain, direct' }),
    turnCost: async (_cw, runId) => costs.get(runId) ?? 0,
    inTrace: (_runId, fn) => fn(),
    rhythms,
    readTask: async (cw, taskId) => {
      try {
        return await getTask(taskDeps, cw, taskId)
      } catch (err) {
        if (err instanceof AssignedTaskError && err.code === 'not_found') return null
        throw err
      }
    },
    now: f.deps.now,
    staleAfterMs: opts.staleAfterMs ?? 3_600_000,
    ...(opts.budget === undefined ? {} : { threadTurnBudget: opts.budget }),
    ...opts.extra,
  })
  startWork = (id) => {
    void handle.turns.work(id)
  }
  f.store.onEvent = (id) => {
    hub.dispatch(id).catch((err: unknown) => console.error('[spec] hub dispatch failed', err))
  }

  /** Settles every queued turn, including the ones their own replies triggered. */
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 0))
      await handle.turns.idle()
      await new Promise((r) => setTimeout(r, 0))
      if ((await runs.listUnfinished()).length === 0) {
        await handle.turns.idle()
        return
      }
    }
    throw new Error('the co-worker turns did not settle')
  }

  const thread = async (rootId: string) => {
    const root = await f.store.getMessage(rootId)
    return [root!, ...(await f.store.listReplies(rootId))].map((m) => ({ authorId: m.authorId, body: m.body }))
  }

  return { ...f, coworkers, registry, runtime, runs, rhythms, taskDeps, notified, hub, typing, handle, calls, costs, settle, thread, loads: () => loads }
}
