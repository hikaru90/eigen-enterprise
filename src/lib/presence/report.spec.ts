import { describe, expect, it } from 'vitest'
import type { ShellNavItem } from '$lib/shell/nav'
import { whereOf } from './report'

const items: ShellNavItem[] = [
  { id: 'messages', name: 'Messages', href: '/messages', active: true },
  { id: 'drive', name: 'Drive', href: '/drive', active: true, match: ['/m/repos'] },
  { id: 'settings', name: 'Settings', href: '/settings', active: true },
]

describe('whereOf (what this tab reports with each beat)', () => {
  it('the dashboard is its own area', () => {
    expect(whereOf(items, '/', null)).toEqual({ area: 'dashboard', path: '/', item: null })
  })

  it('every other page is the sidebar entry it belongs to, with the page’s declared item', () => {
    expect(whereOf(items, '/drive/file/f1', { kind: 'drive_file', id: 'f1' })).toEqual({
      area: 'drive',
      path: '/drive/file/f1',
      item: { kind: 'drive_file', id: 'f1' },
    })
    expect(whereOf(items, '/m/repos/x', null).area).toBe('drive')
  })

  it('a page outside every entry has no area', () => {
    expect(whereOf(items, '/profile', null)).toEqual({ area: null, path: '/profile', item: null })
  })
})
