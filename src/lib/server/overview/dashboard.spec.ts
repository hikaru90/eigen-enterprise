import { describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryActivationStore } from '$lib/kernel/modules'

const { kernelHolder, roleMock, backupsMock, eventRows, journeyRows, assignedTasks, reminders, notices } = vi.hoisted(() => ({
  assignedTasks: { deps: null as unknown },
  notices: { deps: null as unknown },
  reminders: { deps: null as unknown },
  kernelHolder: { kernel: null as unknown },
  roleMock: vi.fn(async (): Promise<string> => 'admin'),
  backupsMock: vi.fn(),
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

import { MemoryCoworkerRunStore } from '$lib/server/coworkers/run-store'
import { memoryAssignedTaskStore } from '$lib/server/memory/assigned-tasks/memory-store'
import { assignTask, completeTask, type AssignedTaskDeps } from '$lib/server/memory/assigned-tasks/service'
import { memoryReminderStore } from '$lib/server/memory/reminders/memory-store'
import { createReminder, type ReminderDeps } from '$lib/server/memory/reminders/service'
import { loadDashboard } from './dashboard'

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
})
