import type { ContributionArea, ContributionKind, ContributionStatus } from '../contribute/types'
import { HUB_STATUS_ORDER, type HubProposalDto } from './types'

/** One group on the "All installs" tab: the proposals of one status, kind and area across installs. */
export type HubGroup = {
  key: string
  status: ContributionStatus
  kind: ContributionKind
  area: ContributionArea
  /** How many different installs shared a proposal in this group. */
  installs: number
  /** Net votes summed over the group. */
  score: number
  /** Highest score first. */
  proposals: HubProposalDto[]
}

/** Pure (browser and server): status in board order, then the most wanted group first. */
export function groupHubProposals(proposals: readonly HubProposalDto[]): HubGroup[] {
  const byKey = new Map<string, HubProposalDto[]>()
  for (const p of proposals) {
    const key = `${p.status}/${p.kind}/${p.area}`
    byKey.set(key, [...(byKey.get(key) ?? []), p])
  }
  const groups: HubGroup[] = [...byKey.entries()].map(([key, ps]) => ({
    key,
    status: ps[0]!.status,
    kind: ps[0]!.kind,
    area: ps[0]!.area,
    installs: new Set(ps.map((p) => p.installId)).size,
    score: ps.reduce((sum, p) => sum + p.score, 0),
    proposals: [...ps].sort((a, b) => b.score - a.score),
  }))
  return groups.sort(
    (a, b) =>
      HUB_STATUS_ORDER.indexOf(a.status) - HUB_STATUS_ORDER.indexOf(b.status) || b.score - a.score || a.key.localeCompare(b.key),
  )
}
