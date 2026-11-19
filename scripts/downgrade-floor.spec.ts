import { describe, expect, it } from 'vitest'
import { downgradeFloor, MIN_DOWNGRADE_RELEASE } from './downgrade-floor.mjs'

const tags = ['0.5.19', '0.5.20', '0.5.21', '0.5.22', '0.5.23']

describe('downgradeFloor (the oldest release this one can be replaced with)', () => {
  it('goes back to the first release that installs exactly its target (ee 0.5.20) when nothing persistent changed', () => {
    expect(MIN_DOWNGRADE_RELEASE).toBe('0.5.20')
    expect(downgradeFloor({ version: '0.5.24', tags, changedSince: () => false })).toBe('0.5.20')
  })

  it('stops at a migration or an ee state change: older code must not run on what it cannot read', () => {
    // 0.5.22 → HEAD changed nothing; 0.5.21 → HEAD added a migration.
    const changed = new Set(['0.5.19', '0.5.20', '0.5.21'])
    expect(downgradeFloor({ version: '0.5.24', tags, changedSince: (t) => changed.has(t) })).toBe('0.5.22')
  })

  it('a change since the previous release means no downgrade: the floor is this release', () => {
    expect(downgradeFloor({ version: '0.5.24', tags, changedSince: () => true })).toBe('0.5.24')
  })

  it('ignores its own tag and newer ones, whatever order git lists them in', () => {
    expect(downgradeFloor({ version: '0.5.22', tags: ['0.5.24', '0.5.22', '0.5.21', '0.5.23', '0.5.20'], changedSince: () => false })).toBe('0.5.20')
  })
})
