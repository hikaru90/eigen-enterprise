import type { WiredKernel } from '../../../../../modules/index'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  type ApprovalRequest,
  type ApprovalStatus,
} from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { buildKernel, ensureSystemModulesActive } from '../../../../../modules/index'

vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))

const { roleMock, holder } = vi.hoisted(() => ({
  roleMock: vi.fn(async (_id: string): Promise<string | null> => 'owner'),
  holder: { kernel: null as unknown },
}))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))
vi.mock('$lib/server/boot', () => ({ appKernel: async () => holder.kernel }))

import { actions, load } from './+page.server'

/** An approval store that can list by status (what kernel.approvals_list needs). */
class ListableApprovals extends InMemoryApprovalStore {
  private readonly all: ApprovalRequest[] = []
  override async create(req: ApprovalRequest) {
    this.all.push(req)
    return super.create(req)
  }
  override async decide(id: string, status: 'approved' | 'denied', decidedBy: string) {
    const decided = await super.decide(id, status, decidedBy)
    this.all.splice(this.all.findIndex((r) => r.id === id), 1, decided)
    return decided
  }
  async list(status?: ApprovalStatus) {
    return this.all.filter((r) => status === undefined || r.status === status)
  }
}

let eventSink: InMemoryEventSink
let activations: InMemoryActivationStore
let approvals: ListableApprovals

async function freshKernel(): Promise<WiredKernel> {
  eventSink = new InMemoryEventSink()
  activations = new InMemoryActivationStore()
  approvals = new ListableApprovals()
  const kernel = buildKernel({
    activations,
    eventSink,
    approvalStore: approvals,
    // The company default: an owner's switch-off still passes the approval gate, as their own click.
    approvalMode: new InMemoryApprovalModeStore('ask'),
    vcsCommitter: null,
  })
  await registerAdminTools(kernel, { approvals })
  await ensureSystemModulesActive(kernel)
  return kernel
}

const ev = (form: Record<string, string> = {}, user: { id: string } | null = { id: 'u-owner' }) => {
  const body = new FormData()
  for (const [k, v] of Object.entries(form)) body.set(k, v)
  return {
    locals: { user },
    request: new Request('http://x/settings/modules', { method: 'POST', body }),
  } as never
}

type Plugin = {
  id: string
  name: string
  origin: string
  active: boolean
  description: string | null
  tools: string[]
  requires: { id: string; name: string; active: boolean }[]
  requiredBy: { id: string; name: string; active: boolean }[]
}
type Data = { plugins: Plugin[]; core: { id: string; name: string }[] }

const loaded = async () => (await load(ev() as never)) as unknown as Data
const plugin = (data: Data, id: string) => data.plugins.find((p) => p.id === id)!
const toolRuns = (name: string) =>
  eventSink.events.filter((e) => e.type === 'tool.executed' && (e.payload as { tool?: string }).tool === name)

