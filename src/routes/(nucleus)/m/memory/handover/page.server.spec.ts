import { describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { memoryHandoverStore } from '$lib/server/memory/handover/memory-store'
import type { HandoverDeps, HandoverView } from '$lib/server/memory/handover/service'

const { holder, executed } = vi.hoisted(() => ({
  holder: { deps: null as unknown },
  executed: [] as Array<{ name: string; input: unknown; ctx: { principal: { id: string; kind: string; roles: string[] } } }>,
}))

vi.mock('$lib/server/memory/handover/live', () => ({ handoverDeps: async () => holder.deps }))
vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: async (id: string) => (id === 'stranger' ? null : 'member'),
  kernelRolesFor: () => ['member'],
}))
// The registry, reduced to what this page needs: the real handover.* tools, the person as the writer.
vi.mock('$lib/server/boot', async () => {
  const { createHandoverTools } = await import('../../../../../../modules/memory/handover-tools')
  const tools = createHandoverTools({
    deps: async () => holder.deps as HandoverDeps,
    writerOf: async (ctx: ToolContext) => ({ kind: 'self', userId: ctx.principal.id }),
  })
  return {
    appKernel: async () => ({
      registry: {
        async execute(name: string, input: unknown, ctx: ToolContext) {
          const tool = tools.find((t) => t.name === name)!
          const parsed = tool.inputSchema.safeParse(input)
          if (!parsed.success) throw new KernelError('invalid_input', `invalid input for tool ${name}`)
          executed.push({ name, input: parsed.data, ctx: ctx as (typeof executed)[number]['ctx'] })
          return tool.handler(ctx, parsed.data)
        },
      },
    }),
  }
})

import { actions, load } from './+page.server'

const people = [
  { id: 'ony', name: 'Ony', email: 'ony@k.co' },
  { id: 'alex', name: 'Alex', email: 'alex@k.co' },
]

function setup() {
  const assign = vi.fn(async () => ({ id: 'task-1' }))
  const deps: HandoverDeps = {
    store: memoryHandoverStore(),
    directory: { get: async (id) => people.find((p) => p.id === id) ?? null, list: async () => people },
    tasks: { assign, status: async () => 'open' as const },
    now: () => new Date('2026-11-25T09:00:00Z'),
  }
  holder.deps = deps
  executed.length = 0
  return { deps, assign }
}

const as = (id: string) => ({ locals: { user: { id, name: id } } as unknown as App.Locals })
const post = (id: string, fields: Record<string, string>) => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  return { ...as(id), request: new Request('http://x/m/memory/handover', { method: 'POST', body: form }) }
}
type Ev = Parameters<typeof load>[0]
type ActEv = Parameters<(typeof actions)['create']>[0]
type ActOut = { formId?: string; ok?: true; status?: number; data?: { formId: string; error: string; agent: { tool?: string } } }
const act = (name: keyof typeof actions, id: string, fields: Record<string, string>) => actions[name](post(id, fields) as unknown as ActEv) as Promise<ActOut>
const loaded = async (id: string) =>
  (await load(as(id) as unknown as Ev)) as { handovers: HandoverView[]; members: Array<{ id: string; name: string }>; userId: string }

