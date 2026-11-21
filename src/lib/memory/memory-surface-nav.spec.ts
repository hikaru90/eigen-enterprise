import { describe, expect, it } from 'vitest'
import { activeMemorySurfaceTab, MEMORY_TABS } from './memory-surface-nav'

describe('MEMORY_TABS', () => {
  it('is the one sub-navigation of the Memory page, each tab its own URL under /m/memory', () => {
    expect(MEMORY_TABS.map((t) => [t.label, t.href])).toEqual([
      ['Overview', '/m/memory'],
      ['Tasks', '/m/memory/tasks'],
      ['Reminders', '/m/memory/reminders'],
      ['Projects', '/m/memory/projects'],
      ['Notes', '/m/memory/notes'],
      ['Capture', '/m/memory/capture'],
    ])
  })

  it('every tab says in one short line what it holds (Contribute d5e61e1f)', () => {
    for (const tab of MEMORY_TABS) {
      expect(tab.description.length).toBeGreaterThan(0)
      expect(tab.description).not.toContain('\n')
      expect(tab.description.length).toBeLessThanOrEqual(90)
    }
    expect(new Set(MEMORY_TABS.map((t) => t.description)).size).toBe(MEMORY_TABS.length)
  })
})

describe('activeMemorySurfaceTab', () => {
  it.each([
    ['/m/memory', 'overview'],
    ['/m/memory/', 'overview'],
    ['/m/memory/tasks', 'tasks'],
    ['/m/memory/reminders', 'reminders'],
    ['/m/memory/projects', 'projects'],
    ['/m/memory/projects/7f1c2a9e-3b4d-4c5e-8f6a-1b2c3d4e5f60', 'projects'],
    ['/m/memory/notes', 'notes'],
    ['/m/memory/capture', 'capture'],
  ])('%s -> %s', (path, tab) => {
    expect(activeMemorySurfaceTab(path)).toBe(tab)
  })

  it('has no tab outside the Memory page (old /memory/* and /capture URLs are gone)', () => {
    for (const path of ['/memory', '/memory/tasks', '/capture', '/m/memoryx', '/m/website'])
      expect(activeMemorySurfaceTab(path)).toBeNull()
  })
})
