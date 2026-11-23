import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { memoryManifest, PROJECT_SCHEDULE_TOOL_NAMES } from './manifest'
import { createProjectScheduleTools, type ProjectScheduleServices } from './project-schedule-tools'

function setup(writer: { kind: 'self' | 'assistant'; userId: string } | null = { kind: 'assistant', userId: 'ony' }) {
  const s = {
    createProject: vi.fn(async (i: { label: string }) => ({ entityId: 'p1', label: i.label, status: 'active' as const, visibility: 'company' as const })),
    renameProject: vi.fn(async (_u: string, id: string, label: string) => ({ entityId: id, label })),
    setProjectDeadline: vi.fn(async (i: { projectEntityId: string; targetDate: string | null }) => ({ projectEntityId: i.projectEntityId, targetDate: i.targetDate })),
    setProjectMilestone: vi.fn(async () => ({ id: 'm1' })),
    dismissProject: vi.fn(async () => {}),
    orderTaskInProject: vi.fn(async () => ({ projectEntityId: 'p1', orderedThoughtIds: ['t1'] })),
    designateNextAction: vi.fn(async () => {}),
    projectTaskIds: vi.fn(async () => ['t1', 't2']),
    applyProjectReview: vi.fn(async () => ({ projectEntityId: 'p1', createdThoughtIds: [], nextActionThoughtId: null })),
    listScheduledTasks: vi.fn(async () => [{ id: 'eigen-sleep-consolidation' }]),
    setScheduledTaskPaused: vi.fn(async () => {}),
    runScheduledTaskNow: vi.fn(async () => ({ ok: true })),
    stopScheduledTask: vi.fn(async () => ({ softCancelled: true })),
    retryFailedScheduledStep: vi.fn(async () => ({ run: { runId: 'r1' }, job: { ok: true } })),
    rescheduleTimelineItem: vi.fn(async () => ({ ok: true })),
    snoozeTimelineItem: vi.fn(async () => ({ ok: true })),
    quickTimelineAction: vi.fn(async () => ({ ok: true })),
    markAssignedTaskSeen: vi.fn(async () => {}),
  }
  const tools = createProjectScheduleTools({ services: async () => s as unknown as ProjectScheduleServices, writerOf: async () => writer })
  const tool = (name: string) => tools.find((t) => t.name === name)!
  const agent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['agent'] }, requestId: 'r' }
  return { s, tool, agent }
}

