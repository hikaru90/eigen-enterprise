import type { GatewayCompleteFn } from '$lib/server/agent/gateway-model'
import type { CoworkerTurnsHandle } from './live-turns'
import type { CoworkerView } from './service'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import { DurableLoopEngine } from '$lib/kernel/engines/durable'
import { InMemoryEventSink } from '$lib/kernel/events'
import { KernelRegistry } from '$lib/kernel/registry'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'

/**
 * AI Co-workers C3 on the test database (plan/phase-ai-coworkers.md §8): a person
 * @mentions Marketing in #launch, Marketing pulls in GTM, GTM answers, Marketing
 * answers the person — every piece real except the model: Postgres Messages
 * (the live deps, the live LISTEN hub, the access contract), the coworker_run
 * queue, the kernel registry posting as each co-worker, the durable engine on a
 * temp SQLite file, the cost ledger. The model is the mock gateway's chat
 * response shape (scripts/mock-gateway-chat.mjs), scripted per co-worker; each
 * call writes its cost-log row the way the gateway does (the trace's group id,
 * billed to the caller). Two listeners stand in for two app processes.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

vi.mock('$lib/server/capture/capture-enrich-worker', () => ({ scheduleCaptureEnrichWorker: () => {} }))

type Seen = { userId: string; model: string | undefined; system: string; traceId: string | undefined }

describe.skipIf(!DATABASE_URL)('co-worker turns on Postgres with the mock gateway', () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
  const ann = `c3_ann_${tag}`
  const boss = `c3_admin_${tag}`
  let operator: postgres.Sql
  let marketing: CoworkerView
  let gtm: CoworkerView
  /** The person both answer to: Ann, up the reports-to chain (GTM → Marketing → Ann). */
  let humanHandle: string
  let stateDir: string
  const conversations: string[] = []
  const handles: CoworkerTurnsHandle[] = []
  const seen: Seen[] = []
  let script: (s: Seen, nthForUser: number) => string = () => 'unset'
  let deps: Awaited<ReturnType<typeof import('../../../../modules/messages/live')['messagesDeps']>>

  const reply = (content: string) => ({
    id: 'mock-completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })

  beforeAll(async () => {
    // The live Messages deps open the Drive (attachments); the spec never attaches a file.
    stateDir = mkdtempSync(join(tmpdir(), 'ee-c3-'))
    process.env.DRIVE_STORAGE_DIR ??= join(stateDir, 'drive')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} })
    for (const [id, role] of [
      [ann, 'member'],
      [boss, 'admin'],
    ] as const) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, ${`${role} ${tag}`}, ${`${id}@test.local`}, true, true, ${role})`
    }
    const svc = await import('./index')
    const admin = { id: boss, role: 'admin' as const, kind: 'person' as const }
    marketing = await svc.createCoworker(admin, { templateId: 'marketing-manager', name: `Marketing ${tag}`, modelId: 'anthropic/claude-sonnet-5.5', reportsToUserId: ann }, svc.coworkerDeps())
    gtm = await svc.createCoworker(admin, { templateId: 'go-to-market-manager', name: `GTM ${tag}`, modelId: 'google/gemini-3.8-flash', reportsToUserId: marketing.id }, svc.coworkerDeps())

    const { messagesDeps, messagesHub } = await import('../../../../modules/messages/live')
    const { createMessagesTools } = await import('../../../../modules/messages/tools')
    const { primaryHandle } = await import('../../../../modules/messages/notify')
    deps = await messagesDeps()
    expect(gtm.accountableHuman).toMatchObject({ id: ann, reason: 'chain' })
    humanHandle = primaryHandle((await deps.directory.listPeople()).find((p) => p.id === ann)!)

    const registry = new KernelRegistry({ principalScope: livePrincipalScope })
    for (const t of createMessagesTools({ deps: async () => deps, push: () => {} })) registry.register(t)

    // The model: the mock gateway's response shape, scripted per co-worker; the gateway's cost-log row per call.
    const { withDbUser } = await import('$lib/server/db')
    const { logActivityCall } = await import('$lib/server/activity/log-call')
    const { getCurrentTraceGroupId, runWithTrace } = await import('$lib/server/activity/trace-context')
    const complete: GatewayCompleteFn = async (input) => {
      const s: Seen = {
        userId: input.userId,
        model: input.modelOverride,
        system: input.messages.find((m) => m.role === 'system')?.content ?? '',
        traceId: getCurrentTraceGroupId(),
      }
      seen.push(s)
      await withDbUser(input.userId, (db) =>
        logActivityCall(db, input.userId, { provider: 'mock-gateway', operation: 'chat', baseCostUsd: input.userId === marketing.id ? 0.002 : 0.001 }),
      )
      return reply(script(s, seen.filter((x) => x.userId === input.userId).length))
    }

    const { getDurableHarness, resetDurableHarnessSingletonForTests } = await import('$lib/server/agent/durable-harness')
    const { InMemoryDurableConversationIndex } = await import('$lib/server/agent/conversation-index')
    resetDurableHarnessSingletonForTests()
    const harnessDeps = {
      env: { EE_AGENT_STATE_DIR: join(stateDir, 'agent') },
      index: new InMemoryDurableConversationIndex(),
      complete,
      onReport: () => {},
      runAsPrincipal: async () => {
        throw new Error('no background runs here')
      },
      mirrorResumedChatTurn: async () => {
        throw new Error('no chat mirror here')
      },
    }
    const engine = new DurableLoopEngine({
      harness: {
        conversation: async (i) => (await getDurableHarness(harnessDeps)).engineHarness.conversation(i),
        startBackgroundRun: async (i) => (await getDurableHarness(harnessDeps)).engineHarness.startBackgroundRun(i),
      },
      instructions: 'You are the company brain.',
    })
    const { ledgerSpentUsdToday } = await import('$lib/server/agent/ledger-spend')

    const { composeCoworkerTurns, liveTurnCost } = await import('./live-turns')
    const { liveCoworkerRunStore } = await import('./db-run-store')
    const { liveCompanyContext } = await import('./company-context')
    const hub = await messagesHub()
    const mine = new Set([marketing.id, gtm.id])
    // Two app processes: each its own runtime, turns and listener; one database queue.
    for (let i = 0; i < 2; i++) {
      const runtime = new AgentRuntime({
        registry,
        isToolActive: async () => true,
        eventSink: new InMemoryEventSink(),
        engines: new Map([['durable', engine]]),
        spentUsdToday: ledgerSpentUsdToday,
      })
      const handle = composeCoworkerTurns({
        registry,
        runtime,
        messages: deps,
        hub,
        coworkers: {
          get: svc.getCoworker,
          orgChart: svc.orgChart,
          listEnabled: async () => (await svc.listEnabledCoworkers()).filter((c) => mine.has(c.id)),
        },
        runs: liveCoworkerRunStore,
        company: liveCompanyContext,
        turnCost: liveTurnCost,
        inTrace: runWithTrace,
      })
      await handle.reload()
      handles.push(handle)
    }
  }, 60_000)

  afterAll(async () => {
    for (const h of handles) h.stop()
    await Promise.all(handles.map((h) => h.turns.idle()))
    if (conversations.length > 0) await operator`delete from message_conversations where id in ${operator(conversations)}`
    const ids = [ann, boss, marketing?.id, gtm?.id].filter((x): x is string => typeof x === 'string')
    await operator`delete from org_position where user_id in ${operator([marketing?.id, gtm?.id].filter((x): x is string => typeof x === 'string'))}`
    await operator`delete from coworker_profile where user_id in ${operator(ids)}`
    await operator`delete from org_position where user_id in ${operator(ids)}`
    await operator`delete from "user" where id in ${operator(ids)}`
    await operator.end()
    if (stateDir) rmSync(stateDir, { recursive: true, force: true })
    const { resetDurableHarnessSingletonForTests } = await import('$lib/server/agent/durable-harness')
    resetDurableHarnessSingletonForTests()
  })

  async function runsOf() {
    return operator`
      select id, coworker_user_id, status, stop_reason, cost_usd, thread_root_id, trigger_message_id, error
      from coworker_run where coworker_user_id in ${operator([marketing.id, gtm.id])} order by triggered_at, id`
  }

  /** Until every turn is finished and both processes are idle (LISTEN delivers asynchronously). */
  async function settle(expectedRuns: number) {
    const deadline = Date.now() + 45_000
    for (;;) {
      await Promise.all(handles.map((h) => h.turns.idle()))
      const rows = await runsOf()
      if (rows.length >= expectedRuns && rows.every((r) => r.status !== 'queued' && r.status !== 'running')) {
        await new Promise((r) => setTimeout(r, 300))
        await Promise.all(handles.map((h) => h.turns.idle()))
        const again = await runsOf()
        if (again.length === rows.length && again.every((r) => r.status !== 'queued' && r.status !== 'running')) return again
      }
      if (Date.now() > deadline) throw new Error(`co-worker turns did not settle: ${JSON.stringify(rows.map((r) => r.status))}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  async function threadOf(rootId: string) {
    const { listThread } = await import('../../../../modules/messages/service')
    const { parent, replies } = await listThread(deps, ann, rootId)
    return [parent, ...replies].map((m) => ({ authorId: m.authorId, body: m.body }))
  }

  it('a person asks Marketing; Marketing pulls in GTM; GTM answers; Marketing answers the person — each as itself', async () => {
    seen.length = 0
    script = (s, n) => {
      if (s.userId === marketing.id) return n === 1 ? `Story: calm software for small teams. @${gtm.slug} what price fits?` : `@${ann} plan: launch with the calm story at $12 per seat (GTM).`
      return `$12 per seat, annual discount. @${marketing.slug} that fits the story.`
    }
    const { createChannel, postMessage } = await import('../../../../modules/messages/service')
    const launch = await createChannel(deps, ann, { name: `launch-${tag}`, private: false })
    conversations.push(launch.id)
    const { message: root } = await postMessage(deps, ann, launch.id, `@${marketing.slug} plan the launch`)

    const rows = await settle(3)
    // Exactly one run per (co-worker, triggering message), although two processes heard each message.
    expect(rows.map((r) => [r.coworker_user_id, r.status])).toEqual([
      [marketing.id, 'done'],
      [gtm.id, 'done'],
      [marketing.id, 'done'],
    ])
    expect(new Set(rows.map((r) => `${r.coworker_user_id}:${r.trigger_message_id}`)).size).toBe(3)
    expect(rows.every((r) => r.thread_root_id === root.id)).toBe(true)

    const thread = await threadOf(root.id)
    expect(thread.map((m) => m.authorId)).toEqual([ann, marketing.id, gtm.id, marketing.id])
    expect(thread[1]!.body).toContain(`@${gtm.slug}`)
    expect(thread[3]!.body).toContain('plan: launch with the calm story')

    // Each model request carried its own model and its own system prompt, billed to itself, in its run's trace.
    expect(seen.map((s) => [s.userId, s.model])).toEqual([
      [marketing.id, 'anthropic/claude-sonnet-5.5'],
      [gtm.id, 'google/gemini-3.8-flash'],
      [marketing.id, 'anthropic/claude-sonnet-5.5'],
    ])
    expect(seen[0]!.system).toContain(`You are ${marketing.name} (@${marketing.slug})`)
    expect(seen[0]!.system).not.toContain('You are the company brain.')
    expect(seen[1]!.system).toContain(`You are ${gtm.name} (@${gtm.slug})`)
    expect(seen[1]!.system).toContain('Story: calm software for small teams.')
    expect(seen.map((s) => s.traceId)).toEqual(rows.map((r) => r.id))

    // Costs land on each co-worker's own user id, and each run carries its trace's cost.
    const costs = await operator`
      select user_id, group_id, total_cost_usd from activity_call_log where user_id in ${operator([marketing.id, gtm.id])} and provider = 'mock-gateway'`
    expect(costs.map((c) => c.user_id).sort()).toEqual([marketing.id, marketing.id, gtm.id].sort())
    for (const r of rows) {
      const own = costs.filter((c) => c.group_id === r.id)
      expect(own).toHaveLength(1)
      expect(own[0]!.user_id).toBe(r.coworker_user_id)
      expect(Number(r.cost_usd)).toBeCloseTo(Number(own[0]!.total_cost_usd), 6)
      expect(Number(r.cost_usd)).toBeGreaterThan(0)
    }
  }, 60_000)

  it('a scripted ping-pong stops at 8 co-worker turns with a visible note @mentioning the accountable human', async () => {
    seen.length = 0
    script = (s, n) => (s.userId === marketing.id ? `ping ${n} @${gtm.slug}` : `pong ${n} @${marketing.slug}`)
    const before = (await runsOf()).length
    const { createChannel, postMessage } = await import('../../../../modules/messages/service')
    const loop = await createChannel(deps, ann, { name: `loop-${tag}`, private: false })
    conversations.push(loop.id)
    const { message: root } = await postMessage(deps, ann, loop.id, `@${marketing.slug} start the ping-pong`)

    const rows = (await settle(before + 9)).slice(before)
    expect(rows.map((r) => r.status)).toEqual([...Array<string>(8).fill('done'), 'stopped'])
    expect(rows[8]).toMatchObject({ stop_reason: 'thread_budget' })
    expect(seen).toHaveLength(8)
    const thread = await threadOf(root.id)
    expect(thread).toHaveLength(1 + 8 + 1)
    const note = thread.at(-1)!
    expect(note.authorId).toBe(marketing.id)
    expect(note.body).toContain('this thread had 8 AI co-worker turns in a row without a person')
    expect(note.body).toContain(`@${humanHandle}`)
  }, 90_000)
})
