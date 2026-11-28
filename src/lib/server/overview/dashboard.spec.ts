import { describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryActivationStore } from '$lib/kernel/modules'

const { kernelHolder, roleMock, backupsMock, upgradeMock, eventRows, journeyRows, assignedTasks, reminders, notices, decisions, companyModules } = vi.hoisted(() => ({
  companyModules: { records: [] as unknown[], sharing: null as unknown },
  assignedTasks: { deps: null as unknown },
  decisions: { questions: null as unknown as (userId: string) => Promise<unknown[]> },
  notices: { deps: null as unknown },
  reminders: { deps: null as unknown },
  kernelHolder: { kernel: null as unknown },
  roleMock: vi.fn(async (): Promise<string> => 'admin'),
  backupsMock: vi.fn(),
  upgradeMock: vi.fn(async () => ({ installed: null, managed: false, source: null, job: null, lastOutcome: null as unknown })),
  eventRows: [] as Array<{ ts: Date; payload: unknown }>,
  journeyRows: [] as Array<{ status: string }>,
}))

vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: roleMock,
  isAdminRole: (r: string | null) => r === 'owner' || r === 'admin',
}))
vi.mock('$lib/server/ee/client', () => {
  class SubstrateUnavailableError extends Error {}
  return {
    SubstrateUnavailableError,
    EeClient: class {
      backups = backupsMock
      upgrade = upgradeMock
    },
  }
})
vi.mock('$lib/server/boot', async () => {
  const index = await import('../../../../modules/index')
  return { appKernel: async () => index.bootstrapKernel() }
})
vi.mock('../../../../modules/index', () => ({ bootstrapKernel: () => kernelHolder.kernel }))
vi.mock('../../../../modules/orchestrator/brain', () => ({
  WEBSITE_FOUNDING_JOURNEY: { kind: 'website-founding' },
}))
vi.mock('$lib/server/db', () => {
  // Chainable query fake: the first .from() decides which rows resolve.
  const query = (rows: () => unknown[]) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy']) chain[m] = () => chain
    chain.limit = async () => rows()
    return chain
  }
  return {
    getDb: () => ({
      select: () => ({
        from: (table: { [k: symbol]: unknown }) => {
          const name = String(
            Object.getOwnPropertySymbols(table)
              .map((s) => table[s])
              .find((v) => typeof v === 'string'),
          )
          return query(() => (name === 'kernel_events' ? eventRows : journeyRows))
        },
      }),
    }),
  }
})

vi.mock('$lib/server/memory/assigned-tasks/live', () => ({ assignedTaskDeps: async () => assignedTasks.deps }))
vi.mock('$lib/server/memory/reminders/live', () => ({ reminderDeps: async () => reminders.deps }))
vi.mock('$lib/server/coworkers/rhythm-live', () => ({ liveNoticeDeps: async () => notices.deps }))
vi.mock('$lib/server/patterns/dashboard-read', () => ({
  dashboardPatterns: async () => ({ digestId: null, createdAt: null, windowStart: null, windowEnd: null, items: [] }),
}))
vi.mock('$lib/server/memory/team-questions/live', () => ({ teamQuestionDeps: async () => ({}) }))
vi.mock('$lib/server/memory/team-questions/service', async (orig) => ({
  ...(await orig<typeof import('$lib/server/memory/team-questions/service')>()),
  listQuestions: async () => ({ questions: [] })
}))
vi.mock('$lib/server/decisions/live', () => ({ needsYouDecisionQuestions: (userId: string) => decisions.questions(userId) }))
vi.mock('$lib/server/traces/live', async () => {
  const { memoryTraceStore } = await import('../../../../modules/traces/memory-store')
  const store = memoryTraceStore()
  return { liveTracesDeps: async () => ({ store, hub: { config: () => ({ ok: true }) }, now: () => new Date() }) }
})
vi.mock('../../../../modules/company-modules/notices-live', async () => {
  const { moduleNotices } = await import('$lib/kernel/module-host/notices')
  return {
    liveModuleNotices: async (viewer: Parameters<typeof moduleNotices>[2]) =>
      moduleNotices(companyModules.records as never, companyModules.sharing as never, viewer),
  }
})

