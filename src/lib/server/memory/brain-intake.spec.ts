import { describe, expect, it, vi } from 'vitest'
import {
  buildBrainIntake,
  intakeSince,
  loadBrainIntake,
  type BrainIntakeStore,
  type IntakeDocumentGroup,
  type IntakeThoughtGroup,
} from './brain-intake'

const NOW = new Date('2026-11-25T12:00:00.000Z')

const thoughtGroup = (over: Partial<IntakeThoughtGroup>): IntakeThoughtGroup => ({
  captureSource: 'ui',
  author: 'user',
  authorLabel: null,
  day: 0,
  week: 0,
  month: 0,
  all: 0,
  ...over,
})
const docGroup = (
  own: boolean,
  day: number,
  week: number,
  month: number,
  all: number,
): IntakeDocumentGroup => ({
  own,
  day,
  week,
  month,
  all,
})

describe('the brain intake summary (what the brain took in, per source and period)', () => {
  it('windows are rolling: 1, 7 and 30 days back from now', () => {
    expect(intakeSince(NOW)).toEqual({
      day: new Date('2026-11-24T12:00:00.000Z'),
      week: new Date('2026-11-18T12:00:00.000Z'),
      month: new Date('2026-10-26T12:00:00.000Z'),
    })
  })

  it('sums the stored rows per source: same source adds up, each connected agent stays by name, documents own vs shared', () => {
    const intake = buildBrainIntake({
      now: NOW,
      thoughtGroups: [
        thoughtGroup({ captureSource: 'ui', author: 'user', day: 1, week: 2, month: 3, all: 5 }),
        // An agent-authored row is the connected agent, whatever surface queued it.
        thoughtGroup({
          captureSource: 'mcp',
          author: 'agent',
          authorLabel: 'Coder',
          week: 1,
          month: 1,
          all: 2,
        }),
        thoughtGroup({ captureSource: 'api', author: 'agent', authorLabel: 'Coder', all: 1 }),
        thoughtGroup({ captureSource: 'mcp', author: 'agent', authorLabel: 'Scout', all: 4 }),
        thoughtGroup({ captureSource: 'agent', author: 'user', day: 2, week: 2, month: 2, all: 2 }),
        thoughtGroup({ captureSource: null, author: 'user', all: 0 }),
      ],
      documentGroups: [docGroup(true, 0, 1, 1, 3), docGroup(false, 1, 1, 2, 2)],
      recentThoughts: [],
      recentDocuments: [],
      limit: 30,
    })
    expect(intake.asOf).toBe(NOW.toISOString())
    expect(intake.totals).toEqual({ day: 4, week: 7, month: 9, all: 19 })
    // Most first; a source with nothing is left out.
    expect(intake.bySource).toEqual([
      { source: { kind: 'app_input' }, counts: { day: 1, week: 2, month: 3, all: 5 } },
      {
        source: { kind: 'connected_agent', name: 'Scout' },
        counts: { day: 0, week: 0, month: 0, all: 4 },
      },
      {
        source: { kind: 'connected_agent', name: 'Coder' },
        counts: { day: 0, week: 1, month: 1, all: 3 },
      },
      { source: { kind: 'own_document' }, counts: { day: 0, week: 1, month: 1, all: 3 } },
      { source: { kind: 'assistant' }, counts: { day: 2, week: 2, month: 2, all: 2 } },
      { source: { kind: 'shared_document' }, counts: { day: 1, week: 1, month: 2, all: 2 } },
    ])
  })

  it('lists thoughts and documents together, newest first, linked to each item, at most the limit', () => {
    const intake = buildBrainIntake({
      now: NOW,
      thoughtGroups: [],
      documentGroups: [],
      recentThoughts: [
        {
          id: 't1',
          text: 'Acme wants the offer by Friday',
          category: 'task',
          captureSource: 'agent',
          author: 'user',
          authorLabel: null,
          createdAt: new Date('2026-11-25T10:00:00.000Z'),
        },
        {
          id: 't2',
          text: 'x'.repeat(400),
          category: 'idea',
          captureSource: 'mcp',
          author: 'agent',
          authorLabel: 'Coder',
          createdAt: new Date('2026-11-20T10:00:00.000Z'),
        },
      ],
      recentDocuments: [
        {
          id: 'd1',
          own: true,
          ownerName: 'Ony',
          title: 'Call recap Acme',
          createdAt: new Date('2026-11-24T10:00:00.000Z'),
        },
        {
          id: 'd2',
          own: false,
          ownerName: 'Ben',
          title: '',
          createdAt: new Date('2026-11-25T11:00:00.000Z'),
        },
      ],
      limit: 3,
    })
    expect(intake.recent.map((i) => i.id)).toEqual(['d2', 't1', 'd1'])
    expect(intake.recent[0]).toEqual({
      kind: 'document',
      id: 'd2',
      at: '2026-11-25T11:00:00.000Z',
      title: null,
      category: null,
      sharedBy: 'Ben',
      source: { kind: 'shared_document' },
      href: '/m/memory/notes?note=d2',
    })
    expect(intake.recent[1]).toEqual({
      kind: 'thought',
      id: 't1',
      at: '2026-11-25T10:00:00.000Z',
      title: 'Acme wants the offer by Friday',
      category: 'task',
      sharedBy: null,
      source: { kind: 'assistant' },
      href: '/m/memory/capture?thought=t1',
    })
    expect(intake.recent[2]).toMatchObject({ source: { kind: 'own_document' }, sharedBy: null })
  })

  it('shortens a long thought to a title line', () => {
    const intake = buildBrainIntake({
      now: NOW,
      thoughtGroups: [],
      documentGroups: [],
      recentThoughts: [
        {
          id: 't2',
          text: `${'word '.repeat(60)}`,
          category: 'idea',
          captureSource: 'ui',
          author: 'user',
          authorLabel: null,
          createdAt: NOW,
        },
      ],
      recentDocuments: [],
      limit: 30,
    })
    const title = intake.recent[0]!.title!
    expect(title.length).toBeLessThanOrEqual(161)
    expect(title.endsWith('…')).toBe(true)
  })

  it('loads everything as the reader, with the same windows and limit for every query', async () => {
    const store: BrainIntakeStore = {
      thoughtGroups: vi.fn(async () => []),
      documentGroups: vi.fn(async () => []),
      recentThoughts: vi.fn(async () => []),
      recentDocuments: vi.fn(async () => []),
    }
    const intake = await loadBrainIntake('ony', { limit: 12, now: NOW }, store)
    const since = intakeSince(NOW)
    expect(store.thoughtGroups).toHaveBeenCalledWith('ony', since)
    expect(store.documentGroups).toHaveBeenCalledWith('ony', since)
    expect(store.recentThoughts).toHaveBeenCalledWith('ony', 12)
    expect(store.recentDocuments).toHaveBeenCalledWith('ony', 12)
    expect(intake).toEqual({
      asOf: NOW.toISOString(),
      totals: { day: 0, week: 0, month: 0, all: 0 },
      bySource: [],
      recent: [],
    })
  })
})
