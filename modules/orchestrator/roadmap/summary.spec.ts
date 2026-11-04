import { describe, expect, it } from 'vitest'
import { InMemoryRoadmapStore } from './store'
import { summarizeRoadmap } from './summary'

describe('summarizeRoadmap', () => {
  it('counts each column and names the first three items being built', async () => {
    const store = new InMemoryRoadmapStore()
    await store.create({ title: 'P1' })
    await store.create({ title: 'S1', status: 'shipped' })
    for (const [i, title] of ['B1', 'B2', 'B3', 'B4'].entries())
      await store.create({ title, status: 'in_progress', position: i })

    expect(summarizeRoadmap(await store.list())).toEqual({
      planned: 1,
      inProgress: 4,
      shipped: 1,
      building: ['B1', 'B2', 'B3'],
    })
  })

  it('an empty roadmap is all zeros', () => {
    expect(summarizeRoadmap([])).toEqual({ planned: 0, inProgress: 0, shipped: 0, building: [] })
  })
})
