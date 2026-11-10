import type { ContributionArea, ContributionCheck, ContributionDto, ContributionKind, ContributionStatus, MyVote } from '../../../modules/contribute/types'

/**
 * The browser's calls to /api/contribute. Every failure throws with the
 * server's own message (no silent fallbacks).
 */

export type ContributeClient = {
  check(title: string): Promise<ContributionCheck>
  share(draft: { title: string; kind: ContributionKind; area: ContributionArea }): Promise<ContributionDto>
  vote(id: string, direction: MyVote): Promise<ContributionDto>
  update(id: string, patch: { status?: ContributionStatus; note?: string | null }): Promise<ContributionDto>
  list(): Promise<{ proposals: ContributionDto[]; canManage: boolean }>
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

async function call<T>(fetchFn: Fetch, url: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await fetchFn(url, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
  })
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) throw new Error(body?.error ?? `Request failed (HTTP ${res.status}).`)
  if (body === null) throw new Error(`Empty answer from ${url} (HTTP ${res.status}).`)
  return body
}

export function contributeClient(fetchFn: Fetch = (input, init) => fetch(input, init)): ContributeClient {
  return {
    check: (title) => call<ContributionCheck>(fetchFn, '/api/contribute/check', { method: 'POST', body: { title } }),
    share: async (draft) => (await call<{ proposal: ContributionDto }>(fetchFn, '/api/contribute', { method: 'POST', body: draft })).proposal,
    vote: async (id, direction) =>
      (await call<{ proposal: ContributionDto }>(fetchFn, `/api/contribute/${encodeURIComponent(id)}/vote`, { method: 'POST', body: { direction } })).proposal,
    update: async (id, patch) =>
      (await call<{ proposal: ContributionDto }>(fetchFn, `/api/contribute/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })).proposal,
    list: () => call<{ proposals: ContributionDto[]; canManage: boolean }>(fetchFn, '/api/contribute'),
  }
}
