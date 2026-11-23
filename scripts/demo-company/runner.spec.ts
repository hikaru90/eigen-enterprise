import type { Teammate } from './types'
import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { northwind } from './dataset'
import { AlreadySeededError, seedDemoCompany, type SeedDeps } from './runner'

type Call = { tool: string; as: string; input: Record<string, unknown> }

const OWNER_ID = 'u-owner'
const NOW = new Date('2026-11-25T09:00:00Z') // a Wednesday

/** A fake registry: records every call and answers with the ids the real tools return. */
function fakeRegistry(
  opts: {
    members?: { id: string; email: string; role: string }[]
    gate?: Set<string>
    inactive?: string[]
  } = {},
) {
  const calls: Call[] = []
  let n = 0
  const pendingFor = new Map<string, string>()
  const approved = new Set<string>()
  const registry: SeedDeps['registry'] = {
    async execute(tool: string, input: unknown, ctx: ToolContext) {
      const i = input as Record<string, unknown>
      calls.push({ tool, as: ctx.principal.id, input: i })
      const key = `${tool}|${ctx.principal.id}`
      if (opts.gate?.has(tool) && !approved.has(key)) {
        const id = `appr-${++n}`
        pendingFor.set(id, key)
        throw new KernelError('approval_required', `tool ${tool} requires approval`, {
          approvalId: id,
          tool,
        })
      }
      const id = `${tool}-${++n}`
      switch (tool) {
        case 'members.list':
          return {
            members: opts.members ?? [{ id: OWNER_ID, email: 'founder@box.test', role: 'owner' }],
            invites: [],
          }
        case 'kernel.module_list':
          return [
            'members',
            'contacts',
            'memory',
            'messages',
            'calendar',
            'drive',
            'brand',
            'website',
          ].map((m) => ({
            id: m,
            active: !(opts.inactive ?? []).includes(m),
          }))
        case 'kernel.approvals_decide': {
          const k = pendingFor.get(String(i.approval_id))
          if (k) approved.add(k)
          return { id: i.approval_id, status: 'approved' }
        }
        case 'memory.create_project':
          return { entityId: id }
        case 'memory.create_task':
          return { task: { id } }
        case 'messages.create_channel':
          return { conversation: { id } }
        case 'contacts.create':
        case 'tasks.assign':
        case 'brand.set_create':
        case 'memory.create_text_file':
          return { id }
        case 'drive.create_folder':
          return { folder: { id } }
        case 'drive.create_document':
          return { file: { id } }
        default:
          return {}
      }
    },
  }
  return { registry, calls }
}

function deps(registry: SeedDeps['registry']) {
  const added: Teammate[] = []
  const d: SeedDeps = {
    registry,
    owner: { id: OWNER_ID, roles: ['admin', 'member'] },
    addTeammate: async (t) => {
      added.push(t)
      return { id: `u-${t.handle}`, roles: t.role === 'admin' ? ['admin', 'member'] : ['member'] }
    },
    now: NOW,
    log: () => {},
  }
  return { d, added }
}

/** The tools in call order with consecutive repeats folded: the seed's phases. */
const phases = (calls: Call[]) => calls.map((c) => c.tool).filter((t, i, all) => t !== all[i - 1])

