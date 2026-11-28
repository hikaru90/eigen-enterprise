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
import { coworkerPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { GatewayCompleteFn } from '$lib/server/agent/gateway-model'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'

/**
 * AI Co-workers C6 on the test database (plan/phase-ai-coworkers.md §8): a
 * rhythm's due slot posts once across two app processes, and a task assigned
 * through tasks.assign is worked, commented and completed by the co-worker —
 * every piece real except the model: Postgres Messages, tasks, coworker_rhythm,
 * the coworker_run queue and its notices, the kernel registry (messages.* and
 * tasks.* as the co-worker), the durable engine on a temp SQLite file and the
 * cost ledger. The model is the mock gateway's chat response shape, scripted;
 * the "tool call" to tasks.complete is made by the script through the registry
 * as the co-worker. The co-worker reports to a test person (its accountable
 * human), so the shared test database's owner does not matter.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

vi.mock('$lib/server/capture/capture-enrich-worker', () => ({ scheduleCaptureEnrichWorker: () => {} }))

describe.skipIf(!DATABASE_URL)('co-worker rhythms and assignments on Postgres with the mock gateway', () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
  const ann = `c6_ann_${tag}`
  const boss = `c6_admin_${tag}`
  let operator: postgres.Sql
  let marketing: CoworkerView
  let stateDir: string
  const conversations: string[] = []
  const tasks: string[] = []
  const handles: CoworkerTurnsHandle[] = []
  const host = globalThis as { __eeCoworkerTurns?: CoworkerTurnsHandle }
  let hostBefore: CoworkerTurnsHandle | undefined
  let registry: KernelRegistry
  let script: (system: string) => Promise<string> = async () => 'unset'
  let deps: Awaited<ReturnType<typeof import('../../../../modules/messages/live')['messagesDeps']>>

  const reply = (content: string) => ({
    id: 'mock-completion',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  })

  beforeAll(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'ee-c6-'))
    process.env.DRIVE_STORAGE_DIR ??= join(stateDir, 'drive')
    // Messages' live deps boot the app; boot it first without its own co-worker turns, so
    // only this spec's two "processes" claim runs (and none replaces the turns on globalThis).
    await (await import('$lib/server/boot')).bootApp({ coworkers: { start: false } })
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
    marketing = await svc.createCoworker(
      admin,
      { templateId: 'marketing-manager', name: `Marketing ${tag}`, modelId: 'google/gemini-3.8-flash', reportsToUserId: ann },
      svc.coworkerDeps(),
    )
    expect(marketing.accountableHuman).toMatchObject({ id: ann, reason: 'chain' })

    const { messagesDeps, messagesHub } = await import('../../../../modules/messages/live')
    const { createMessagesTools } = await import('../../../../modules/messages/tools')
    const { createTaskTools } = await import('../../../../modules/memory/task-tools')
    deps = await messagesDeps()
    registry = new KernelRegistry({ principalScope: livePrincipalScope })
    for (const t of createMessagesTools({ deps: async () => deps, push: () => {} })) registry.register(t)
    for (const t of createTaskTools()) registry.register(t)

    const { withDbUser } = await import('$lib/server/db')
    const { logActivityCall } = await import('$lib/server/activity/log-call')
    const complete: GatewayCompleteFn = async (input) => {
      await withDbUser(input.userId, (db) => logActivityCall(db, input.userId, { provider: 'mock-gateway', operation: 'chat', baseCostUsd: 0.002 }))
      return reply(await script(input.messages.find((m) => m.role === 'system')?.content ?? ''))
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
    const { liveRhythmStore } = await import('./db-rhythm-store')
    const { liveReadTask } = await import('./task-work')
    const { liveCompanyContext } = await import('./company-context')
    const { runWithTrace } = await import('$lib/server/activity/trace-context')
    const hub = await messagesHub()
    // Two app processes: each its own runtime and turns; one database queue.
    for (let i = 0; i < 2; i++) {
      const runtime = new AgentRuntime({
        registry,
        isToolActive: async () => true,
        eventSink: new InMemoryEventSink(),
        engines: new Map([['durable', engine]]),
        spentUsdToday: ledgerSpentUsdToday,
      })
      const handle = composeCoworkerTurns({
        aiSource: async () => 'byok' as const,
        typing: new (await import('../../../../modules/messages/typing')).TypingBoard(),
        registry,
        runtime,
        messages: deps,
        hub,
        coworkers: {
          get: svc.getCoworker,
          orgChart: svc.orgChart,
          listEnabled: async () => (await svc.listEnabledCoworkers()).filter((c) => c.id === marketing.id),
        },
        runs: liveCoworkerRunStore,
        company: liveCompanyContext,
        turnCost: liveTurnCost,
        inTrace: runWithTrace,
        rhythms: liveRhythmStore,
        readTask: liveReadTask,
      })
      await handle.reload()
      handles.push(handle)
    }
    // tasks.assign in this process starts the run here (boot keeps the turns on globalThis).
    hostBefore = host.__eeCoworkerTurns
    host.__eeCoworkerTurns = handles[0]
  }, 60_000)

  afterAll(async () => {
    host.__eeCoworkerTurns = hostBefore
    for (const h of handles) h.stop()
    await Promise.all(handles.map((h) => h.turns.idle()))
    if (marketing) {
      await operator`delete from coworker_run where coworker_user_id = ${marketing.id}`
      await operator`delete from coworker_rhythm where coworker_user_id = ${marketing.id}`
    }
    if (tasks.length > 0) await operator`delete from assigned_tasks where id in ${operator(tasks)}`
    if (conversations.length > 0) await operator`delete from message_conversations where id in ${operator(conversations)}`
    const ids = [ann, boss, marketing?.id].filter((x): x is string => typeof x === 'string')
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
      select id, trigger_kind, status, stop_reason, cost_usd, conversation_id, thread_root_id, task_id, rhythm_id, trigger_key, error
      from coworker_run where coworker_user_id = ${marketing.id} order by triggered_at, id`
  }

  async function settle(expected: number) {
    const deadline = Date.now() + 45_000
    for (;;) {
      await Promise.all(handles.map((h) => h.turns.idle()))
      const rows = await runsOf()
      if (rows.length >= expected && rows.every((r) => r.status !== 'queued' && r.status !== 'running')) return rows
      if (Date.now() > deadline) throw new Error(`co-worker runs did not settle: ${JSON.stringify(rows.map((r) => [r.status, r.stop_reason, r.error]))}`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  it('a due rhythm slot posts once across two processes, and the accountable human gets the result in Needs you', async () => {
    script = async () => 'Standup: email drafted, pricing next, no blockers.'
    const { createChannel, listMessages } = await import('../../../../modules/messages/service')
    const channel = await createChannel(deps, ann, { name: `standup-${tag}`, private: false })
    conversations.push(channel.id)
    const { liveRhythmStore } = await import('./db-rhythm-store')
    const { liveCoworkerRunStore } = await import('./db-run-store')
    const { liveRhythmTargets } = await import('./rhythm-live')
    const { createRhythm, tickRhythms } = await import('./rhythms')
    const svc = await import('./index')
    let now = new Date('2026-11-22T12:00:00Z')
    const process = (i: number) => ({
      store: liveRhythmStore,
      runs: liveCoworkerRunStore,
      coworkers: { get: svc.getCoworker },
      targets: liveRhythmTargets,
      start: (id: string) => {
        void handles[i]!.turns.work(id)
      },
      ready: () => {},
      now: () => now,
    })
    const rhythm = await createRhythm(process(0), { id: boss, role: 'admin', kind: 'person' }, {
      coworkerUserId: marketing.id,
      weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'],
      time: '09:00',
      timeZone: 'Europe/Berlin',
      instruction: 'Post the marketing standup.',
      targetConversationId: channel.id,
    })
    expect(rhythm).toMatchObject({ targetTitle: `#standup-${tag}`, nextAt: '2026-11-23T08:00:00.000Z' })

    now = new Date('2026-11-23T08:00:20Z')
    const [a, b] = await Promise.all([tickRhythms(process(0)), tickRhythms(process(1))])
    expect(a.length + b.length).toBe(1)
    const rows = await settle(1)
    expect(rows).toHaveLength(1)
    const { messages } = await listMessages(deps, ann, channel.id, { limit: 10 })
    expect(messages.map((m) => [m.authorId, m.parentId, m.body])).toEqual([[marketing.id, null, 'Standup: email drafted, pricing next, no blockers.']])
    expect(rows[0]).toMatchObject({
      trigger_kind: 'rhythm',
      status: 'done',
      rhythm_id: rhythm.id,
      thread_root_id: messages[0]!.id,
      trigger_key: `rhythm:${rhythm.id}:2026-11-23T08:00:00.000Z`,
    })
    expect(Number(rows[0]!.cost_usd)).toBeGreaterThan(0)

    // Needs you: the accountable human sees it with a link to the post, and acknowledges it.
    const { liveNoticeDeps } = await import('./rhythm-live')
    const { needsYouNotices, markNoticeSeen } = await import('./notices')
    const notices = await needsYouNotices(await liveNoticeDeps(), ann)
    expect(notices.map((n) => [n.run.id, n.href])).toEqual([[rows[0]!.id, `/messages?c=${channel.id}&t=${messages[0]!.id}`]])
    await markNoticeSeen(await liveNoticeDeps(), ann, rows[0]!.id)
    expect(await needsYouNotices(await liveNoticeDeps(), ann)).toEqual([])
  }, 60_000)

  it('tasks.assign to the co-worker: it works the task as itself, comments the result and completes it', async () => {
    const before = (await runsOf()).length
    script = async (system) => {
      const taskId = /Task id: (\S+)/.exec(system)?.[1]
      if (!taskId) throw new Error('the assignment prompt has no task id')
      await registry.execute('tasks.complete', { task_id: taskId }, { principal: coworkerPrincipal(marketing.id, marketing.agentId), requestId: 'c6-complete' })
      return 'Drafted: "Calm software, now for teams." Done.'
    }
    const task = (await registry.execute(
      'tasks.assign',
      { assignee_id: marketing.id, title: `Draft the launch email ${tag}`, context: 'For the December list.' },
      { principal: { id: ann, kind: 'human', roles: ['member'] }, requestId: 'c6-assign' },
    )) as { id: string }
    tasks.push(task.id)
    const rows = (await settle(before + 1)).slice(before)
    expect(rows).toEqual([expect.objectContaining({ trigger_kind: 'assignment', status: 'done', task_id: task.id, trigger_key: `task:${task.id}` })])
    const [t] = await operator`select status from assigned_tasks where id = ${task.id}`
    expect(t!.status).toBe('done')
    const comments = await operator`select author_id, body from assigned_task_comments where task_id = ${task.id}`
    expect(comments.map((c) => [c.author_id, c.body])).toEqual([[marketing.id, 'Drafted: "Calm software, now for teams." Done.']])
    // The assigner is also the accountable human here: one notice, linking to the task.
    const notices = await operator`select user_id from coworker_run_notice where run_id = ${rows[0]!.id}`
    expect(notices.map((n) => n.user_id)).toEqual([ann])
  }, 60_000)
})
