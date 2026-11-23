import type { DemoPorts } from './tools'
import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { northwind } from './data/dataset'
import { DEMO_MODULE_ID, DEMO_SEED_TOOL, DEMO_STATUS_TOOL } from './manifest'
import { SEED_MODULES } from './runner'
import { createDemoTools } from './tools'

const OWNER_ID = 'u-owner'
const ADMIN_ID = 'u-admin'

/** A registry that answers the seed's reads and ids; every call is recorded. */
function fakeRegistry(roster: { members: { id: string; email: string; role: string }[]; invites: { email: string }[] }) {
  const calls: { tool: string; as: string; kind: string }[] = []
  let n = 0
  return {
    calls,
    registry: {
      async execute(tool: string, _input: unknown, ctx: ToolContext) {
        calls.push({ tool, as: ctx.principal.id, kind: ctx.principal.kind })
        const id = `${tool}-${++n}`
        switch (tool) {
          case 'members.list':
            return roster
          case 'kernel.module_list':
            return SEED_MODULES.map((id) => ({ id, active: true }))
          case 'memory.create_project':
            return { entityId: id }
          case 'memory.create_task':
            return { task: { id } }
          case 'messages.create_channel':
            return { conversation: { id } }
          case 'drive.create_folder':
            return { folder: { id } }
          case 'drive.create_document':
            return { file: { id } }
          default:
            return { id }
        }
      },
    },
  }
}

const FRESH = { members: [{ id: OWNER_ID, email: 'founder@box.test', role: 'owner' }], invites: [] }

function ports(): DemoPorts & { added: string[] } {
  const added: string[] = []
  return {
    added,
    roleOf: async (id) => (id === OWNER_ID ? 'owner' : id === ADMIN_ID ? 'admin' : null),
    personOf: async (id) => ({ id, roles: ['admin', 'member'] }),
    addTeammate: async (_owner, t) => {
      added.push(t.handle)
      return { id: `u-${t.handle}`, roles: ['member'] }
    },
  }
}

function tools(roster = FRESH) {
  const { registry, calls } = fakeRegistry(roster)
  const p = ports()
  const list = createDemoTools({
    registry: () => registry,
    ports: async () => p,
    now: () => new Date('2026-11-25T09:00:00Z'),
    log: () => {},
  })
  const by = Object.fromEntries(list.map((t) => [t.name, t]))
  return { by, calls, ports: p }
}

const as = (id: string, kind: 'human' | 'agent' = 'human'): ToolContext => ({
  principal: { id, kind, roles: kind === 'agent' ? ['admin', 'agent'] : ['admin', 'member'] },
  requestId: 'r1',
})

describe('demo tools', () => {
  it('declares a gated, audited seed and a read-only status in the demo module', () => {
    const { by } = tools()
    expect(by[DEMO_SEED_TOOL]).toMatchObject({
      module: DEMO_MODULE_ID,
      auditClass: 'mutate',
      approvalRisk: 'public',
      permission: { roles: ['admin', 'agent'] },
    })
    expect(by[DEMO_SEED_TOOL]!.activity!({}, undefined)).toBe('Seeded the demo company Northwind Studio')
    expect(by[DEMO_STATUS_TOOL]).toMatchObject({ module: DEMO_MODULE_ID, auditClass: 'read' })
  })

  it('seed_company is the owner’s: an admin is refused before anything is read or written', async () => {
    const { by, calls, ports: p } = tools()
    await expect(by[DEMO_SEED_TOOL]!.handler(as(ADMIN_ID), {})).rejects.toMatchObject({
      code: 'permission_denied',
    })
    await expect(by[DEMO_SEED_TOOL]!.handler(as('u-stranger'), {})).rejects.toBeInstanceOf(KernelError)
    expect(calls).toEqual([])
    expect(p.added).toEqual([])
  })

  it('seeds as the owner: every call runs as a person (the owner, or the teammate), never as the calling agent', async () => {
    const { by, calls, ports: p } = tools()
    // The owner's own MCP key arrives as an agent principal carrying the owner's id.
    const out = (await by[DEMO_SEED_TOOL]!.handler(as(OWNER_ID, 'agent'), {})) as Record<string, unknown>
    expect(out).toMatchObject({ seeded: 'Northwind Studio', teammates: 5, messages: northwind.messages.length })
    expect(p.added).toEqual(['lena', 'jonas', 'mira', 'tarek', 'sophie'])
    expect(calls.length).toBeGreaterThan(100)
    expect(calls.every((c) => c.kind === 'human')).toBe(true)
    expect(new Set(calls.map((c) => c.as))).toEqual(
      new Set([OWNER_ID, 'u-lena', 'u-jonas', 'u-mira', 'u-tarek', 'u-sophie']),
    )
  })

  it('refuses an already-seeded company and one that is not freshly claimed, writing nothing', async () => {
    const seeded = tools({
      members: [...FRESH.members, { id: 'u-lena', email: 'lena.hoffmann@northwind-studio.example', role: 'admin' }],
      invites: [],
    })
    await expect(seeded.by[DEMO_SEED_TOOL]!.handler(as(OWNER_ID), {})).rejects.toThrow(/already seeded/)
    expect(seeded.calls.map((c) => c.tool)).toEqual(['members.list'])

    const busy = tools({ members: FRESH.members, invites: [{ email: 'someone@else.test' }] })
    await expect(busy.by[DEMO_SEED_TOOL]!.handler(as(OWNER_ID), {})).rejects.toThrow(/not empty/)
    expect(busy.calls.map((c) => c.tool)).toEqual(['members.list'])
    expect(busy.ports.added).toEqual([])
  })

  it('status says whether the company is seeded and whether it can be, read as the caller', async () => {
    const fresh = tools()
    expect(await fresh.by[DEMO_STATUS_TOOL]!.handler(as(ADMIN_ID), {})).toEqual({
      company: 'Northwind Studio',
      seeded: false,
      seeded_members: [],
      members: 1,
      open_invites: 0,
      can_seed: true,
    })
    expect(fresh.calls).toEqual([{ tool: 'members.list', as: ADMIN_ID, kind: 'human' }])

    const seeded = tools({
      members: [...FRESH.members, { id: 'u-lena', email: 'lena.hoffmann@northwind-studio.example', role: 'admin' }],
      invites: [],
    })
    expect(await seeded.by[DEMO_STATUS_TOOL]!.handler(as(OWNER_ID), {})).toMatchObject({
      seeded: true,
      seeded_members: ['lena.hoffmann@northwind-studio.example'],
      can_seed: false,
    })
  })

  it('takes no input', () => {
    const { by } = tools()
    expect(by[DEMO_SEED_TOOL]!.inputSchema.safeParse({ force: true }).success).toBe(false)
    expect(by[DEMO_STATUS_TOOL]!.inputSchema.safeParse({}).success).toBe(true)
  })
})
