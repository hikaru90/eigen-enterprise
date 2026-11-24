// Client-side column sorting: a pure view-state helper. The caller names the
// sort value of every column explicitly (structure, no guessing from cell text).
export type SortDir = 'asc' | 'desc'
export type SortState<K extends string = string> = { key: K; dir: SortDir } | null
export type SortValue = string | number | Date | null | undefined
export type SortAccessors<R, K extends string> = Record<K, (row: R) => SortValue>

/** asc -> desc -> off (original order); a different column starts at asc. */
export function nextSort<K extends string>(state: SortState<K>, key: K): SortState<K> {
  if (!state || state.key !== key) return { key, dir: 'asc' }
  return state.dir === 'asc' ? { key, dir: 'desc' } : null
}

export function ariaSort<K extends string>(
  state: SortState<K>,
  key: K,
): 'ascending' | 'descending' | 'none' {
  if (!state || state.key !== key) return 'none'
  return state.dir === 'asc' ? 'ascending' : 'descending'
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function isEmpty(v: SortValue): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'number') return Number.isNaN(v)
  if (v instanceof Date) return Number.isNaN(v.getTime())
  return v === ''
}

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  return collator.compare(String(a), String(b))
}

/** Returns a new array; the original order is kept for a null state and for ties. Empty values go last in both directions. */
export function sortRows<R, K extends string>(
  rows: readonly R[],
  state: SortState<K>,
  accessors: SortAccessors<R, K>,
): R[] {
  if (!state) return [...rows]
  const get = accessors[state.key]
  const sign = state.dir === 'asc' ? 1 : -1
  return rows
    .map((row, i) => ({ row, i, v: get(row) }))
    .sort((x, y) => {
      const ex = isEmpty(x.v)
      const ey = isEmpty(y.v)
      if (ex || ey) return ex === ey ? x.i - y.i : ex ? 1 : -1
      return sign * compare(x.v, y.v) || x.i - y.i
    })
    .map((e) => e.row)
}
