import { describe, expect, it } from 'vitest'
import { drivePaths, safeSegment } from './files'

describe('drivePaths', () => {
  it('puts each file under its real folder tree', () => {
    const paths = drivePaths(
      [
        { id: 'f1', parent_id: null, name: 'Team' },
        { id: 'f2', parent_id: 'f1', name: 'Plans' },
      ],
      [
        { id: 'a', folder_id: 'f2', name: 'Q4.pdf' },
        { id: 'b', folder_id: null, name: 'root.txt' },
      ],
    )
    expect(Object.fromEntries(paths)).toEqual({ a: 'Team/Plans/Q4.pdf', b: 'root.txt' })
  })

  it('keeps two files with one name apart instead of overwriting', () => {
    const paths = drivePaths([{ id: 'f', parent_id: null, name: 'X' }], [
      { id: '1', folder_id: 'f', name: 'notes.md' },
      { id: '2', folder_id: 'f', name: 'Notes.md' },
      { id: '3', folder_id: 'f', name: 'notes.md' },
    ])
    expect([...paths.values()]).toEqual(['X/notes.md', 'X/Notes (2).md', 'X/notes (3).md'])
  })

  it('fails loud on a missing parent folder or a loop', () => {
    expect(() => drivePaths([], [{ id: 'a', folder_id: 'gone', name: 'x' }])).toThrow('Drive folder gone is missing')
    expect(() =>
      drivePaths([{ id: 'l', parent_id: 'l', name: 'loop' }], [{ id: 'a', folder_id: 'l', name: 'x' }]),
    ).toThrow('inside itself')
  })
})

describe('safeSegment', () => {
  it('keeps names, only unsafe characters change', () => {
    expect(safeSegment('Plan Q4 – final.pdf')).toBe('Plan Q4 – final.pdf')
    expect(safeSegment('a/b\\c')).toBe('a_b_c')
    expect(safeSegment('..')).toBe('_')
    expect(safeSegment('  ')).toBe('_')
  })
})
