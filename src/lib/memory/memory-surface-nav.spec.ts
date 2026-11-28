import { describe, expect, it } from 'vitest'
import { activeMemorySurfaceTab, MEMORY_TABS } from './memory-surface-nav'

describe('MEMORY_TABS', () => {
  it('is the one sub-navigation of the Memory page: What the brain knows · Tasks · Projects · Documents · Reminders · Questions (plan/concept-memory-one-door.md §2.2; Handover is gone, wish f3fc516e)', () => {
    expect(MEMORY_TABS.map((t) => [t.id, t.label(), t.href])).toEqual([
      ['knows', 'What the brain knows', '/m/memory/capture'],
      ['tasks', 'Tasks', '/m/memory/tasks'],
      ['projects', 'Projects', '/m/memory/projects'],
      ['documents', 'Documents', '/m/memory/notes'],
      ['reminders', 'Reminders', '/m/memory/reminders'],
      ['questions', 'Questions', '/m/memory/questions'],
    ])
  })

  it('has no Overview tab any more (/m/memory lands on What the brain knows)', () => {
    expect(MEMORY_TABS.some((t) => t.href === '/m/memory')).toBe(false)
  })

  it('every tab explains itself in one line', () => {
    expect(Object.fromEntries(MEMORY_TABS.map((t) => [t.id, t.description()]))).toEqual({
      tasks: 'One step someone does.',
      projects: 'An outcome with several steps.',
      documents: 'Kept as you wrote it. The brain reads it, but doesn’t rewrite it.',
      reminders: 'Comes back on the weekdays you pick, until you stop it.',
      questions: 'Short questions for colleagues, answered right here.',
      knows: 'Everything the brain took in, and whether it’s indexed yet.',
    })
    for (const tab of MEMORY_TABS) expect(tab.description()).not.toContain('\n')
  })
})

describe('activeMemorySurfaceTab', () => {
  it.each([
    ['/m/memory/tasks', 'tasks'],
    ['/m/memory/reminders', 'reminders'],
    ['/m/memory/questions', 'questions'],
    ['/m/memory/projects', 'projects'],
    ['/m/memory/projects/7f1c2a9e-3b4d-4c5e-8f6a-1b2c3d4e5f60', 'projects'],
    ['/m/memory/notes', 'documents'],
    ['/m/memory/capture', 'knows'],
    ['/m/memory/capture/', 'knows'],
  ])('%s -> %s', (path, tab) => {
    expect(activeMemorySurfaceTab(path)).toBe(tab)
  })

  it('has no tab outside the tabs (the bare /m/memory redirects; settings is no tab)', () => {
    for (const path of ['/m/memory', '/m/memory/handover', '/m/memory/settings', '/memory', '/capture', '/m/memoryx', '/m/website'])
      expect(activeMemorySurfaceTab(path)).toBeNull()
  })
})
