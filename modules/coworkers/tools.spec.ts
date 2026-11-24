import { describe, expect, it } from 'vitest'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from '$lib/kernel/approvals'
import { coworkerPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import { onCoworkersChanged } from '$lib/server/coworkers/changes'
import { memoryCoworkerStore } from '$lib/server/coworkers/memory-store'
import { MemoryEventStores } from '$lib/server/coworkers/events'
import { MemoryRhythmStore } from '$lib/server/coworkers/rhythms'
import { MemoryCoworkerRunStore } from '$lib/server/coworkers/run-store'
import { getCoworker, type CoworkerActor, type OrgMember } from '$lib/server/coworkers/service'
import { COWORKERS_GATED_TOOLS, COWORKERS_TOOL_NAMES, coworkersManifest } from './manifest'
import { createCoworkersTools } from './tools'

const at = new Date('2026-11-23T09:00:00Z')
const person = (id: string, role: OrgMember['role'], minutesBefore: number): OrgMember => ({
  id,
  name: id,
  email: `${id}@k.co`,
  role,
  kind: 'human',
  createdAt: new Date(at.getTime() - minutesBefore * 60_000),
})

const roleOf: Record<string, OrgMember['role']> = { olga: 'owner', ari: 'admin', mo: 'member' }

function setup(mode: 'ask' | 'reasonable' | 'allow_all' = 'allow_all', opts: { avatars?: Set<string> } = {}) {
  const store = memoryCoworkerStore([person('olga', 'owner', 3), person('ari', 'admin', 2), person('mo', 'member', 1)])
  let n = 0
  const avatars = opts.avatars ?? new Set<string>()
  const deps = {
    store,
    now: () => at,
    newId: () => `cw${String(++n).padStart(6, '0')}abcdef`,
    avatarExists: async (sha: string) => avatars.has(sha),
  }
  const runs = new MemoryCoworkerRunStore()
  /** Which conversations each reader may see (Messages decides this live). */
  const sees: Record<string, string[]> = { olga: ['conv-launch', 'conv-dm'], mo: ['conv-launch'] }
  const rhythmStore = new MemoryRhythmStore(runs)
  const started: string[] = []
  const eventStores = new MemoryEventStores()
  const tools = createCoworkersTools({
    events: async () => ({ subscriptions: eventStores, observations: eventStores, coworkers: { get: (id) => getCoworker(store, id) }, now: () => at }),
    runs: async () => runs,
    rhythms: async () => ({
      store: rhythmStore,
      runs,
      coworkers: { get: (id) => getCoworker(store, id) },
      targets: {
        // Every co-worker is in #launch only.
        coworkerMayPost: async (_cw, id) => id === '11111111-1111-4111-8111-111111111111',
        titleFor: async (reader, id) => (id === '11111111-1111-4111-8111-111111111111' && reader !== 'nobody' ? '#launch' : null),
        listFor: async () => [{ id: '11111111-1111-4111-8111-111111111111', title: '#launch', kind: 'channel' as const }],
      },
      start: (id) => {
        started.push(id)
      },
      ready: () => {},
      now: () => at,
    }),
    notices: async () => ({
      runs,
      nameOf: async (id) => (await getCoworker(store, id)).name,
      visible: async (reader, ids) => new Set(ids.filter((id) => (sees[reader] ?? []).includes(id))),
      now: () => at,
    }),
    runLocations: async (reader, ids) => new Set(ids.filter((id) => (sees[reader.id] ?? []).includes(id))),
    deps: async () => deps,
    actor: async (ctx): Promise<CoworkerActor> => {
      const p = ctx.principal
      if (p.kind === 'coworker') return { id: p.id, role: 'member', kind: 'coworker' }
      if (p.kind === 'human') return { id: p.id, role: roleOf[p.id] ?? null, kind: 'person' }
      return { id: p.id, role: 'admin', kind: 'agent' }
    },
  })
  const approvals = new InMemoryApprovalStore()
  const registry = new KernelRegistry({
    approvalStore: approvals,
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(COWORKERS_GATED_TOOLS), new InMemoryApprovalModeStore(mode)),
  })
  for (const t of tools) registry.register(t)
  const as = (id: string, roles: string[]): ToolContext => ({ principal: { id, kind: 'human', roles }, requestId: `r-${id}` })
  const ownerCtx = as('olga', ['admin', 'member'])
  const memberCtx = as('mo', ['member'])
  const tool = (name: string) => tools.find((t) => t.name === name)!
  /** Runs an always-ask tool: the call waits, a person approves, the same call runs. */
  const approved = async (name: string, input: unknown, ctx: ToolContext) => {
    await expect(registry.execute(name, input, ctx)).rejects.toMatchObject({ code: 'approval_required' })
    const pending = (await approvals.listPending()).find((r) => r.toolName === name)
    await approvals.decide(pending!.id, 'approved', 'olga')
    return registry.execute(name, input, ctx)
  }
  return { store, registry, tool, ownerCtx, memberCtx, approved, approvals, runs, started, eventStores }
}

