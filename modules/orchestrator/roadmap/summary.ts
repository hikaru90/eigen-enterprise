import type { RoadmapItem } from './store'

export type RoadmapSummary = {
  planned: number
  inProgress: number
  shipped: number
  /** Titles of what is being built now (first three, in board order). */
  building: string[]
}

/** The pinned Roadmap card in Memory → Projects: column counts and what is being built. */
export function summarizeRoadmap(items: readonly RoadmapItem[]): RoadmapSummary {
  const inProgress = items.filter((item) => item.status === 'in_progress')
  return {
    planned: items.filter((item) => item.status === 'planned').length,
    inProgress: inProgress.length,
    shipped: items.filter((item) => item.status === 'shipped').length,
    building: inProgress.slice(0, 3).map((item) => item.title),
  }
}
