import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import type { OwnTaskService, OwnTaskView } from '$lib/server/memory/own-tasks'
import { memoryManifest, OWN_TASK_TOOL_NAMES } from './manifest'
import { createOwnTaskTools } from './own-task-tools'

/** An in-memory Memory › Tasks for one or more people (the live service is own-tasks.ts). */
function fakeService() {
  const rows = new Map<string, OwnTaskView & { userId: string; text: string }>()
  let n = 0
  const own = (userId: string, id: string) => {
    const row = rows.get(id)
    return row && row.userId === userId ? row : null
  }
  const view = (row: OwnTaskView & { userId: string; text: string }): OwnTaskView => {
    const { userId: _u, text: _t, ...v } = row
    return v
  }
  const svc: OwnTaskService = {
    list: vi.fn(async (userId, status) =>
      [...rows.values()]
        .filter((r) => r.userId === userId)
        .filter((r) => status === 'all' || (status === 'open' ? r.status === 'open' : r.status === 'completed'))
        .map(view),
    ),
    get: vi.fn(async (userId, id) => {
      const row = own(userId, id)
      return row ? view(row) : null
    }),
    create: vi.fn(async (userId, input) => {
      n += 1
      const id = `task:t${n}`
      rows.set(id, {
        userId,
        text: input.text,
        id,
        thoughtId: `t${n}`,
        kind: 'task',
        title: input.text,
        status: 'open',
        dueAt: null,
        project: null,
        createdAt: '2026-11-21T09:00:00.000Z',
      })
      return { taskId: id }
    }),
    edit: vi.fn(async (userId, id, change) => {
      const row = own(userId, id)!
      row.title = `${row.title} (${change})`
    }),
    reschedule: vi.fn(async (userId, id, dueAt) => {
      own(userId, id)!.dueAt = dueAt
    }),
    setProject: vi.fn(async (userId, id, target) => {
      const row = own(userId, id)!
      row.project = 'projectEntityId' in target ? { id: target.projectEntityId, label: 'Launch' } : { id: 'p-new', label: target.projectLabel }
    }),
    complete: vi.fn(async (userId, id) => {
      own(userId, id)!.status = 'completed'
    }),
    remove: vi.fn(async (userId, id) => {
      if (!own(userId, id)) return { ok: false as const, reason: 'not_found' as const }
      rows.delete(id)
      return { ok: true as const }
    }),
  }
  return { svc, rows }
}

