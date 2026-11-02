import { describe, expect, it } from 'vitest'
import { activeMemorySurfaceTab } from './memory-surface-nav'

describe('activeMemorySurfaceTab', () => {
  it.each([
    ['/memory/tasks', 'tasks'],
    ['/memory/projects', 'projects'],
    ['/memory/projects/7f1c2a9e-3b4d-4c5e-8f6a-1b2c3d4e5f60', 'projects'],
    ['/memory/notes', 'notes'],
  ])('%s -> %s', (path, tab) => {
    expect(activeMemorySurfaceTab(path)).toBe(tab)
  })

  it('has no tab for the removed graph view', () => {
    expect(activeMemorySurfaceTab('/memory')).toBeNull()
  })
})
