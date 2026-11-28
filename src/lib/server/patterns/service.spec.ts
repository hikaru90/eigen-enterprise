import type { PatternDigest } from './digest'
import { describe, expect, it, vi } from 'vitest'
import { patternDigestDue, patternsFor, refreshPatternDigest, type PatternDeps } from './service'

const now = new Date('2026-11-28T12:00:00Z')

function deps(over: Partial<PatternDeps> = {}): PatternDeps & { saved: PatternDigest[] } {
  const saved: PatternDigest[] = []
  return {
    saved,
    now: () => now,
    events: async () => [
      { principalId: 'anna', tool: 'drive.rename', at: new Date('2026-11-27T09:00:00Z') },
      { principalId: 'anna', tool: 'members.set_role', at: new Date('2026-11-27T09:00:00Z') },
    ],
    catalog: (tool) =>
      tool === 'drive.rename'
        ? { module: 'drive', roles: ['admin', 'member'] }
        : tool === 'members.set_role'
          ? { module: 'members', roles: ['admin'] }
          : null,
    personNames: async () => new Map([['anna', 'Anna']]),
    moduleLabel: (m) => m,
    write: async () =>
      JSON.stringify({ sentences: { 'anna:drive': 'Anna renamed one file in Drive.', 'anna:members': 'Anna changed one role.' } }),
    latest: async () => saved.at(-1) ?? null,
    save: async (d) => {
      const digest = { ...d, id: `d${saved.length + 1}`, createdAt: now }
      saved.push(digest)
      return digest
    },
    ...over,
  }
}

describe('refreshPatternDigest', () => {
  it('writes once and stores the items over the last 7 days', async () => {
    const write = vi.fn(deps().write)
    const events = vi.fn(deps().events)
    const d = deps({ write, events })
    const digest = await refreshPatternDigest(d)
    expect(write).toHaveBeenCalledTimes(1)
    expect(events).toHaveBeenCalledWith(new Date('2026-11-21T12:00:00Z'))
    expect(digest.items.map((i) => i.text)).toEqual(['Anna renamed one file in Drive.', 'Anna changed one role.'])
    expect(d.saved).toHaveLength(1)
  })

  it('makes no model call when nothing happened', async () => {
    const write = vi.fn()
    const digest = await refreshPatternDigest(deps({ events: async () => [], write }))
    expect(write).not.toHaveBeenCalled()
    expect(digest.items).toEqual([])
  })
})

describe('patternsFor', () => {
  it('each viewer gets only what they may see, without a new model call', async () => {
    const write = vi.fn(deps().write)
    const d = deps({ write })
    await refreshPatternDigest(d)
    const member = await patternsFor(d, { roles: ['member'], moduleActive: () => true })
    const admin = await patternsFor(d, { roles: ['admin', 'member'], moduleActive: () => true })
    expect(member.items.map((i) => i.id)).toEqual(['anna:drive'])
    expect(admin.items).toHaveLength(2)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('says there is no digest yet', async () => {
    expect(await patternsFor(deps(), { roles: ['member'], moduleActive: () => true })).toMatchObject({ digestId: null, items: [] })
  })
})

describe('patternDigestDue', () => {
  it('is due without a digest and once the latest is a day old', async () => {
    expect(await patternDigestDue({ now: () => now, latest: async () => null })).toBe(true)
    const digest = (createdAt: Date): PatternDigest => ({ id: 'x', createdAt, windowStart: now, windowEnd: now, items: [] })
    expect(await patternDigestDue({ now: () => now, latest: async () => digest(new Date('2026-11-28T00:00:00Z')) })).toBe(false)
    expect(await patternDigestDue({ now: () => now, latest: async () => digest(new Date('2026-11-27T11:00:00Z')) })).toBe(true)
  })
})
