import { describe, expect, it } from 'vitest'
import {
  roadmapItemFromTask,
  roadmapStatusOfTask,
  taskStateForStatus,
  type RoadmapTaskRow,
} from './task-mapping'

const now = new Date('2026-11-04T10:00:00Z')
const earlier = new Date('2026-11-01T09:00:00Z')

function task(overrides: Partial<RoadmapTaskRow> = {}): RoadmapTaskRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'One-command deploy',
    detail: 'curl-to-VPS.',
    lifecycleStatus: 'open',
    lifecycleCompletedAt: null,
    taskKind: 'feature',
    taskStartedAt: null,
    taskPosition: 2,
    createdAt: earlier,
    updatedAt: now,
    ...overrides,
  }
}

describe('roadmap status ⇄ Memory task state', () => {
  it('reads open tasks as planned, started open tasks as in progress, completed as shipped', () => {
    expect(roadmapStatusOfTask({ lifecycleStatus: 'open', taskStartedAt: null })).toBe('planned')
    expect(roadmapStatusOfTask({ lifecycleStatus: 'open', taskStartedAt: earlier })).toBe(
      'in_progress',
    )
    expect(roadmapStatusOfTask({ lifecycleStatus: 'completed', taskStartedAt: null })).toBe(
      'shipped',
    )
    expect(roadmapStatusOfTask({ lifecycleStatus: 'completed', taskStartedAt: earlier })).toBe(
      'shipped',
    )
  })

  it('an archived task is off the roadmap', () => {
    expect(roadmapStatusOfTask({ lifecycleStatus: 'archived', taskStartedAt: earlier })).toBeNull()
    expect(roadmapItemFromTask(task({ lifecycleStatus: 'archived' }))).toBeNull()
  })

  it('writes planned as open and not started', () => {
    expect(taskStateForStatus('planned', now, { taskStartedAt: earlier })).toEqual({
      lifecycleStatus: 'open',
      lifecycleCompletedAt: null,
      lifecycleUpdatedAt: now,
      taskStartedAt: null,
    })
  })

  it('writes in progress as open and started, keeping an earlier start', () => {
    expect(taskStateForStatus('in_progress', now)).toMatchObject({
      lifecycleStatus: 'open',
      lifecycleCompletedAt: null,
      taskStartedAt: now,
    })
    expect(taskStateForStatus('in_progress', now, { taskStartedAt: earlier }).taskStartedAt).toBe(
      earlier,
    )
  })

  it('writes shipped as completed now, keeping the start', () => {
    expect(taskStateForStatus('shipped', now, { taskStartedAt: earlier })).toEqual({
      lifecycleStatus: 'completed',
      lifecycleCompletedAt: now,
      lifecycleUpdatedAt: now,
      taskStartedAt: earlier,
    })
  })

  it('round-trips every status', () => {
    for (const status of ['planned', 'in_progress', 'shipped'] as const) {
      const state = taskStateForStatus(status, now)
      expect(roadmapStatusOfTask(state)).toBe(status)
    }
  })
})

describe('roadmapItemFromTask', () => {
  it('maps the task columns onto the roadmap item contract', () => {
    expect(roadmapItemFromTask(task())).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      title: 'One-command deploy',
      detail: 'curl-to-VPS.',
      status: 'planned',
      kind: 'feature',
      position: 2,
      shippedAt: null,
      createdAt: earlier.toISOString(),
      updatedAt: now.toISOString(),
    })
  })

  it('stamps shippedAt from the completion time of a shipped task only', () => {
    expect(
      roadmapItemFromTask(task({ lifecycleStatus: 'completed', lifecycleCompletedAt: now }))
        ?.shippedAt,
    ).toBe(now.toISOString())
    expect(roadmapItemFromTask(task({ lifecycleCompletedAt: now }))?.shippedAt).toBeNull()
  })

  it('keeps fix and chore; a task with no kind or position reads as a feature at 0', () => {
    expect(roadmapItemFromTask(task({ taskKind: 'fix' }))?.kind).toBe('fix')
    expect(roadmapItemFromTask(task({ taskKind: 'chore' }))?.kind).toBe('chore')
    const plain = roadmapItemFromTask(task({ taskKind: null, taskPosition: null }))
    expect(plain?.kind).toBe('feature')
    expect(plain?.position).toBe(0)
  })
})
