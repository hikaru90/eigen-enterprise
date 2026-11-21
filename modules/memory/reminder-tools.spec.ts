import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { memoryReminderStore } from '$lib/server/memory/reminders/memory-store'
import type { ReminderDeps, ReminderView } from '$lib/server/memory/reminders/service'
import { memoryManifest } from './manifest'
import { createReminderTools, REMINDER_TOOL_NAMES } from './reminder-tools'

function setup(writer: { kind: 'self' | 'assistant'; userId: string } | null = { kind: 'assistant', userId: 'ony' }) {
  let now = new Date('2026-11-21T12:00:00Z') // Saturday
  const deps: ReminderDeps = {
    store: memoryReminderStore(),
    timeZoneOf: async () => 'Europe/Berlin',
    now: () => now,
  }
  const writerOf = vi.fn(async () => writer)
  const tools = createReminderTools({ deps: async () => deps, writerOf })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const agent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['agent'] }, requestId: 'r' }
  return { tool, agent, writerOf, at: (iso: string) => (now = new Date(iso)) }
}

const linkedIn = { title: 'LinkedIn posts', note: 'Prepare, check or send', weekdays: ['MO', 'TH'], time: '09:00' }

describe('reminders.* tools', () => {
  it('the memory module owns the reminders namespace and lists every reminder tool', () => {
    expect(memoryManifest.toolNamespaces).toContain('reminders')
    expect(REMINDER_TOOL_NAMES).toEqual([
      'reminders.create',
      'reminders.list',
      'reminders.update',
      'reminders.pause',
      'reminders.resume',
      'reminders.delete',
      'reminders.complete',
      'reminders.snooze',
    ])
    for (const name of REMINDER_TOOL_NAMES) expect(memoryManifest.tools).toContain(name)
  })

  it('declares audit classes; every write carries an activity sentence and reaches every member', () => {
    const { tool } = setup()
    expect(tool('reminders.list').auditClass).toBe('read')
    for (const name of REMINDER_TOOL_NAMES.filter((n) => n !== 'reminders.list')) {
      expect(tool(name).auditClass).toBe('mutate')
      expect(tool(name).activity).toBeTypeOf('function')
      expect(tool(name).permission.roles).toEqual(['admin', 'member', 'agent'])
    }
  })

  it('"remind me every Monday and Thursday at 9": the assistant creates it for the person, in their zone', async () => {
    const { tool, agent } = setup()
    const out = (await tool('reminders.create').handler(agent, linkedIn)) as ReminderView
    expect(out).toMatchObject({ title: 'LinkedIn posts', weekdays: ['MO', 'TH'], time: '09:00', timeZone: 'Europe/Berlin', createdVia: 'assistant', nextAt: '2026-11-23T08:00:00.000Z' })
    expect(tool('reminders.create').activity!(linkedIn, out)).toBe("Set a reminder 'LinkedIn posts' (Mon, Thu 09:00)")
  })

  it('ticks off, snoozes, pauses, resumes, updates and deletes — the person’s own reminders only', async () => {
    const { tool, agent, at, writerOf } = setup()
    const r = (await tool('reminders.create').handler(agent, linkedIn)) as ReminderView
    at('2026-11-27T10:00:00Z')
    const listed = (await tool('reminders.list').handler(agent, {})) as { reminders: ReminderView[] }
    expect(listed.reminders[0].due?.count).toBe(2)
    expect(((await tool('reminders.complete').handler(agent, { reminder_id: r.id })) as ReminderView).due?.count).toBe(1)
    expect(((await tool('reminders.snooze').handler(agent, { reminder_id: r.id, minutes: 60 })) as ReminderView).snoozedUntil).toBe('2026-11-27T11:00:00.000Z')
    expect(((await tool('reminders.complete').handler(agent, { reminder_id: r.id, all: true })) as ReminderView).due).toBeNull()
    expect(((await tool('reminders.pause').handler(agent, { reminder_id: r.id })) as ReminderView).status).toBe('paused')
    expect(((await tool('reminders.resume').handler(agent, { reminder_id: r.id })) as ReminderView).status).toBe('active')
    expect(((await tool('reminders.update').handler(agent, { reminder_id: r.id, weekdays: ['TU'] })) as ReminderView).weekdays).toEqual(['TU'])
    // Someone else's assistant does not find it.
    writerOf.mockResolvedValue({ kind: 'assistant', userId: 'alex' })
    await expect(tool('reminders.delete').handler(agent, { reminder_id: r.id })).rejects.toThrow(/not found/)
    writerOf.mockResolvedValue({ kind: 'assistant', userId: 'ony' })
    const deleted = await tool('reminders.delete').handler(agent, { reminder_id: r.id })
    expect(tool('reminders.delete').activity!({ reminder_id: r.id }, deleted)).toBe("Deleted the reminder 'LinkedIn posts'")
  })

  it('an agent working for no one changes nothing', async () => {
    const { tool, agent } = setup(null)
    await expect(tool('reminders.create').handler(agent, linkedIn)).rejects.toThrow(/works for no one/)
    await expect(tool('reminders.list').handler(agent, {})).rejects.toThrow(/works for no one/)
  })

  it('rejects malformed input at the schema', () => {
    const { tool } = setup()
    const create = tool('reminders.create').inputSchema
    expect(create.safeParse({ ...linkedIn, weekdays: ['Monday'] }).success).toBe(false)
    expect(create.safeParse({ ...linkedIn, weekdays: [] }).success).toBe(false)
    expect(create.safeParse({ ...linkedIn, time: '9' }).success).toBe(false)
    expect(tool('reminders.snooze').inputSchema.safeParse({ reminder_id: 'x', minutes: 0 }).success).toBe(false)
    expect(tool('reminders.update').inputSchema.safeParse({ reminder_id: 'x', status: 'paused' }).success).toBe(false)
  })
})