function setup(writer: { kind: 'self' | 'assistant'; userId: string } | null = { kind: 'assistant', userId: 'alex' }) {
  const { svc, rows } = fakeService()
  const writerOf = vi.fn(async () => writer)
  const tools = createOwnTaskTools({ service: async () => svc, writerOf })
  const tool = (name: string) => {
    const t = tools.find((d) => d.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t
  }
  const agent: ToolContext = { principal: { id: 'alex', kind: 'human', roles: ['member'], via: 'brain', agentId: 'orchestrator' }, requestId: 'r' }
  return { tool, tools, svc, rows, writerOf, agent }
}

describe('memory.* own-task tools (Memory › Tasks through the assistant)', () => {
  it('the memory manifest lists every own-task tool', () => {
    for (const name of OWN_TASK_TOOL_NAMES) expect(memoryManifest.tools).toContain(name)
    expect(OWN_TASK_TOOL_NAMES).toEqual([
      'memory.list_tasks',
      'memory.create_task',
      'memory.update_task',
      'memory.complete_task',
      'memory.delete_task',
    ])
  })

  it('every member reaches them for their own Memory; writes carry an activity line without the task text', () => {
    const { tools, tool } = setup()
    expect(tools.map((t) => t.name)).toEqual([...OWN_TASK_TOOL_NAMES])
    for (const t of tools) {
      expect(t.module).toBe('memory')
      expect(t.permission.roles).toEqual(['admin', 'member', 'agent'])
    }
    expect(tool('memory.list_tasks').auditClass).toBe('read')
    const input = { title: 'Call the bank about the mortgage' }
    for (const name of ['memory.create_task', 'memory.update_task', 'memory.complete_task', 'memory.delete_task']) {
      const t = tool(name)
      expect(t.auditClass).toBe('mutate')
      const line = t.activity!(input, undefined)
      expect(line.length).toBeGreaterThan(0)
      expect(line).not.toContain('bank')
    }
  })

  it('deletion declares its risk as destructive and is not on the always-ask wall (the person’s own Memory)', () => {
    const { tool } = setup()
    expect(tool('memory.delete_task').approvalRisk).toBe('destructive')
    expect(tool('memory.delete_task').approvalAlways).toBeUndefined()
    // The assistant is told to confirm with the person first and that archiving is the undoable way.
    expect(tool('memory.delete_task').summary).toMatch(/for good/i)
    expect(tool('memory.delete_task').summary).toMatch(/confirm/i)
  })

  it('the assistant adds a task to the person’s Memory (as coming through the assistant) and lists it', async () => {
    const { tool, agent, svc } = setup()
    const created = (await tool('memory.create_task').handler(agent, { title: 'Call the bank' })) as { task: OwnTaskView }
    expect(svc.create).toHaveBeenCalledWith('alex', { text: 'Call the bank', source: 'agent' })
    expect(created.task).toMatchObject({ id: 'task:t1', title: 'Call the bank', status: 'open' })
    const listed = (await tool('memory.list_tasks').handler(agent, {})) as { tasks: OwnTaskView[] }
    expect(listed.tasks.map((t) => t.id)).toEqual(['task:t1'])
    expect(svc.list).toHaveBeenCalledWith('alex', 'open')
  })

  it('a person (or their own API key) adds a task as themself', async () => {
    const { tool, agent, svc } = setup({ kind: 'self', userId: 'alex' })
    await tool('memory.create_task').handler(agent, { title: 'Water the plants' })
    expect(svc.create).toHaveBeenCalledWith('alex', { text: 'Water the plants', source: 'api' })
  })

  it('a new task can land in a project right away', async () => {
    const { tool, agent, svc } = setup()
    const created = (await tool('memory.create_task').handler(agent, { title: 'Book venue', project_label: 'Offsite' })) as { task: OwnTaskView }
    expect(svc.setProject).toHaveBeenCalledWith('alex', 'task:t1', { projectLabel: 'Offsite' })
    expect(created.task.project).toEqual({ id: 'p-new', label: 'Offsite' })
  })

  it('update changes the text in plain words, a dated item’s due time, and the project', async () => {
    const { tool, agent, svc, rows } = setup()
    await tool('memory.create_task').handler(agent, { title: 'Dentist' })
    // A dated row (a temporal event) can be rescheduled.
    rows.set('ev-1', { ...rows.get('task:t1')!, id: 'ev-1', kind: 'event', dueAt: '2026-11-24T09:00:00.000Z' })
    const out = (await tool('memory.update_task').handler(agent, {
      task_id: 'ev-1',
      change: 'rename it to Dentist check-up',
      due_at: '2026-11-25T10:00:00.000Z',
      project_entity_id: 'p-1',
    })) as { task: OwnTaskView }
    expect(svc.edit).toHaveBeenCalledWith('alex', 'ev-1', 'rename it to Dentist check-up')
    expect(svc.reschedule).toHaveBeenCalledWith('alex', 'ev-1', '2026-11-25T10:00:00.000Z')
    expect(svc.setProject).toHaveBeenCalledWith('alex', 'ev-1', { projectEntityId: 'p-1' })
    expect(out.task).toMatchObject({ dueAt: '2026-11-25T10:00:00.000Z', project: { id: 'p-1', label: 'Launch' } })
  })

  it('an undated task gets its due day through the change in words, not due_at (fails loud, changes nothing)', async () => {
    const { tool, agent, svc } = setup()
    await tool('memory.create_task').handler(agent, { title: 'Dentist' })
    await expect(tool('memory.update_task').handler(agent, { task_id: 'task:t1', due_at: '2026-11-25T10:00:00.000Z' })).rejects.toThrow(
      /no date of its own.*change/i,
    )
    expect(svc.reschedule).not.toHaveBeenCalled()
  })

  it('update needs something to change and refuses both a project id and a project name', () => {
    const { tool } = setup()
    const schema = tool('memory.update_task').inputSchema
    expect(schema.safeParse({ task_id: 'task:t1' }).success).toBe(false)
    expect(schema.safeParse({ task_id: 'task:t1', project_entity_id: 'p', project_label: 'P' }).success).toBe(false)
    expect(schema.safeParse({ task_id: 'task:t1', due_at: 'Friday' }).success).toBe(false)
    expect(schema.safeParse({ task_id: 'task:t1', change: 'due Friday' }).success).toBe(true)
  })

  it('completes a task; the done list shows it', async () => {
    const { tool, agent } = setup()
    await tool('memory.create_task').handler(agent, { title: 'Pay rent' })
    const done = (await tool('memory.complete_task').handler(agent, { task_id: 'task:t1' })) as { task: OwnTaskView }
    expect(done.task.status).toBe('completed')
    const listed = (await tool('memory.list_tasks').handler(agent, { status: 'done' })) as { tasks: OwnTaskView[] }
    expect(listed.tasks.map((t) => t.id)).toEqual(['task:t1'])
  })

  it('deletes a task for good; afterwards it is gone', async () => {
    const { tool, agent } = setup()
    await tool('memory.create_task').handler(agent, { title: 'Old idea' })
    expect(await tool('memory.delete_task').handler(agent, { task_id: 'task:t1' })).toEqual({ deleted: true, taskId: 'task:t1' })
    const listed = (await tool('memory.list_tasks').handler(agent, { status: 'all' })) as { tasks: OwnTaskView[] }
    expect(listed.tasks).toEqual([])
  })

  it('another person’s task is not found — never changed or deleted', async () => {
    const { tool, agent, svc, rows } = setup()
    rows.set('task:x', { ...({} as OwnTaskView), id: 'task:x', thoughtId: 'x', kind: 'task', title: 'Ony’s', status: 'open', dueAt: null, project: null, createdAt: '', userId: 'ony', text: 'Ony’s' })
    for (const [name, input] of [
      ['memory.update_task', { task_id: 'task:x', change: 'done' }],
      ['memory.complete_task', { task_id: 'task:x' }],
      ['memory.delete_task', { task_id: 'task:x' }],
    ] as const) {
      await expect(tool(name).handler(agent, input)).rejects.toThrow(/not in your Memory/i)
    }
    expect(svc.edit).not.toHaveBeenCalled()
    expect(svc.complete).not.toHaveBeenCalled()
    expect(rows.has('task:x')).toBe(true)
  })

  it('a task of a company system project is refused, not deleted', async () => {
    const { tool, agent, svc } = setup()
    await tool('memory.create_task').handler(agent, { title: 'Roadmap item' })
    vi.mocked(svc.remove).mockResolvedValueOnce({ ok: false, reason: 'system_project_task', projectLabel: 'Roadmap' })
    await expect(tool('memory.delete_task').handler(agent, { task_id: 'task:t1' })).rejects.toMatchObject({
      code: 'permission_denied',
      message: expect.stringMatching(/Roadmap/),
    })
  })

  it('an agent working for no one reads and changes nothing', async () => {
    const { tool, agent, svc } = setup(null)
    await expect(tool('memory.list_tasks').handler(agent, {})).rejects.toThrow(/works for no one/)
    await expect(tool('memory.create_task').handler(agent, { title: 'X' })).rejects.toThrow(/works for no one/)
    await expect(tool('memory.delete_task').handler(agent, { task_id: 'task:t1' })).rejects.toThrow(/works for no one/)
    expect(svc.create).not.toHaveBeenCalled()
    expect(svc.remove).not.toHaveBeenCalled()
  })
})
