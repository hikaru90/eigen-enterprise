import { describe, expect, it } from 'vitest'
import { ariaSort, nextSort, sortRows } from './sort'

type R = { n: string | null; c: number | null; d: Date | null }
const rows: R[] = [
  { n: 'b10', c: 2, d: new Date('2026-02-01') },
  { n: null, c: null, d: null },
  { n: 'b2', c: 10, d: new Date('2025-01-01') },
  { n: 'A', c: 1, d: new Date('2026-01-01') },
]
const acc = { n: (r: R) => r.n, c: (r: R) => r.c, d: (r: R) => r.d }

describe('nextSort', () => {
  it('cycles asc, desc, off and restarts on another column', () => {
    const a = nextSort(null, 'n')
    expect(a).toEqual({ key: 'n', dir: 'asc' })
    const b = nextSort(a, 'n')
    expect(b).toEqual({ key: 'n', dir: 'desc' })
    expect(nextSort(b, 'n')).toBeNull()
    expect(nextSort(b, 'c')).toEqual({ key: 'c', dir: 'asc' })
  })
  it('reports aria-sort', () => {
    expect(ariaSort({ key: 'n', dir: 'desc' }, 'n')).toBe('descending')
    expect(ariaSort({ key: 'n', dir: 'asc' }, 'n')).toBe('ascending')
    expect(ariaSort({ key: 'n', dir: 'asc' }, 'c')).toBe('none')
    expect(ariaSort(null, 'n')).toBe('none')
  })
})

describe('sortRows', () => {
  it('keeps the original order for no sort, without mutating', () => {
    const out = sortRows(rows, null, acc)
    expect(out).toEqual(rows)
    expect(out).not.toBe(rows)
  })
  it('sorts text locale-aware and naturally, empty last', () => {
    expect(sortRows(rows, { key: 'n', dir: 'asc' }, acc).map((r) => r.n)).toEqual([
      'A',
      'b2',
      'b10',
      null,
    ])
    expect(sortRows(rows, { key: 'n', dir: 'desc' }, acc).map((r) => r.n)).toEqual([
      'b10',
      'b2',
      'A',
      null,
    ])
  })
  it('sorts numbers numerically, empty last in both directions', () => {
    expect(sortRows(rows, { key: 'c', dir: 'asc' }, acc).map((r) => r.c)).toEqual([1, 2, 10, null])
    expect(sortRows(rows, { key: 'c', dir: 'desc' }, acc).map((r) => r.c)).toEqual([10, 2, 1, null])
  })
  it('sorts dates chronologically', () => {
    expect(sortRows(rows, { key: 'd', dir: 'asc' }, acc).map((r) => r.n)).toEqual([
      'b2',
      'A',
      'b10',
      null,
    ])
  })
  it('is stable for ties', () => {
    const t = [
      { k: 1, id: 'x' },
      { k: 1, id: 'y' },
    ]
    expect(
      sortRows(t, { key: 'k', dir: 'desc' }, { k: (r: (typeof t)[0]) => r.k }).map((r) => r.id),
    ).toEqual(['x', 'y'])
  })
})
