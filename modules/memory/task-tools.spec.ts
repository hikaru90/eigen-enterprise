import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { memoryAssignedTaskStore } from '$lib/server/memory/assigned-tasks/memory-store'
import type { AssignedTaskDeps } from '$lib/server/memory/assigned-tasks/service'
import { memoryManifest } from './manifest'
import { createTaskTools, TASK_TOOL_NAMES } from './task-tools'

const people = [
  { id: 'alex', name: 'Alex', email: 'alex@k.co' },
  { id: 'ony', name: 'Ony', email: 'ony@k.co' },
]

function setup(writer: { kind: 'self' | 'assistant'; userId: string } | null = { kind: 'assistant', userId: 'alex' }) {
  const notify = vi.fn(async () => {})
  const deps: AssignedTaskDeps = {
    store: memoryAssignedTaskStore(),
    directory: { get: async (id) => people.find((p) => p.id === id) ?? null, list: async () => people },
    notify,
  }
  const writerOf = vi.fn(async () => writer)
  const tools = createTaskTools({ deps: async () => deps, writerOf })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const agent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['agent'] }, requestId: 'r' }
  return { tool, agent, notify, writerOf }
}

describe('tasks.* tools', () => {
  it('the memory module owns the tasks namespace and lists every task tool', () => {
    expect(memoryManifest.toolNamespaces).toEqual(['memory', 'tasks', 'reminders'])
    for (const name of TASK_TOOL_NAMES) expect(memoryManifest.tools).toContain(name)
  })

  it('declares audit classes; writes are not approval-gated and carry an activity sentence', () => {
    const { tool } = setup()
    expect(tool('tasks.assignees').auditClass).toBe('read')
    expect(tool('tasks.list').auditClass).toBe('read')
    for (const name of ['tasks.assign', 'tasks.complete', 'tasks.comment']) {
      expect(tool(name).auditClass).toBe('mutate')
      expect(tool(name).activity).toBeTypeOf('function')
    }
  })

  it('the assistant assigns for the person it works for: the activity line says who assigned what to whom', async () => {
    const { tool, agent, notify } = setup()
    const input = { assignee_id: 'ony', title: 'Send the Q4 deck', context: 'Before Friday’s call.', due_on: '2026-11-21' }
    const out = (await tool('tasks.assign').handler(agent, input)) as { id: string; assigner: { name: string }; assignee: { name: string }; createdVia: string }
    expect(out).toMatchObject({ assigner: { name: 'Alex' }, assignee: { name: 'Ony' }, createdVia: 'assistant' })
    expect(tool('tasks.assign').activity!(input, out)).toBe("Alex assigned 'Send the Q4 deck' to Ony")
    expect(tool('tasks.assign').activity!(input, undefined)).toBe("Assigned 'Send the Q4 deck'")
    expect(notify).toHaveBeenCalledWith('ony', expect.objectContaining({ title: 'Alex assigned you a task' }))
  })

  it('assignees are the company members (never contacts), without the person themself', async () => {
    const { tool, agent } = setup()
    expect(await tool('tasks.assignees').handler(agent, {})).toEqual({ members: [{ id: 'ony', name: 'Ony', email: 'ony@k.co' }] })
  })

  it('the assignee completes and comments through their assistant; the activity names them', async () => {
    const alexSide = setup()
    const task = (await alexSide.tool('tasks.assign').handler(alexSide.agent, { assignee_id: 'ony', title: 'Book the venue' })) as { id: string }
    // Same store, now Ony's assistant.
    alexSide.writerOf.mockResolvedValue({ kind: 'assistant', userId: 'ony' })
    const listed = (await alexSide.tool('tasks.list').handler(alexSide.agent, {})) as { assignedToMe: Array<{ id: string }> }
    expect(listed.assignedToMe.map((t) => t.id)).toEqual([task.id])
    const commented = await alexSide.tool('tasks.comment').handler(alexSide.agent, { task_id: task.id, body: 'On it.' })
    expect(alexSide.tool('tasks.comment').activity!({ task_id: task.id, body: 'On it.' }, commented)).toBe("Ony commented on 'Book the venue'")
    const done = await alexSide.tool('tasks.complete').handler(alexSide.agent, { task_id: task.id })
    expect(alexSide.tool('tasks.complete').activity!({ task_id: task.id }, done)).toBe("Ony completed 'Book the venue'")
    expect(alexSide.notify).toHaveBeenLastCalledWith('alex', expect.objectContaining({ title: "Ony completed 'Book the venue'" }))
  })

  it('an agent working for no one changes nothing', async () => {
    const { tool, agent } = setup(null)
    await expect(tool('tasks.assign').handler(agent, { assignee_id: 'ony', title: 'X' })).rejects.toThrow(/works for no one/)
    await expect(tool('tasks.list').handler(agent, {})).rejects.toThrow(/works for no one/)
  })

  it('rejects a malformed due date at the schema', async () => {
    const { tool } = setup()
    expect(tool('tasks.assign').inputSchema.safeParse({ assignee_id: 'ony', title: 'X', due_on: 'Friday' }).success).toBe(false)
    expect(tool('tasks.assign').inputSchema.safeParse({ assignee_id: 'ony', title: 'X', due_on: '2026-11-21' }).success).toBe(true)
  })
})