import { MemoryCoworkerRunStore } from '$lib/server/coworkers/run-store'
import { memoryAssignedTaskStore } from '$lib/server/memory/assigned-tasks/memory-store'
import { assignTask, completeTask, type AssignedTaskDeps } from '$lib/server/memory/assigned-tasks/service'
import { memoryReminderStore } from '$lib/server/memory/reminders/memory-store'
import { createReminder, type ReminderDeps } from '$lib/server/memory/reminders/service'
import { decide } from '$lib/server/decisions/decide'
import { decisionKindCatalog, defineDecisionKind } from '$lib/server/decisions/kind'
import { decisionsPort } from '$lib/server/decisions/service'
import { inMemoryDecisionStore } from '$lib/server/decisions/store'
import { loadDashboard } from './dashboard'

const shareKind = defineDecisionKind<{ title: string }, 'share' | 'keep'>({
  id: 'drive.share_file',
  module: 'drive',
  title: 'Share it?',
  instructions: 'Should this file be shared with the team?',
  choices: ['share', 'keep'],
  criteria: { share: 'It is team work.', keep: 'It is private.' },
  status: 'enforced',
  lowConfidence: 0.7,
  state: (i) => i.title,
  logInput: (i) => ({ title: i.title }),
  ask: { who: () => 'owner', question: (i) => `This looks shareable — share “${i.title}”?`, labels: { share: 'Share it', keep: 'Keep it private' } },
})
const decisionStore = inMemoryDecisionStore()
const decisionPort = decisionsPort(decisionStore, decisionKindCatalog([shareKind]))
decisions.questions = (userId) => decisionPort.questions(userId)

function taskDeps(): AssignedTaskDeps {
  const people = [
    { id: 'owner', name: 'Alex', email: 'alex@k.co' },
    { id: 'ony', name: 'Ony', email: 'ony@k.co' },
  ]
  const deps: AssignedTaskDeps = {
    store: memoryAssignedTaskStore(),
    directory: { get: async (id) => people.find((p) => p.id === id) ?? null, list: async () => people },
    notify: async () => {},
    coworkerWork: async () => {
      throw new Error('no AI co-workers in this spec')
    },
    coworkerDelegation: async () => {
      throw new Error('no AI co-workers in this spec')
    },
  }
  assignedTasks.deps = deps
  return deps
}
taskDeps()

const clock = { now: new Date('2026-11-21T12:00:00Z') }
function reminderDeps(): ReminderDeps {
  const deps: ReminderDeps = { store: memoryReminderStore(), timeZoneOf: async () => 'Europe/Berlin', now: () => clock.now }
  reminders.deps = deps
  return deps
}
reminderDeps()

const noticeRuns = new MemoryCoworkerRunStore()
notices.deps = { runs: noticeRuns, nameOf: async () => 'Mara', visible: async (_reader: string, ids: string[]) => new Set(ids) }

async function kernel(active: string[]) {
  const activations = new InMemoryActivationStore()
  for (const id of active) await activations.set(id, true)
  const approvals = new InMemoryApprovalStore()
  await approvals.create({
    id: 'ap1',
    toolName: 'website.publish_page',
    input: {},
    principalId: 'agent',
    status: 'pending',
  })
  const tools: Record<string, { summary: string; output: unknown }> = {
    'website.app_list': {
      summary: 'Apps overview.',
      output: {
        managed: true,
        services: [{ name: 'shop', status: 'healthy' }],
      },
    },
    'website.publish_page': { summary: 'Publish a page.', output: null },
    'owlery.status': {
      summary: 'Email status.',
      output: {
        configured: true,
        region: 'eu-central-1',
        sender: 'hi@k.test',
        senderVerified: true,
        sandbox: false,
      },
    },
  }
  const manifest = (id: string, name: string) => ({
    id,
    name,
    version: '1',
    description: `${name} does work.`,
    tools: [],
    permissions: { roles: ['admin'] },
  })
  return {
    modules: {
      list: () => [
        manifest('website', 'Website'),
        manifest('email', 'Email'),
        manifest('brand', 'Brand'),
      ],
    },
    activations,
    approvals,
    registry: {
      get: (name: string) => (tools[name] ? { name, summary: tools[name].summary } : undefined),
      execute: vi.fn(async (name: string) => tools[name].output),
    },
  }
}

