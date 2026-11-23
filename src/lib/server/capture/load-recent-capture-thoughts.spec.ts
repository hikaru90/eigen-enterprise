import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadRecentCaptureThoughts } from './load-recent-capture-thoughts'

const { listMock, loadResultMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  loadResultMock: vi.fn(),
}))

vi.mock('$lib/server/capture/service', () => ({
  listThoughts: listMock,
}))

vi.mock('$lib/server/capture/capture-result', () => ({
  loadThoughtCaptureResult: loadResultMock,
}))

describe('loadRecentCaptureThoughts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps recent snippets and loads capture details', async () => {
    listMock.mockResolvedValue([
      {
        id: 't1',
        normalizedText: 'hello',
        category: 'observation',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        author: 'user',
        authorLabel: null,
        captureSource: 'agent',
      },
    ])
    loadResultMock.mockResolvedValue({ thoughtId: 't1', ok: true })

    const payload = await loadRecentCaptureThoughts('u1', 3, {
      author: 'user',
      category: 'observation',
    })

    expect(listMock).toHaveBeenCalledWith('u1', {
      fields: 'snippet',
      limit: 3,
      authorFilter: 'user',
      authorLayerKey: undefined,
      categoryFilter: 'observation',
      dateFrom: undefined,
      dateTo: undefined,
    })
    expect(payload.recentThoughts).toEqual([
      {
        id: 't1',
        normalizedText: 'hello',
        category: 'observation',
        createdAt: '2026-01-01T00:00:00.000Z',
        author: 'user',
        authorLabel: null,
        source: 'agent',
      },
    ])
    expect(payload.recentThoughtDetails).toEqual([{ thoughtId: 't1', ok: true }])
  })

  it('says the source was not recorded (null) on rows from before capture_source existed', async () => {
    listMock.mockResolvedValue([
      { id: 't2', normalizedText: 'old', category: 'idea', createdAt: new Date('2025-01-01T00:00:00.000Z'), author: 'user', authorLabel: null, captureSource: null },
    ])
    loadResultMock.mockResolvedValue({ thoughtId: 't2', ok: true })
    const payload = await loadRecentCaptureThoughts('u1')
    expect(payload.recentThoughts[0]?.source).toBeNull()
  })
})
