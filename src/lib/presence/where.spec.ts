import { describe, expect, it } from 'vitest'
import { parseWhereReport, sameWhere } from './where'

describe('parseWhereReport', () => {
  it('accepts an area, a pathname and a declared item', () => {
    expect(parseWhereReport({ area: 'drive', path: '/drive/file/f1', item: { kind: 'drive_file', id: 'f1' } })).toEqual({
      area: 'drive',
      path: '/drive/file/f1',
      item: { kind: 'drive_file', id: 'f1' },
    })
  })

  it('accepts the dashboard and pages outside the sidebar', () => {
    expect(parseWhereReport({ area: 'dashboard', path: '/', item: null }).area).toBe('dashboard')
    expect(parseWhereReport({ area: null, path: '/welcome', item: null }).area).toBeNull()
  })

  it('refuses a query or hash in the path, a missing item and unknown kinds', () => {
    expect(() => parseWhereReport({ area: 'messages', path: '/messages?c=1', item: null })).toThrow(/pathname/)
    expect(() => parseWhereReport({ area: 'messages', path: '/messages' })).toThrow(/item/)
    expect(() => parseWhereReport({ area: 'drive', path: '/drive', item: { kind: 'secret', id: 'x' } })).toThrow(/kind/)
    expect(() => parseWhereReport({ area: 'Drive!', path: '/drive', item: null })).toThrow(/area/)
    expect(() => parseWhereReport(null)).toThrow(/object/)
  })
})

describe('sameWhere', () => {
  it('compares area, path and item', () => {
    const a = { area: 'drive', path: '/drive', item: null }
    expect(sameWhere(a, { ...a })).toBe(true)
    expect(sameWhere(a, { ...a, item: { kind: 'drive_folder', id: 'x' } })).toBe(false)
    expect(sameWhere(a, null)).toBe(false)
    expect(sameWhere(null, null)).toBe(true)
  })
})
