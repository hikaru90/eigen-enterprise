import type { CoworkerView, OrgChartEntry } from './service'
import type { AgentConfig, CoworkerSource } from '$lib/kernel/agent'
import type { AgentRuntime } from '$lib/kernel/agent-runtime'
import { KernelRegistry } from '$lib/kernel/registry'
import { MessagesHub } from '../../../../modules/messages/hub'
import { addCoworker, fixture } from '../../../../modules/messages/test-fixtures'
import { createMessagesTools } from '../../../../modules/messages/tools'
import { composeCoworkerTurns, type ComposeCoworkerTurnsInput } from './live-turns'
import { MemoryCoworkerRunStore } from './run-store'
import { coworkerAgentId, coworkerEmail } from './service'

/**
 * The co-worker turns over in-memory Messages (owner Olga, members Bea and
 * Carl, co-workers Marketing @marketing and GTM @gtm), the real messages tools
 * on a kernel registry (the reply is posted as the co-worker), the real hub
 * (the memory store's onEvent stands in for pg_notify) and a scripted runtime
 * that runs each agent's own instructions and records what every turn carried.
 */

export type DispatchCall = { agentId: string; sessionId: string; input: string; system: string; modelId: string | undefined; requestedBy?: string }

export type Script = (call: DispatchCall, n: number) => string | Promise<string>

const view = (id: string, slug: string, name: string, title: string, modelId: string): CoworkerView => ({
  id,
  name,
  email: coworkerEmail(slug, id),
  slug,
  title,
  accountabilities: [`${title} outcomes`],
  lens: `${title} lens`,
  modelId,
  enabled: true,
  dailyCapUsd: 5,
  templateId: null,
  reportsToUserId: null,
  accountableHuman: { id: 'owner', name: 'Olga Owner', reason: 'owner' },
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
    ['cw-mkt', view('cw-mkt', 'marketing', 'Marketing', 'Marketing Manager', 'anthropic/claude-sonnet-5.5')],
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
        kind: 'human' as const,
        role: role as OrgChartEntry['role'],
        title: id === 'owner' ? 'CEO' : null,
        accountabilities: [],
        reportsToUserId: null,
        accountableHuman: null,
        enabled: null,
      })),
      ...[...coworkers.values()].map((c) => ({
        id: c.id,
        name: c.name,
        kind: 'coworker' as const,
        role: 'member' as const,
        title: c.title,
        accountabilities: c.accountabilities,
        reportsToUserId: c.reportsToUserId,
        accountableHuman: c.accountableHuman,
        enabled: c.enabled,
      })),
    ],
  })

  const registry = new KernelRegistry()
  for (const t of createMessagesTools({ deps: async () => f.deps, push: () => {} })) registry.register(t)

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

  const runs = new MemoryCoworkerRunStore()
  const hub = new MessagesHub(f.deps)
  const handle = composeCoworkerTurns({
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
    now: f.deps.now,
    staleAfterMs: opts.staleAfterMs ?? 3_600_000,
    ...(opts.budget === undefined ? {} : { threadTurnBudget: opts.budget }),
    ...opts.extra,
  })
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

  return { ...f, coworkers, registry, runtime, runs, hub, handle, calls, costs, settle, thread, loads: () => loads }
}
