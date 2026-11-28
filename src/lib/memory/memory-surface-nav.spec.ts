import { describe, expect, it } from 'vitest'
import { activeMemorySurfaceTab, MEMORY_TABS } from './memory-surface-nav'

describe('MEMORY_TABS', () => {
  it('is the one sub-navigation of the Memory page: Tasks · Projects · Reminders · Questions · Handover · What the brain knows (plan/concept-memory-one-door.md §2.2)', () => {
    expect(MEMORY_TABS.map((t) => [t.id, t.label(), t.href])).toEqual([
      ['tasks', 'Tasks', '/m/memory/tasks'],
      ['projects', 'Projects', '/m/memory/projects'],
      ['reminders', 'Reminders', '/m/memory/reminders'],
      ['questions', 'Questions', '/m/memory/questions'],
      ['handover', 'Handover', '/m/memory/handover'],
      ['knows', 'What the brain knows', '/m/memory/capture'],
    ])
  })

  it('has no Documents tab any more: documents are Drive files (/m/memory/notes redirects there)', () => {
    expect(MEMORY_TABS.some((t) => t.href === '/m/memory/notes')).toBe(false)
    expect(activeMemorySurfaceTab('/m/memory/notes')).toBeNull()
  })

  it('has no Overview tab any more (/m/memory lands on Tasks)', () => {
    expect(MEMORY_TABS.some((t) => t.href === '/m/memory')).toBe(false)
  })

  it('every tab explains itself in one line', () => {
    expect(Object.fromEntries(MEMORY_TABS.map((t) => [t.id, t.description()]))).toEqual({
      tasks: 'One step someone does.',
      projects: 'An outcome with several steps.',
      reminders: 'Comes back on the weekdays you pick, until you stop it.',
      questions: 'Short questions for colleagues, answered right here.',
      handover: 'Where things stand, one line per topic. Everyone in the company reads it.',
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
    ['/m/memory/handover', 'handover'],
    ['/m/memory/projects', 'projects'],
    ['/m/memory/projects/7f1c2a9e-3b4d-4c5e-8f6a-1b2c3d4e5f60', 'projects'],
    ['/m/memory/capture', 'knows'],
    ['/m/memory/capture/', 'knows'],
  ])('%s -> %s', (path, tab) => {
    expect(activeMemorySurfaceTab(path)).toBe(tab)
  })

  it('has no tab outside the tabs (the bare /m/memory redirects; settings is no tab)', () => {
    for (const path of ['/m/memory', '/m/memory/settings', '/memory', '/capture', '/m/memoryx', '/m/website'])
      expect(activeMemorySurfaceTab(path)).toBeNull()
  })
})
