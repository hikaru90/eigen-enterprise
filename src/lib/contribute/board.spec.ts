import type { ContributionDto } from '../../../modules/contribute/types'
import { describe, expect, it } from 'vitest'
import { inTab, nextVote, tabCounts } from './board'

const p = (id: string, status: ContributionDto['status']) => ({ id, status }) as ContributionDto

describe('board helpers', () => {
  const all = [p('a', 'requested'), p('b', 'shipped'), p('c', 'requested'), p('d', 'in_progress'), p('e', 'declined')]

  it('splits into tabs in server order and counts them; declined is on no tab', () => {
    expect(inTab(all, 'requested').map((x) => x.id)).toEqual(['a', 'c'])
    expect(tabCounts(all)).toEqual({ requested: 2, in_progress: 1, shipped: 1 })
  })

  it('a second click on the same arrow takes the vote back', () => {
    expect(nextVote(0, 1)).toBe(1)
    expect(nextVote(1, 1)).toBe(0)
    expect(nextVote(1, -1)).toBe(-1)
    expect(nextVote(-1, -1)).toBe(0)
  })
})