describe('Settings → Plugins (owner and admins)', () => {
  beforeEach(async () => {
    roleMock.mockResolvedValue('owner')
    holder.kernel = await freshKernel()
  })

  it('sends signed-out visitors to sign in', async () => {
    await expect(load(ev({}, null) as never)).rejects.toMatchObject({ status: 302, location: '/login' })
  })

  it.each(['member', null])('a %s gets 403 — the page and both switches, changing nothing', async (role) => {
    roleMock.mockResolvedValue(role)
    await expect(load(ev() as never)).rejects.toMatchObject({ status: 403 })
    await expect(actions.deactivate!(ev({ module_id: 'email' }))).rejects.toMatchObject({ status: 403 })
    await expect(actions.activate!(ev({ module_id: 'email' }))).rejects.toMatchObject({ status: 403 })
    expect(await activations.get('email')).toBe(true)
  })

  it.each(['owner', 'admin'])('an %s sees every plugin with a sidebar entry, and the core as one line', async (role) => {
    roleMock.mockResolvedValue(role)
    const data = await loaded()
    expect(data.plugins.map((p) => p.id).sort()).toEqual(
      ['brand', 'calendar', 'calls', 'contacts', 'drive', 'email', 'memory', 'messages', 'repos', 'website'].sort(),
    )
    expect(data.core.map((c) => c.id).sort()).toEqual(['contribute', 'kernel', 'members', 'orchestrator'])
  })

  it('the central Contribute board is in the core line only where the owner switched it on', async () => {
    roleMock.mockResolvedValue('owner')
    expect((await loaded()).core.map((c) => c.id)).not.toContain('contribute-hub')
    await activations.set('contribute-hub', true)
    expect((await loaded()).core.map((c) => c.id)).toContain('contribute-hub')
  })

  it('describes each plugin: official, on or off, its tools, who needs whom', async () => {
    const data = await loaded()
    expect(plugin(data, 'email')).toMatchObject({
      name: 'Email',
      origin: 'official',
      active: true,
      requires: [],
      requiredBy: [],
    })
    expect(plugin(data, 'email').description).toMatch(/email/i)
    expect(plugin(data, 'email').tools).toContain('email.send_mail')
    expect(plugin(data, 'calls').requires).toEqual([{ id: 'messages', name: 'Messages', active: true }])
    expect(plugin(data, 'messages').requiredBy).toEqual([{ id: 'calls', name: 'Calls', active: true }])
  })

  it('switching off goes through the kernel registry: the owner’s click is the approval, audited', async () => {
    await expect(actions.deactivate!(ev({ module_id: 'email' }))).resolves.toEqual({
      action: 'deactivate',
      moduleId: 'email',
      ok: true,
    })
    expect(await activations.get('email')).toBe(false)
    expect(await approvals.list('approved')).toMatchObject([
      { toolName: 'kernel.module_deactivate', principalId: 'u-owner', decidedBy: 'u-owner' },
    ])
    expect(toolRuns('kernel.module_deactivate')).toHaveLength(1)
    expect(plugin(await loaded(), 'email').active).toBe(false)
  })

  it('switching on goes through the kernel registry, audited', async () => {
    await actions.deactivate!(ev({ module_id: 'drive' }))
    await expect(actions.activate!(ev({ module_id: 'drive' }))).resolves.toEqual({
      action: 'activate',
      moduleId: 'drive',
      ok: true,
    })
    expect(await activations.get('drive')).toBe(true)
    expect(toolRuns('kernel.module_activate')).toHaveLength(1)
  })

  it('a plugin another one needs is refused with the kernel’s reason, and stays on', async () => {
    const result = await actions.deactivate!(ev({ module_id: 'messages' }))
    expect(result).toMatchObject({
      status: 409,
      data: { action: 'deactivate', moduleId: 'messages', error: 'Calls needs Messages: switch off Calls first.' },
    })
    expect(await activations.get('messages')).toBe(true)
  })

  it('switching on a plugin whose requirement is off is refused with the kernel’s reason', async () => {
    await actions.deactivate!(ev({ module_id: 'calls' }))
    await actions.deactivate!(ev({ module_id: 'messages' }))
    const result = await actions.activate!(ev({ module_id: 'calls' }))
    expect(result).toMatchObject({
      status: 409,
      data: { action: 'activate', moduleId: 'calls', error: 'Calls needs Messages: switch on Messages first.' },
    })
    expect(await activations.get('calls')).toBe(false)
  })

  it('the core refuses through the same path, in the kernel’s words', async () => {
    const result = await actions.deactivate!(ev({ module_id: 'members' }))
    expect(result).toMatchObject({
      status: 409,
      data: { moduleId: 'members', error: 'Members is part of the eigenEnterprise core and cannot be switched off.' },
    })
    expect(await activations.get('members')).toBe(true)
  })

  it('shows an unknown module or a missing id as the error it is', async () => {
    expect(await actions.deactivate!(ev({ module_id: 'ghost' }))).toMatchObject({
      status: 404,
      data: { moduleId: 'ghost', error: 'unknown module: ghost' },
    })
    expect(await actions.activate!(ev({}))).toMatchObject({
      status: 400,
      data: { action: 'activate', moduleId: null, error: 'Choose a plugin.' },
    })
  })
})
