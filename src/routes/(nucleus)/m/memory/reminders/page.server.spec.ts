import { describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import type { ToolContext } from '$lib/kernel/types'
import { memoryReminderStore } from '$lib/server/memory/reminders/memory-store'
import type { ReminderDeps, ReminderView } from '$lib/server/memory/reminders/service'

const { holder, executed } = vi.hoisted(() => ({
  holder: { deps: null as unknown, now: new Date('2026-11-21T12:00:00Z') },
  executed: [] as Array<{
    name: string
    ctx: { principal: { id: string; kind: string; roles: string[] } }
  }>,
}))

vi.mock('$lib/server/memory/reminders/live', () => ({ reminderDeps: async () => holder.deps }))
vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: async (id: string) => (id === 'stranger' ? null : 'member'),
  kernelRolesFor: () => ['member'],
}))
// The registry, reduced to what this page needs: the real reminders.* tools, the person as the writer.
vi.mock('$lib/server/boot', async () => {
  const { createReminderTools } = await import('../../../../../../modules/memory/reminder-tools')
  const tools = createReminderTools({
    deps: async () => holder.deps as ReminderDeps,
    writerOf: async (ctx: ToolContext) => ({ kind: 'self', userId: ctx.principal.id }),
  })
  return {
    appKernel: async () => ({
      registry: {
        async execute(name: string, input: unknown, ctx: ToolContext) {
          const tool = tools.find((t) => t.name === name)!
          const parsed = tool.inputSchema.safeParse(input)
          if (!parsed.success)
            throw new KernelError('invalid_input', `invalid input for tool ${name}`)
          executed.push({ name, ctx: ctx as (typeof executed)[number]['ctx'] })
          return tool.handler(ctx, parsed.data)
        },
      },
    }),
  }
})

import { actions, load } from './+page.server'

function setup() {
  holder.now = new Date('2026-11-21T12:00:00Z')
  const deps: ReminderDeps = {
    store: memoryReminderStore(),
    timeZoneOf: async () => 'Europe/Berlin',
    now: () => holder.now,
  }
  holder.deps = deps
  executed.length = 0
  return deps
}

const as = (id: string) => ({ locals: { user: { id, name: id } } as unknown as App.Locals })
const post = (id: string, fields: Record<string, string | string[]>) => {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) form.append(k, one)
  return {
    ...as(id),
    request: new Request('http://x/m/memory/reminders', { method: 'POST', body: form }),
  }
}
type Ev = Parameters<typeof load>[0]
type ActEv = Parameters<(typeof actions)['create']>[0]
const act = (name: keyof typeof actions, id: string, fields: Record<string, string | string[]>) =>
  actions[name](post(id, fields) as unknown as ActEv) as Promise<{
    reminderId?: string
    ok?: true
    status?: number
    data?: { error: string; agent: { attempted: string; tool?: string; input?: unknown } }
  }>
const loaded = async (id: string) =>
  (await load(as(id) as unknown as Ev)) as { reminders: ReminderView[]; timeZone: string }

describe('Memory › Reminders page', () => {
  it('creates through the reminders.create tool as the signed-in person, and lists only theirs', async () => {
    setup()
    expect(
      await act('create', 'ony', {
        title: 'LinkedIn posts',
        note: '',
        weekdays: ['MO', 'TH'],
        time: '09:00',
        time_zone: '',
      }),
    ).toEqual({ reminderId: 'new', ok: true })
    expect(executed).toMatchObject([
      {
        name: 'reminders.create',
        ctx: { principal: { id: 'ony', kind: 'human', roles: ['member'] } },
      },
    ])
    const data = await loaded('ony')
    expect(data.timeZone).toBe('Europe/Berlin')
    expect(data.reminders).toMatchObject([
      {
        title: 'LinkedIn posts',
        weekdays: ['MO', 'TH'],
        time: '09:00',
        timeZone: 'Europe/Berlin',
        createdVia: 'person',
      },
    ])
    expect((await loaded('alex')).reminders).toEqual([])
  })

  it('ticks off, snoozes, pauses, resumes, edits and deletes; refusals come back as messages', async () => {
    setup()
    await act('create', 'ony', { title: 'LinkedIn posts', weekdays: ['MO', 'TH'], time: '09:00' })
    const [r] = (await loaded('ony')).reminders
    holder.now = new Date('2026-11-27T10:00:00Z')
    expect(await act('complete', 'ony', { reminder_id: r.id })).toEqual({
      reminderId: r.id,
      ok: true,
    })
    expect((await loaded('ony')).reminders[0].due?.count).toBe(1)
    expect(await act('snooze', 'ony', { reminder_id: r.id, minutes: '60' })).toEqual({
      reminderId: r.id,
      ok: true,
    })
    expect(await act('complete', 'ony', { reminder_id: r.id, all: '1' })).toEqual({
      reminderId: r.id,
      ok: true,
    })
    const nothing = await act('complete', 'ony', { reminder_id: r.id })
    expect(nothing.status).toBe(409)
    expect(nothing.data?.error).toMatch(/Nothing is due/)
    expect(nothing.data?.agent).toMatchObject({
      attempted: 'Running reminders.complete from /m/memory/reminders',
      tool: 'reminders.complete',
      input: { reminder_id: r.id },
    })
    expect(await act('pause', 'ony', { reminder_id: r.id })).toEqual({ reminderId: r.id, ok: true })
    expect(await act('resume', 'ony', { reminder_id: r.id })).toEqual({
      reminderId: r.id,
      ok: true,
    })
    expect(
      await act('update', 'ony', {
        reminder_id: r.id,
        title: 'LinkedIn',
        note: 'Two posts',
        weekdays: ['TU'],
        time: '10:00',
        time_zone: '',
      }),
    ).toEqual({ reminderId: r.id, ok: true })
    expect((await loaded('ony')).reminders[0]).toMatchObject({
      title: 'LinkedIn',
      note: 'Two posts',
      weekdays: ['TU'],
      time: '10:00',
    })
    const bad = await act('update', 'ony', {
      reminder_id: r.id,
      title: 'LinkedIn',
      weekdays: [],
      time: '10:00',
    })
    expect(bad.status).toBe(400)
    const stranger = await act('delete', 'alex', { reminder_id: r.id })
    expect(stranger.status).toBe(404)
    expect(await act('delete', 'ony', { reminder_id: r.id })).toEqual({
      reminderId: r.id,
      ok: true,
    })
    expect((await loaded('ony')).reminders).toEqual([])
  })

  it('refuses someone who is no member of the company', async () => {
    setup()
    expect(
      (await act('create', 'stranger', { title: 'x', weekdays: ['MO'], time: '09:00' })).status,
    ).toBe(403)
  })
})
