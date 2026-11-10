import type { ContributionArea, ContributionKind, ContributionStatus } from './types'

/** A stored proposal (the row, without votes). */
export type Contribution = {
  id: string
  title: string
  kind: ContributionKind
  area: ContributionArea
  status: ContributionStatus
  authorId: string
  note: string | null
  createdAt: Date
  updatedAt: Date
  shippedAt: Date | null
}

export type ContributionWithVotes = Contribution & {
  score: number
  /** Keyed by user id: that person's vote (+1 / -1). */
  votes: Map<string, 1 | -1>
}

export type ContributionPatch = {
  status?: ContributionStatus
  note?: string | null
  shippedAt?: Date | null
  updatedAt: Date
}

/** Persistence seam: the DB store in production, the in-memory one in unit tests. */
export type ContributeStore = {
  /** Insert the proposal together with its author's +1. */
  insert(c: Contribution): Promise<void>
  get(id: string): Promise<ContributionWithVotes | null>
  /** Every proposal in one of the statuses, newest first. */
  list(statuses: readonly ContributionStatus[]): Promise<ContributionWithVotes[]>
  update(id: string, patch: ContributionPatch): Promise<void>
  /** direction 0 removes the vote. */
  setVote(id: string, userId: string, direction: -1 | 0 | 1): Promise<void>
}

/** Display names of the people in the company. */
export type Directory = {
  names(): Promise<Map<string, string>>
}