describe('seedDemoCompany', () => {
  it('drives the registry tools in order, each as the right person', async () => {
    const { registry, calls } = fakeRegistry()
    const { d, added } = deps(registry)
    const counts = await seedDemoCompany(northwind, d)

    expect(added.map((t) => t.handle)).toEqual(['lena', 'jonas', 'mira', 'tarek', 'sophie'])
    const order = phases(calls)
    const first = (tool: string) => order.indexOf(tool)
    expect(order[0]).toBe('kernel.module_list')
    expect(order[1]).toBe('members.list')
    const sequence = [
      'settings.update',
      'members.set_my_name',
      'members.group_create',
      'contacts.set_company_default_visibility',
      'contacts.create',
      'memory.create_project',
      'messages.create_channel',
      'calendar.create_event',
      'drive.create_folder',
      'brand.set_create',
      'website.create_page',
      'memory.create_text_file',
    ]
    const positions = sequence.map(first)
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)

    // Each message is posted by its author; each teammate names themselves.
    const posts = calls.filter((c) => c.tool === 'messages.post')
    expect(posts).toHaveLength(northwind.messages.length)
    expect(posts.map((p) => p.as)).toEqual(
      northwind.messages.map((m) => (m.author === 'owner' ? OWNER_ID : `u-${m.author}`)),
    )
    expect(calls.filter((c) => c.tool === 'members.set_my_name').map((c) => c.as)).toEqual(
      added.map((t) => `u-${t.handle}`),
    )

    // A task for the lead goes into the lead's project; a task for someone else is assigned by the lead.
    const assigned = calls.filter((c) => c.tool === 'tasks.assign')
    expect(assigned.every((c) => c.as !== c.input.assignee_id)).toBe(true)
    const own = calls.filter((c) => c.tool === 'memory.create_task')
    expect(own.every((c) => typeof c.input.project_entity_id === 'string')).toBe(true)
    expect(assigned.length + own.length).toBe(northwind.projects.flatMap((p) => p.tasks).length)
    const done = northwind.projects.flatMap((p) => p.tasks).filter((t) => t.done).length
    expect(
      calls.filter((c) => c.tool === 'tasks.complete' || c.tool === 'memory.complete_task'),
    ).toHaveLength(done)

    // Dates are relative to the run: the first studio meeting is this Monday, Hamburg time.
    const meeting = calls.find((c) => c.tool === 'calendar.create_event')!
    expect(meeting.input).toMatchObject({
      start: '2026-11-23T09:30',
      end: '2026-11-23T10:15',
      time_zone: 'Europe/Berlin',
    })
    const firstLog = calls.find((c) => c.tool === 'contacts.log_contact')!
    expect(firstLog.input.on).toBe('2026-11-01') // 24 days before the run day

    expect(counts).toMatchObject({
      teammates: 5,
      contacts: northwind.contacts.length,
      projects: 4,
      tasks: northwind.projects.flatMap((p) => p.tasks).length,
      channels: northwind.channels.length,
      messages: northwind.messages.length,
      events: northwind.events.length,
      docs: northwind.docs.length,
      pages: northwind.pages.length,
      memories: northwind.memories.length,
    })
  })

  it('has the owner approve a gated call (the approval mode applies) and retries it once', async () => {
    const { registry, calls } = fakeRegistry({ gate: new Set(['contacts.create']) })
    const { d } = deps(registry)
    await seedDemoCompany(northwind, d)
    const decisions = calls.filter((c) => c.tool === 'kernel.approvals_decide')
    expect(decisions.length).toBeGreaterThan(0)
    expect(decisions.every((c) => c.as === OWNER_ID && c.input.decision === 'approved')).toBe(true)
    // One approval per person who creates contacts; afterwards their calls pass.
    const creators = new Set(northwind.contacts.map((c) => c.owner))
    expect(decisions).toHaveLength(creators.size)
  })

  it('activates a module that is switched off before using it', async () => {
    const { registry, calls } = fakeRegistry({ inactive: ['calendar'] })
    const { d } = deps(registry)
    await seedDemoCompany(northwind, d)
    expect(calls.find((c) => c.tool === 'kernel.module_activate')?.input).toEqual({
      module_id: 'calendar',
    })
  })

  it('fails loud on a company that is already seeded, and writes nothing', async () => {
    const { registry, calls } = fakeRegistry({
      members: [
        { id: OWNER_ID, email: 'founder@box.test', role: 'owner' },
        { id: 'u-lena', email: 'lena.hoffmann@northwind-studio.example', role: 'admin' },
      ],
    })
    const { d, added } = deps(registry)
    await expect(seedDemoCompany(northwind, d)).rejects.toThrow(AlreadySeededError)
    await expect(seedDemoCompany(northwind, d)).rejects.toThrow(/already seeded/)
    expect(calls.every((c) => c.tool === 'kernel.module_list' || c.tool === 'members.list')).toBe(
      true,
    )
    expect(added).toEqual([])
  })

  it('refuses a company that already has other members', async () => {
    const { registry, calls } = fakeRegistry({
      members: [
        { id: OWNER_ID, email: 'founder@box.test', role: 'owner' },
        { id: 'u-x', email: 'someone@else.test', role: 'member' },
      ],
    })
    const { d } = deps(registry)
    await expect(seedDemoCompany(northwind, d)).rejects.toThrow(/not empty/)
    expect(calls.every((c) => c.tool === 'kernel.module_list' || c.tool === 'members.list')).toBe(
      true,
    )
  })

  it('refuses an invalid dataset before calling anything', async () => {
    const { registry, calls } = fakeRegistry()
    const { d } = deps(registry)
    const broken = structuredClone(northwind)
    broken.messages[0]!.author = 'ghost'
    await expect(seedDemoCompany(broken, d)).rejects.toThrow(/unknown author "ghost"/)
    expect(calls).toEqual([])
  })
})