describe('project, schedule and timeline tools', () => {
  it('every tool is in the memory manifest; reads are read, the rest mutate with an activity line', () => {
    const { tool } = setup()
    for (const name of PROJECT_SCHEDULE_TOOL_NAMES) {
      expect(memoryManifest.tools).toContain(name)
      const t = tool(name)
      expect(t.permission.roles).toEqual(['admin', 'member', 'agent'])
      if (name === 'memory.list_scheduled_tasks') expect(t.auditClass).toBe('read')
      else {
        expect(t.auditClass).toBe('mutate')
        expect(t.activity).toBeTypeOf('function')
      }
    }
  })

  it('project writes land as the person the assistant works for', async () => {
    const { s, tool, agent } = setup()
    await tool('memory.create_project').handler(agent, { label: 'Launch', private: true })
    expect(s.createProject).toHaveBeenCalledWith({ userId: 'ony', label: 'Launch', visibility: 'private' })
    await tool('memory.rename_project').handler(agent, { project_entity_id: 'p1', label: 'Relaunch' })
    expect(s.renameProject).toHaveBeenCalledWith('ony', 'p1', 'Relaunch')
    await tool('memory.set_project_deadline').handler(agent, { project_entity_id: 'p1', target_date: null })
    expect(s.setProjectDeadline).toHaveBeenCalledWith({ userId: 'ony', projectEntityId: 'p1', targetDate: null })
    await tool('memory.set_project_milestone').handler(agent, { project_entity_id: 'p1', label: 'Beta', completed: true })
    expect(s.setProjectMilestone).toHaveBeenCalledWith({ userId: 'ony', projectEntityId: 'p1', label: 'Beta', completed: true })
    await tool('memory.dismiss_project').handler(agent, { project_entity_id: 'p1' })
    expect(s.dismissProject).toHaveBeenCalledWith('ony', 'p1')
  })

  it('reorders a task and optionally makes it the next action', async () => {
    const { s, tool, agent } = setup()
    await tool('memory.order_project_task').handler(agent, { project_entity_id: 'p1', thought_id: 't1', after_thought_id: null })
    expect(s.designateNextAction).not.toHaveBeenCalled()
    await tool('memory.order_project_task').handler(agent, { project_entity_id: 'p1', thought_id: 't1', as_next_action: true })
    expect(s.orderTaskInProject).toHaveBeenLastCalledWith({ userId: 'ony', projectEntityId: 'p1', thoughtId: 't1' })
    expect(s.designateNextAction).toHaveBeenCalledWith('ony', 'p1', 't1')
  })

  it('applies a project review with the service defaults filled in', async () => {
    const { s, tool, agent } = setup()
    await tool('memory.apply_project_review').handler(agent, { project_entity_id: 'p1', mark_done: ['t1'], new_tasks: [{ summary: 'Call Acme' }] })
    expect(s.applyProjectReview).toHaveBeenCalledWith({
      userId: 'ony',
      projectEntityId: 'p1',
      markDone: ['t1'],
      archive: [],
      deadlines: [],
      order: [],
      newTasks: [{ summary: 'Call Acme', kind: null, suggestedStartAt: null, suggestedEndAt: null }],
      nextActionThoughtId: null,
      nextActionNewTaskIndex: null,
      // The project's own tasks, loaded server-side — never a list the caller claims.
      allowedThoughtIds: ['t1', 't2'],
    })
    expect(s.projectTaskIds).toHaveBeenCalledWith('ony', 'p1')
  })

  it('scheduled tasks: list, pause, resume, run now, stop, retry a failed step', async () => {
    const { s, tool, agent } = setup()
    expect(await tool('memory.list_scheduled_tasks').handler(agent, {})).toEqual({ tasks: [{ id: 'eigen-sleep-consolidation' }] })
    await tool('memory.pause_scheduled_task').handler(agent, { task_id: 'x' })
    expect(s.setScheduledTaskPaused).toHaveBeenLastCalledWith('ony', 'x', true)
    await tool('memory.resume_scheduled_task').handler(agent, { task_id: 'x' })
    expect(s.setScheduledTaskPaused).toHaveBeenLastCalledWith('ony', 'x', false)
    await tool('memory.run_scheduled_task').handler(agent, { task_id: 'x' })
    expect(s.runScheduledTaskNow).toHaveBeenCalledWith('ony', 'x')
    await tool('memory.stop_scheduled_task').handler(agent, { task_id: 'x' })
    expect(s.stopScheduledTask).toHaveBeenCalledWith('ony', 'x')
    await tool('memory.retry_scheduled_task_step').handler(agent, { task_id: 'x', run_id: 'r1', job_id: 'j1' })
    expect(s.retryFailedScheduledStep).toHaveBeenCalledWith('ony', 'x', { runId: 'r1', jobId: 'j1' })
  })

  it('timeline items: reschedule, snooze, complete', async () => {
    const { s, tool, agent } = setup()
    await tool('memory.reschedule_timeline_item').handler(agent, { event_id: 'e1', start_at: '2026-12-01T09:00:00Z' })
    expect(s.rescheduleTimelineItem).toHaveBeenCalledWith('ony', 'e1', { startAt: '2026-12-01T09:00:00Z', endAt: null })
    await tool('memory.snooze_timeline_item').handler(agent, { event_id: 'e1', snoozed_until: '2026-12-02T09:00:00Z' })
    expect(s.snoozeTimelineItem).toHaveBeenCalledWith('ony', 'e1', '2026-12-02T09:00:00Z')
    await tool('memory.set_timeline_item_status').handler(agent, { event_id: 'e1', action: 'mark_done' })
    expect(s.quickTimelineAction).toHaveBeenCalledWith('ony', 'e1', 'mark_done')
    expect(tool('memory.set_timeline_item_status').inputSchema.safeParse({ event_id: 'e1', action: 'explode' }).success).toBe(false)
  })

  it('marks an assigned task seen for the person', async () => {
    const { s, tool, agent } = setup()
    await tool('tasks.mark_seen').handler(agent, { task_id: 'a1' })
    expect(s.markAssignedTaskSeen).toHaveBeenCalledWith('ony', 'a1')
  })

  it('an agent working for no one changes nothing', async () => {
    const { s, tool, agent } = setup(null)
    await expect(tool('memory.dismiss_project').handler(agent, { project_entity_id: 'p1' })).rejects.toThrow(/works for no one/)
    await expect(tool('memory.list_scheduled_tasks').handler(agent, {})).rejects.toThrow(/works for no one/)
    expect(s.dismissProject).not.toHaveBeenCalled()
  })
})
