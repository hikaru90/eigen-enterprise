import { describe, expect, it } from 'vitest'
import { activityCallRows, groupActivityCalls, type ActivityCallRow } from './activity-calls'

const call = (over: Partial<ActivityCallRow> & { id: string }): ActivityCallRow => ({
  provider: 'openrouter',
  gatewayHost: null,
  operation: 'chat',
  context: null,
  baseCostUsd: '0',
  markupUsd: '0',
  totalCostUsd: '0',
  groupId: null,
  durationMs: null,
  createdAt: '2026-11-20T10:00:00Z',
  ...over,
})

const calls: ActivityCallRow[] = [
  call({
    id: 'a',
    groupId: 'g1',
    operation: 'zeta',
    durationMs: 300,
    totalCostUsd: '0.5',
    createdAt: '2026-11-20T10:00:02Z',
  }),
  call({
    id: 'b',
    operation: 'alpha',
    durationMs: 100,
    totalCostUsd: '0.1',
    createdAt: '2026-11-20T09:00:00Z',
  }),
  call({
    id: 'c',
    groupId: 'g1',
    operation: 'mid',
    durationMs: null,
    totalCostUsd: '2',
    createdAt: '2026-11-20T10:00:01Z',
  }),
  call({
    id: 'd',
    provider: 'agent',
    operation: 'beta',
    durationMs: 50,
    totalCostUsd: '0',
    createdAt: '2026-11-21T08:00:00Z',
  }),
]

const ids = (rows: { calls: ActivityCallRow[] }[]) => rows.map((r) => r.calls.map((c) => c.id))

describe('groupActivityCalls', () => {
  it('groups by groupId in first-seen order, calls inside a group oldest first', () => {
    expect(ids(groupActivityCalls(calls))).toEqual([['c', 'a'], ['b'], ['d']])
  })
})

describe('activityCallRows', () => {
  it('keeps the grouped view when no column is sorted', () => {
    const rows = activityCallRows(calls, null)
    expect(ids(rows)).toEqual([['c', 'a'], ['b'], ['d']])
    expect(rows[0].groupId).toBe('g1')
    expect(rows[0].groupTotalUsd).toBe('2.500000')
  })

  it('flattens the groups into one row per call when a column is sorted', () => {
    const rows = activityCallRows(calls, { key: 'operation', dir: 'asc' })
    expect(ids(rows)).toEqual([['b'], ['d'], ['c'], ['a']])
    expect(rows.every((r) => r.calls.length === 1)).toBe(true)
    expect(new Set(rows.map((r) => r.key)).size).toBe(4)
  })

  it('sorts by when, credits and provider', () => {
    expect(ids(activityCallRows(calls, { key: 'when', dir: 'desc' }))).toEqual([
      ['d'],
      ['a'],
      ['c'],
      ['b'],
    ])
    expect(ids(activityCallRows(calls, { key: 'credits', dir: 'desc' }))).toEqual([
      ['c'],
      ['a'],
      ['b'],
      ['d'],
    ])
    expect(ids(activityCallRows(calls, { key: 'provider', dir: 'asc' })).map((r) => r[0])).toEqual([
      'd',
      'a',
      'b',
      'c',
    ])
  })

  it('puts calls without a duration last in both directions', () => {
    expect(ids(activityCallRows(calls, { key: 'duration', dir: 'asc' }))).toEqual([
      ['d'],
      ['b'],
      ['a'],
      ['c'],
    ])
    expect(ids(activityCallRows(calls, { key: 'duration', dir: 'desc' }))).toEqual([
      ['a'],
      ['b'],
      ['d'],
      ['c'],
    ])
  })
})