describe('the dashboard at / (loadDashboard)', () => {
  it('shows active and inactive modules, website and email results, actions and approvals', async () => {
    kernelHolder.kernel = await kernel(['website', 'email'])
    journeyRows.splice(0, journeyRows.length, { status: 'active' })
    eventRows.splice(0, eventRows.length, {
      ts: new Date('2026-10-20T10:00:00.000Z'),
      payload: {
        tool: 'website.publish_page',
        auditClass: 'mutate',
        ok: true,
        activity: 'Published the Home page',
      },
    })
    const data = await loadDashboard('owner')
    const { modules, actions, approvals } = data.overview
    expect(modules.map((m) => [m.id, m.active])).toEqual([
      ['website', true],
      ['email', true],
      ['brand', false],
    ])
    expect(modules[0].results).toContainEqual({
      label: 'shop',
      detail: 'Healthy',
      href: '/m/website/apps/shop',
    })
    expect(modules[0].results).toContainEqual({
      label: 'Website setup (in chat)',
      detail: 'In progress',
      href: null,
    })
    expect(modules[1].results).toEqual([{ label: 'hi@k.test', detail: 'Set up', href: '/m/email' }])
    expect(JSON.stringify(data)).not.toMatch(/eu-central-1|secret|accessKey/i)
    expect(actions).toEqual([
      { at: '2026-10-20T10:00:00.000Z', text: 'Published the Home page', ok: true },
    ])
    expect(approvals).toEqual([{ id: 'ap1', text: 'Publish a page of your website' }])
    expect(data.backup).toBeNull()
    expect(backupsMock).not.toHaveBeenCalled()
  })

  it('the owner sees a failed nightly backup under Needs you; off an ee box there is nothing to show', async () => {
    kernelHolder.kernel = await kernel(['website'])
    roleMock.mockResolvedValue('owner')
    backupsMock.mockResolvedValueOnce({ health: { state: 'failed', at: 't', error: 'S3 PUT failed: 403 AccessDenied' }, runs: [] })
    const data = await loadDashboard('owner')
    expect(data.backup).toEqual({ kind: 'failed', text: 'The last backup failed: S3 PUT failed: 403 AccessDenied', href: '/settings/backups' })
    const { SubstrateUnavailableError } = await import('$lib/server/ee/client')
    backupsMock.mockRejectedValueOnce(new SubstrateUnavailableError('ENOENT'))
    expect((await loadDashboard('owner')).backup).toBeNull()
    roleMock.mockResolvedValue('admin')
  })

  it('the owner sees a rolled-back update under Needs you; an admin does not; off an ee box there is nothing to show', async () => {
    kernelHolder.kernel = await kernel(['website'])
    roleMock.mockResolvedValue('owner')
    backupsMock.mockResolvedValue({ health: { state: 'ok', lastSuccessAt: 't' }, runs: [] })
    upgradeMock.mockResolvedValueOnce({
      installed: null,
      managed: false,
      source: null,
      job: null,
      lastOutcome: { release: 'eigenenterprise-0.5.41-aaaaaaaaaaaa', from: null, step: 'rolling-back', ok: false, reason: 'the job queue stalled', rolledBack: true },
    })
    expect((await loadDashboard('owner')).update).toEqual({
      kind: 'rolled-back',
      text: 'The update to 0.5.41 was rolled back: the job queue stalled',
      href: '/settings/updates',
    })
    const { SubstrateUnavailableError } = await import('$lib/server/ee/client')
    upgradeMock.mockRejectedValueOnce(new SubstrateUnavailableError('ENOENT'))
    expect((await loadDashboard('owner')).update).toBeNull()
    roleMock.mockResolvedValue('admin')
    upgradeMock.mockClear()
    expect((await loadDashboard('admin')).update).toBeNull()
    expect(upgradeMock).not.toHaveBeenCalled()
    backupsMock.mockReset()
  })

  it('the owner gets the one-time product signals notice (what is shared, the switch) until they mark it seen; an admin never', async () => {
    kernelHolder.kernel = await kernel(['website'])
    roleMock.mockResolvedValue('admin')
    expect((await loadDashboard('admin')).signalsNotice).toBeNull()
    roleMock.mockResolvedValue('owner')
    backupsMock.mockResolvedValue({ health: { state: 'ok', lastSuccessAt: 't' }, runs: [] })
    upgradeMock.mockResolvedValue({ installed: null, managed: false, source: null, job: null, lastOutcome: null })
    expect((await loadDashboard('owner')).signalsNotice).toMatchObject({ href: '/settings/company', sentence: expect.stringMatching(/switch it off/) })
    const { liveTracesDeps } = await import('$lib/server/traces/live')
    await (await liveTracesDeps()).store.setNoticeSeen(new Date())
    expect((await loadDashboard('owner')).signalsNotice).toBeNull()
    roleMock.mockResolvedValue('admin')
    backupsMock.mockReset()
    upgradeMock.mockReset()
  })

  it('Needs you holds the tasks other members assigned to this person, and the news on the ones they assigned', async () => {
    kernelHolder.kernel = await kernel(['website'])
    const deps = taskDeps()
    const t = await assignTask(deps, { userId: 'owner', via: 'assistant' }, { assigneeId: 'ony', title: 'Send the Q4 deck', dueOn: '2026-11-21' })
    const ony = await loadDashboard('ony')
    expect(ony.tasks.assignedToMe).toMatchObject([{ title: 'Send the Q4 deck', dueOn: '2026-11-21', assigner: { name: 'Alex' } }])
    expect((await loadDashboard('owner')).tasks).toEqual({ assignedToMe: [], updates: [] })
    await completeTask(deps, { userId: 'ony', via: 'person' }, t.id)
    expect((await loadDashboard('owner')).tasks.updates).toMatchObject([{ title: 'Send the Q4 deck', update: { kind: 'completed' } }])
    expect((await loadDashboard('ony')).tasks.assignedToMe).toEqual([])
  })

  it('Needs you holds the person’s own due reminders — one item per reminder, never anyone else’s', async () => {
    kernelHolder.kernel = await kernel(['website'])
    const deps = reminderDeps()
    clock.now = new Date('2026-11-21T12:00:00Z')
    await createReminder(deps, { userId: 'ony', via: 'person' }, { title: 'LinkedIn posts', weekdays: ['MO', 'TH'], time: '09:00' })
    expect((await loadDashboard('ony')).reminders).toEqual([])
    clock.now = new Date('2026-11-27T10:00:00Z')
    expect((await loadDashboard('ony')).reminders).toMatchObject([{ title: 'LinkedIn posts', due: { oldestAt: '2026-11-23T08:00:00.000Z', count: 2 } }])
    expect((await loadDashboard('owner')).reminders).toEqual([])
  })

  it('Needs you holds an AI co-worker’s finished proactive work for the people it is for, until they acknowledge it (C6)', async () => {
    kernelHolder.kernel = await kernel(['website'])
    const run = await noticeRuns.enqueue({
      coworkerUserId: 'cw-mara',
      triggerKind: 'rhythm',
      conversationId: 'conv-marketing',
      threadRootId: null,
      triggerMessageId: null,
      requestedByUserId: 'owner',
      triggeredAt: new Date('2026-11-23T08:00:00Z'),
      rhythmId: null,
      taskId: null,
      triggerKey: 'rhythm:r1:2026-11-23T08:00:00.000Z',
    })
    await noticeRuns.update(run!.id, { status: 'done', threadRootId: 'post-1' })
    await noticeRuns.addNotices(run!.id, ['owner'], new Date('2026-11-23T08:01:00Z'))
    expect((await loadDashboard('owner')).coworkerNotices).toMatchObject([
      { coworker: { id: 'cw-mara', name: 'Mara' }, href: '/messages?c=conv-marketing&t=post-1', run: { triggerKind: 'rhythm', status: 'done' } },
    ])
    expect((await loadDashboard('ony')).coworkerNotices).toEqual([])
    await noticeRuns.markNoticeSeen(run!.id, 'owner', new Date())
    expect((await loadDashboard('owner')).coworkerNotices).toEqual([])
  })

  it('Needs you holds a decision question Jev was unsure about, for the person asked, until they answer it (CB2)', async () => {
    kernelHolder.kernel = await kernel(['website'])
    const unsure = vi.fn(async () => ({
      model: 'jev',
      answers: { decision: { choice: 'share', confidence: 0.55, distribution: { share: 0.55, keep: 0.45 } } },
      costUsd: 0.00001,
      durationMs: 1,
    }))
    const q = await decide(shareKind, { title: 'Q4 plan' }, { requestedBy: 'ony', judge: { none: true } }, { ask: unsure, store: decisionStore })
    expect((await loadDashboard('owner')).decisionQuestions).toEqual([
      {
        id: q.decisionId,
        kind: 'drive.share_file',
        title: 'Share it?',
        question: 'This looks shareable — share “Q4 plan”?',
        choices: [
          { choice: 'share', label: 'Share it' },
          { choice: 'keep', label: 'Keep it private' },
        ],
        askedAt: expect.any(String),
      },
    ])
    expect((await loadDashboard('ony')).decisionQuestions).toEqual([])
    await decisionPort.answer('owner', q.decisionId, 'keep')
    expect((await loadDashboard('owner')).decisionQuestions).toEqual([])
  })

  it("Needs you holds a failed company module for its owner and the admins, and the owner's sharing OK (U2)", async () => {
    kernelHolder.kernel = await kernel(['website'])
    companyModules.records = [
      {
        id: 'invoices',
        ownerUserId: 'ony',
        manifest: { name: 'Invoices' },
        state: 'failed',
        reason: 'Invoices is switched off because it stopped answering. Its data is kept.',
        stateSince: '2026-11-24T10:00:00.000Z',
        pendingDeploy: null,
      },
    ]
    companyModules.sharing = null
    roleMock.mockResolvedValueOnce('owner')
    const { SubstrateUnavailableError } = await import('$lib/server/ee/client')
    backupsMock.mockRejectedValueOnce(new SubstrateUnavailableError('ENOENT'))
    expect((await loadDashboard('owner')).moduleNotices).toEqual([
      {
        kind: 'module_failed',
        moduleId: 'invoices',
        name: 'Invoices',
        sentence: 'Invoices is switched off because it stopped answering. Its data is kept.',
        since: '2026-11-24T10:00:00.000Z',
      },
      { kind: 'module_sharing', sentence: 'Modules you build here are open source (Apache-2.0) and shared with eigenEnterprise.' },
    ])
    roleMock.mockResolvedValueOnce('member')
    expect((await loadDashboard('someone')).moduleNotices).toEqual([])
    roleMock.mockResolvedValueOnce('member')
    expect((await loadDashboard('ony')).moduleNotices).toHaveLength(1)
    companyModules.records = []
  })
})
