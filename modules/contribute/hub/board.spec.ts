import type { HubProposalDto } from './types'
import { describe, expect, it } from 'vitest'
import { groupHubProposals } from './board'

const dto = (over: Partial<HubProposalDto>): HubProposalDto => ({
  installId: 'i1',
  remoteId: 'r1',
  summary: 'Dark mode',
  language: 'en',
  kind: 'idea',
  area: 'everywhere',
  status: 'requested',
  score: 1,
  appVersion: '0.6.0',
  createdDay: '2026-11-12',
  shippedDay: null,
  updatedAt: '2026-11-13T10:00:00Z',
  receivedAt: '2026-11-13T10:00:00Z',
  ...over,
})

describe('groupHubProposals', () => {
  it('groups by status, then kind and area: install count and summed score, highest first', () => {
    const groups = groupHubProposals([
      dto({ remoteId: 'a', installId: 'i1', score: 2 }),
      dto({ remoteId: 'b', installId: 'i2', score: 3 }),
      dto({ remoteId: 'c', installId: 'i2', score: 1 }),
      dto({ remoteId: 'd', installId: 'i3', kind: 'bug', area: 'drive', score: 9 }),
      dto({ remoteId: 'e', installId: 'i1', status: 'shipped', score: 4 }),
      dto({ remoteId: 'f', installId: 'i1', status: 'in_progress', kind: 'polish', area: 'settings', score: -1 }),
    ])
    expect(groups.map((g) => [g.status, g.kind, g.area, g.installs, g.score, g.proposals.map((p) => p.remoteId)])).toEqual([
      ['requested', 'bug', 'drive', 1, 9, ['d']],
      ['requested', 'idea', 'everywhere', 2, 6, ['b', 'a', 'c']],
      ['in_progress', 'polish', 'settings', 1, -1, ['f']],
      ['shipped', 'idea', 'everywhere', 1, 4, ['e']],
    ])
  })

  it('an empty board has no groups', () => {
    expect(groupHubProposals([])).toEqual([])
  })
})