describe('coworkers module', () => {
  it('owns exactly its tools, in the coworkers and org namespaces', () => {
    const { tool } = setup()
    expect(coworkersManifest.toolNamespaces).toEqual(['coworkers', 'org'])
    expect(createCoworkersTools().map((t) => t.name)).toEqual([...COWORKERS_TOOL_NAMES])
    for (const name of COWORKERS_TOOL_NAMES) expect(tool(name).module).toBe('coworkers')
  })

  it('reads are for every member; writes for admins and the agent; create and remove always ask', () => {
    const { tool } = setup()
    for (const name of ['coworkers.templates', 'coworkers.list', 'coworkers.get', 'coworkers.runs', 'org.chart']) {
      expect(tool(name)).toMatchObject({ auditClass: 'read', permission: { roles: ['admin', 'member', 'agent'] } })
    }
    for (const name of ['coworkers.create', 'coworkers.update', 'coworkers.enable', 'coworkers.disable', 'coworkers.remove']) {
      expect(tool(name)).toMatchObject({ auditClass: 'mutate', permission: { roles: ['admin', 'agent'] } })
    }
    expect(tool('coworkers.create')).toMatchObject({ approvalAlways: true, approvalRisk: 'internal' })
    expect(tool('coworkers.remove')).toMatchObject({ approvalAlways: true, approvalRisk: 'destructive' })
    for (const name of COWORKERS_GATED_TOOLS) expect(tool(name).approvalRisk).toBe('internal')
    expect(tool('org.set_position').permission.roles).toEqual(['admin', 'member', 'agent'])
  })

  it('templates lists the catalog', async () => {
    const { registry, memberCtx } = setup()
    const out = (await registry.execute('coworkers.templates', {}, memberCtx)) as { templates: Array<{ id: string }> }
    expect(out.templates.map((t) => t.id)).toEqual([
      'marketing-manager',
      'go-to-market-manager',
      'designer',
      'ops-analyst',
      'finance-analyst',
      'customer-success-lead',
    ])
  })

  it('create waits for a yes even in allow_all, then makes the co-worker; the activity names it', async () => {
    const { registry, ownerCtx, approved, tool } = setup('allow_all')
    const cw = (await approved('coworkers.create', { template_id: 'marketing-manager', name: 'Mara' }, ownerCtx)) as { id: string; name: string }
    expect(cw.name).toBe('Mara')
    expect(tool('coworkers.create').activity!({ template_id: 'marketing-manager' }, cw)).toBe('Created the AI co-worker Mara')
    const list = (await registry.execute('coworkers.list', {}, ownerCtx)) as { coworkers: Array<{ id: string; kind?: string }> }
    expect(list.coworkers.map((c) => c.id)).toEqual([cw.id])
  })

  it('create refuses a model outside the chat pool, before anyone is asked', async () => {
    const { registry, ownerCtx, approved } = setup()
    await expect(approved('coworkers.create', { template_id: 'designer', model_id: 'openai/gpt-made-up' }, ownerCtx)).rejects.toMatchObject({
      code: 'invalid_model',
    })
    await expect(registry.execute('coworkers.create', { template_id: 'nope' }, ownerCtx)).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('a member reads the chart but cannot create; a co-worker reads but writes nothing', async () => {
    const { registry, ownerCtx, memberCtx, approved } = setup()
    await expect(registry.execute('coworkers.create', { template_id: 'designer' }, memberCtx)).rejects.toMatchObject({ code: 'permission_denied' })
    const cw = (await approved('coworkers.create', { template_id: 'designer' }, ownerCtx)) as { id: string }
    const self = { principal: coworkerPrincipal(cw.id, `coworker-${cw.id}`), requestId: 'r-cw' }
    const chart = (await registry.execute('org.chart', {}, self)) as { people: Array<{ id: string; kind: string }> }
    expect(chart.people.map((p) => `${p.id}:${p.kind}`)).toEqual(['olga:human', 'ari:human', 'mo:human', `${cw.id}:coworker`])
    await expect(registry.execute('coworkers.disable', { user_id: cw.id }, self)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(registry.execute('org.set_position', { user_id: cw.id, title: 'CEO' }, self)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('org.set_position: a member edits their own seat; cycles are refused', async () => {
    const { registry, ownerCtx, memberCtx } = setup()
    await expect(registry.execute('org.set_position', { user_id: 'mo', title: 'Engineer', accountabilities: ['Ship'] }, memberCtx)).resolves.toMatchObject({
      title: 'Engineer',
    })
    await expect(registry.execute('org.set_position', { user_id: 'mo', reports_to_user_id: 'olga' }, memberCtx)).rejects.toMatchObject({ code: 'forbidden' })
    await registry.execute('org.set_position', { user_id: 'mo', reports_to_user_id: 'ari' }, ownerCtx)
    await expect(registry.execute('org.set_position', { user_id: 'ari', reports_to_user_id: 'mo' }, ownerCtx)).rejects.toMatchObject({ code: 'org_cycle' })
  })

  it('update, disable, enable wait on the approval mode (ask), and remove always asks', async () => {
    const { registry, ownerCtx, approved } = setup('ask')
    const cw = (await approved('coworkers.create', { template_id: 'ops-analyst' }, ownerCtx)) as { id: string }
    await expect(registry.execute('coworkers.disable', { user_id: cw.id }, ownerCtx)).rejects.toMatchObject({ code: 'approval_required' })
    const removed = (await approved('coworkers.remove', { user_id: cw.id }, ownerCtx)) as { removedAt: string | null; enabled: boolean }
    expect(removed).toMatchObject({ removedAt: at.toISOString(), enabled: false })
  })

  it('every co-worker change is announced in process, so the turns reload their agents (C3)', async () => {
    const { registry, ownerCtx, approved } = setup('allow_all')
    let changes = 0
    const off = onCoworkersChanged(() => {
      changes += 1
    })
    try {
      const cw = (await approved('coworkers.create', { template_id: 'designer' }, ownerCtx)) as { id: string }
      await registry.execute('coworkers.update', { user_id: cw.id, model_id: 'google/gemini-3.8-flash' }, ownerCtx)
      await registry.execute('coworkers.disable', { user_id: cw.id }, ownerCtx)
      await registry.execute('coworkers.enable', { user_id: cw.id }, ownerCtx)
      await approved('coworkers.remove', { user_id: cw.id }, ownerCtx)
      // A refused change announces nothing.
      await expect(registry.execute('coworkers.update', { user_id: cw.id, name: 'Back' }, ownerCtx)).rejects.toMatchObject({ code: 'removed' })
      await new Promise((r) => setTimeout(r, 0))
      expect(changes).toBe(5)
    } finally {
      off()
    }
  })
})

describe('coworkers.runs (C3): the run log', () => {
  it('lists a co-worker’s turns newest first with trigger, status, cost and timings; hides where a reader may not look', async () => {
    const { registry, ownerCtx, memberCtx, approved, runs } = setup('allow_all')
    const cw = (await approved('coworkers.create', { template_id: 'marketing-manager', name: 'Mara' }, ownerCtx)) as { id: string }
    const first = await runs.enqueue({
      coworkerUserId: cw.id,
      triggerKind: 'mention',
      conversationId: 'conv-launch',
      threadRootId: 'root-1',
      triggerMessageId: 'msg-1',
      requestedByUserId: 'mo',
      triggeredAt: new Date('2026-11-23T09:01:00Z'),
      rhythmId: null,
      taskId: null,
      triggerKey: null,
    })
    await runs.update(first!.id, {
      status: 'done',
      costUsd: 0.0123,
      startedAt: new Date('2026-11-23T09:01:01Z'),
      endedAt: new Date('2026-11-23T09:01:09Z'),
    })
    const second = await runs.enqueue({
      coworkerUserId: cw.id,
      triggerKind: 'dm',
      conversationId: 'conv-dm',
      threadRootId: null,
      triggerMessageId: 'msg-2',
      requestedByUserId: 'olga',
      triggeredAt: new Date('2026-11-23T09:05:00Z'),
      rhythmId: null,
      taskId: null,
      triggerKey: null,
    })
    await runs.update(second!.id, { status: 'stopped', stopReason: 'daily_cap', error: 'reached its daily spend cap', endedAt: new Date('2026-11-23T09:05:01Z') })

    const owner = (await registry.execute('coworkers.runs', { user_id: cw.id }, ownerCtx)) as { runs: Array<Record<string, unknown>> }
    expect(owner.runs).toEqual([
      expect.objectContaining({
        id: second!.id,
        triggerKind: 'dm',
        status: 'stopped',
        stopReason: 'daily_cap',
        conversationId: 'conv-dm',
        threadRootId: null,
        threadUrl: '/messages?c=conv-dm',
        hidden: false,
        requestedByUserId: 'olga',
        startedAt: null,
      }),
      expect.objectContaining({
        id: first!.id,
        triggerKind: 'mention',
        status: 'done',
        stopReason: null,
        costUsd: 0.0123,
        threadUrl: '/messages?c=conv-launch&t=root-1',
        triggerMessageId: 'msg-1',
        triggeredAt: '2026-11-23T09:01:00.000Z',
        startedAt: '2026-11-23T09:01:01.000Z',
        endedAt: '2026-11-23T09:01:09.000Z',
      }),
    ])
    // The member is not in that DM: the run is listed, where it ran is not.
    const member = (await registry.execute('coworkers.runs', { user_id: cw.id, limit: 5 }, memberCtx)) as { runs: Array<Record<string, unknown>> }
    expect(member.runs[0]).toMatchObject({ id: second!.id, hidden: true, conversationId: null, threadRootId: null, triggerMessageId: null, threadUrl: null })
    expect(member.runs[1]).toMatchObject({ id: first!.id, hidden: false, conversationId: 'conv-launch' })
    expect(((await registry.execute('coworkers.runs', { user_id: cw.id, limit: 1 }, ownerCtx)) as { runs: unknown[] }).runs).toHaveLength(1)
  })

  it('an unknown co-worker answers not_found', async () => {
    const { registry, memberCtx } = setup()
    await expect(registry.execute('coworkers.runs', { user_id: 'nobody' }, memberCtx)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('rhythms and Needs you (C6)', () => {
  const LAUNCH = '11111111-1111-4111-8111-111111111111'
  const OTHER = '22222222-2222-4222-8222-222222222222'
  const rhythm = { weekdays: ['MO', 'WE'], time: '09:00', time_zone: 'Europe/Berlin', instruction: 'Post the standup.', conversation_id: LAUNCH }

  it('members read rhythms; admins create, change, run now and delete them; output schemas hold', async () => {
    const { registry, ownerCtx, memberCtx, approved, runs, started, tool } = setup('allow_all')
    for (const name of ['coworkers.rhythm_list', 'coworkers.needs_you']) expect(tool(name)).toMatchObject({ auditClass: 'read', permission: { roles: ['admin', 'member', 'agent'] } })
    for (const name of ['coworkers.rhythm_create', 'coworkers.rhythm_update', 'coworkers.rhythm_delete', 'coworkers.rhythm_run_now']) {
      expect(tool(name)).toMatchObject({ auditClass: 'mutate', permission: { roles: ['admin', 'agent'] } })
      expect(tool(name).outputSchema).toBeDefined()
    }
    expect(tool('coworkers.notice_seen')).toMatchObject({ auditClass: 'mutate', permission: { roles: ['admin', 'member', 'agent'] } })
    const cw = (await approved('coworkers.create', { template_id: 'marketing-manager', name: 'Mara' }, ownerCtx)) as { id: string }

    await expect(registry.execute('coworkers.rhythm_create', { user_id: cw.id, ...rhythm }, memberCtx)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(registry.execute('coworkers.rhythm_create', { user_id: cw.id, ...rhythm, conversation_id: OTHER }, ownerCtx)).rejects.toMatchObject({ code: 'not_found' })
    await expect(registry.execute('coworkers.rhythm_create', { user_id: cw.id, ...rhythm, time: '9:00' }, ownerCtx)).rejects.toMatchObject({ code: 'invalid_input' })
    const created = (await registry.execute('coworkers.rhythm_create', { user_id: cw.id, ...rhythm }, ownerCtx)) as { id: string; nextAt: string }
    expect(created).toMatchObject({ targetTitle: '#launch', weekdays: ['MO', 'WE'], nextAt: '2026-11-25T08:00:00.000Z' })

    const listed = (await registry.execute('coworkers.rhythm_list', { user_id: cw.id }, memberCtx)) as { rhythms: { id: string }[]; targets: unknown[] }
    expect(listed.rhythms.map((r) => r.id)).toEqual([created.id])
    expect(listed.targets).toEqual([{ id: LAUNCH, title: '#launch', kind: 'channel' }])

    const off = (await registry.execute('coworkers.rhythm_update', { rhythm_id: created.id, enabled: false }, ownerCtx)) as { enabled: boolean; nextAt: null }
    expect(off).toMatchObject({ enabled: false, nextAt: null })

    const now = (await registry.execute('coworkers.rhythm_run_now', { rhythm_id: created.id }, ownerCtx)) as { run: { id: string; triggerKind: string; status: string } }
    expect(now.run).toMatchObject({ triggerKind: 'rhythm', status: 'queued', rhythmId: created.id })
    expect(started).toEqual([now.run.id])
    expect(runs.rows).toHaveLength(1)

    await expect(registry.execute('coworkers.rhythm_delete', { rhythm_id: created.id }, memberCtx)).rejects.toMatchObject({ code: 'permission_denied' })
    expect(await registry.execute('coworkers.rhythm_delete', { rhythm_id: created.id }, ownerCtx)).toEqual({ id: created.id, deleted: true })
    expect(((await registry.execute('coworkers.rhythm_list', { user_id: cw.id }, memberCtx)) as { rhythms: unknown[] }).rhythms).toEqual([])
  })

  it('needs_you lists only your own notices with where to look; notice_seen clears one, and refuses another person’s', async () => {
    const { registry, ownerCtx, memberCtx, approved, runs } = setup('allow_all')
    const cw = (await approved('coworkers.create', { template_id: 'marketing-manager', name: 'Mara' }, ownerCtx)) as { id: string }
    const run = await runs.enqueue({
      coworkerUserId: cw.id,
      triggerKind: 'rhythm',
      conversationId: 'conv-launch',
      threadRootId: null,
      triggerMessageId: null,
      requestedByUserId: 'olga',
      triggeredAt: at,
      rhythmId: null,
      taskId: null,
      triggerKey: 'rhythm:r:1',
    })
    await runs.update(run!.id, { status: 'done', threadRootId: 'post-1', endedAt: at })
    await runs.addNotices(run!.id, ['olga'], at)

    const mine = (await registry.execute('coworkers.needs_you', {}, ownerCtx)) as { notices: Array<{ href: string; coworker: { name: string } }> }
    expect(mine.notices).toEqual([expect.objectContaining({ href: '/messages?c=conv-launch&t=post-1', coworker: { id: cw.id, name: 'Mara' } })])
    expect(((await registry.execute('coworkers.needs_you', {}, memberCtx)) as { notices: unknown[] }).notices).toEqual([])
    await expect(registry.execute('coworkers.notice_seen', { run_id: run!.id }, memberCtx)).rejects.toMatchObject({ code: 'not_found' })
    expect(await registry.execute('coworkers.notice_seen', { run_id: run!.id }, ownerCtx)).toEqual({ runId: run!.id, seen: true })
    expect(((await registry.execute('coworkers.needs_you', {}, ownerCtx)) as { notices: unknown[] }).notices).toEqual([])
  })
})

describe('event subscriptions (C7)', () => {
  it('members read which events a co-worker notices and what became of them; only admins switch kinds on and off', async () => {
    const { registry, ownerCtx, memberCtx, approved, tool, eventStores } = setup('allow_all')
    expect(tool('coworkers.event_subscriptions_get')).toMatchObject({ auditClass: 'read', permission: { roles: ['admin', 'member', 'agent'] } })
    expect(tool('coworkers.event_subscriptions_set')).toMatchObject({ auditClass: 'mutate', permission: { roles: ['admin', 'agent'] } })
    const cw = (await approved('coworkers.create', { template_id: 'marketing-manager', name: 'Mara' }, ownerCtx)) as { id: string }

    const off = (await registry.execute('coworkers.event_subscriptions_get', { user_id: cw.id }, memberCtx)) as Record<string, unknown>
    expect(off).toMatchObject({ userId: cw.id, kinds: [{ kind: 'channel_message', on: false }] })
    // The per-co-worker hourly limit is gone (routing: one call per message).
    expect(off).not.toHaveProperty('hourlyLimit')

    await expect(registry.execute('coworkers.event_subscriptions_set', { user_id: cw.id, event_kinds: ['channel_message'] }, memberCtx)).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(registry.execute('coworkers.event_subscriptions_set', { user_id: cw.id, event_kinds: ['mail'] }, ownerCtx)).rejects.toMatchObject({ code: 'invalid_input' })
    const on = await registry.execute('coworkers.event_subscriptions_set', { user_id: cw.id, event_kinds: ['channel_message'] }, ownerCtx)
    expect(on).toMatchObject({ kinds: [{ kind: 'channel_message', on: true }] })
    expect(await eventStores.list(cw.id)).toEqual(['channel_message'])

    // What it heard is counted, skipped ones included (visible, never a silent drop).
    const claimed = await eventStores.claimRoute({ eventKind: 'channel_message', eventId: 'm1', conversationId: null, authorUserId: 'someone', coworkerUserIds: [cw.id], now: at })
    await eventStores.finish(claimed!.observations[0]!.id, { outcome: 'skipped_author_cap', error: 'the author’s daily AI budget is spent' }, at)
    const counted = (await registry.execute('coworkers.event_subscriptions_get', { user_id: cw.id }, memberCtx)) as { lastHour: Record<string, number>; lastDay: Record<string, number> }
    expect(counted.lastHour).toMatchObject({ skipped_author_cap: 1, observed: 0 })
    expect(counted.lastDay).toMatchObject({ skipped_author_cap: 1 })

    expect(await registry.execute('coworkers.event_subscriptions_set', { user_id: cw.id, event_kinds: [] }, ownerCtx)).toMatchObject({ kinds: [{ kind: 'channel_message', on: false }] })
    await expect(registry.execute('coworkers.event_subscriptions_get', { user_id: 'nobody' }, memberCtx)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('multi-manager and avatar tool inputs (WS6)', () => {
  const SHA = 'a'.repeat(64)

  it('coworkers.create and coworkers.update accept reports_to_user_ids, avatar_preset, and avatar_sha256', async () => {
    const { registry, ownerCtx, approved } = setup('allow_all', { avatars: new Set([SHA]) })
    const cw = (await approved(
      'coworkers.create',
      { template_id: 'designer', name: 'Dana', reports_to_user_ids: ['ari', 'mo'], avatar_preset: 'prism' },
      ownerCtx,
    )) as Record<string, unknown>
    expect(cw).toMatchObject({
      image: '/avatars/coworkers/prism.svg',
      reportsToUserId: 'ari',
      reportsToUserIds: ['ari', 'mo'],
      accountableHumans: [
        { id: 'ari', name: 'ari', reason: 'chain' },
        { id: 'mo', name: 'mo', reason: 'chain' },
      ],
    })

    const updated = (await registry.execute(
      'coworkers.update',
      { user_id: cw.id, reports_to_user_ids: ['mo', 'olga'], avatar_sha256: SHA },
      ownerCtx,
    )) as Record<string, unknown>
    expect(updated).toMatchObject({
      image: `/api/people/avatar/${SHA}`,
      reportsToUserId: 'mo',
      reportsToUserIds: ['mo', 'olga'],
    })

    const chart = (await registry.execute('org.chart', {}, ownerCtx)) as { people: Array<Record<string, unknown>> }
    expect(chart.people.find((p) => p.id === cw.id)).toMatchObject({
      image: `/api/people/avatar/${SHA}`,
      reportsToUserIds: ['mo', 'olga'],
    })
  })

  it('org.set_position accepts reports_to_user_ids', async () => {
    const { registry, ownerCtx } = setup('allow_all')
    const seat = (await registry.execute('org.set_position', { user_id: 'mo', reports_to_user_ids: ['ari', 'olga'] }, ownerCtx)) as Record<
      string,
      unknown
    >
    expect(seat).toMatchObject({
      reportsToUserId: 'ari',
      reportsToUserIds: ['ari', 'olga'],
    })
  })
})