describe('Memory › Handover page', () => {
  it('creates through handover.create as the signed-in person; a colleague reads it but cannot edit', async () => {
    setup()
    expect(await act('create', 'ony', { title: 'Handover to Alex', subject_id: 'alex' })).toMatchObject({ formId: 'new', ok: true })
    expect(executed[0]).toMatchObject({ name: 'handover.create', input: { title: 'Handover to Alex', subject_id: 'alex' }, ctx: { principal: { id: 'ony', kind: 'human' } } })
    const alexView = await loaded('alex')
    expect(alexView.handovers).toEqual([expect.objectContaining({ title: 'Handover to Alex', canEdit: false })])
    expect(alexView.members.map((m) => m.id)).toEqual(['ony', 'alex'])
  })

  it('a topic handover leaves the subject out', async () => {
    setup()
    await act('create', 'ony', { title: 'Grants', subject_id: '' })
    expect(executed[0]!.input).toEqual({ title: 'Grants' })
  })

  it('the owner adds, edits, assigns and removes entries through the handover.* tools', async () => {
    const { assign } = setup()
    await act('create', 'ony', { title: 'Handover to Alex' })
    const [h] = (await loaded('ony')).handovers
    expect(await act('add', 'ony', { handover_id: h!.id, topic: 'Office lease', sentence: 'Two options.', status: 'decision_needed', link: '' })).toMatchObject({ ok: true })
    const entry = (await loaded('ony')).handovers[0]!.entries[0]!
    expect(entry).toMatchObject({ topic: 'Office lease', link: null })
    await act('update', 'ony', { entry_id: entry.id, topic: 'Office lease', sentence: 'Option B.', status: 'in_progress', link: '/m/drive/file/abc' })
    expect((await loaded('ony')).handovers[0]!.entries[0]).toMatchObject({ sentence: 'Option B.', status: 'in_progress', link: '/m/drive/file/abc' })
    await act('assign', 'ony', { entry_id: entry.id, assignee_id: 'alex' })
    expect(assign).toHaveBeenCalledWith({ userId: 'ony', via: 'person' }, expect.objectContaining({ assigneeId: 'alex' }))
    await act('remove', 'ony', { entry_id: entry.id })
    expect((await loaded('ony')).handovers[0]!.entries).toEqual([])
    expect(executed.map((e) => e.name)).toEqual(['handover.create', 'handover.add_entry', 'handover.update_entry', 'handover.assign_entry', 'handover.remove_entry'])
  })

  it('a colleague’s edit is refused with a report naming the tool, for that entry', async () => {
    setup()
    await act('create', 'ony', { title: 'H' })
    const [h] = (await loaded('ony')).handovers
    await act('add', 'ony', { handover_id: h!.id, topic: 'T', sentence: 'S.', status: 'for_info' })
    const entry = (await loaded('ony')).handovers[0]!.entries[0]!
    const out = await act('update', 'alex', { entry_id: entry.id, topic: 'T', sentence: 'X.', status: 'for_info', link: '' })
    expect(out).toMatchObject({ status: 403, data: { formId: entry.id, agent: { tool: 'handover.update_entry' } } })
  })

  it('one entry per topic: a second one on the same topic is a 409 on the add form', async () => {
    setup()
    await act('create', 'ony', { title: 'H' })
    const [h] = (await loaded('ony')).handovers
    await act('add', 'ony', { handover_id: h!.id, topic: 'T', sentence: 'S.', status: 'for_info' })
    expect(await act('add', 'ony', { handover_id: h!.id, topic: 't', sentence: 'S.', status: 'for_info' })).toMatchObject({ status: 409, data: { formId: `add-${h!.id}` } })
  })

  it('the owner deletes a whole handover through handover.delete (Contribute 8587d182); a colleague cannot', async () => {
    setup()
    await act('create', 'ony', { title: 'Mistake' })
    const [h] = (await loaded('ony')).handovers
    const out = await act('remove_handover', 'alex', { handover_id: h!.id })
    expect(out).toMatchObject({ status: 403, data: { formId: h!.id, agent: { tool: 'handover.delete' } } })
    expect(await act('remove_handover', 'ony', { handover_id: h!.id })).toMatchObject({ formId: h!.id, ok: true })
    expect((await loaded('ony')).handovers).toEqual([])
    expect(executed.at(-1)).toMatchObject({ name: 'handover.delete', input: { handover_id: h!.id } })
  })

  it('someone who is no member of the company is refused', async () => {
    setup()
    expect(await act('create', 'stranger', { title: 'X' })).toMatchObject({ status: 403 })
    await expect(load(as('stranger') as unknown as Ev)).rejects.toMatchObject({ status: 403 })
  })
})
