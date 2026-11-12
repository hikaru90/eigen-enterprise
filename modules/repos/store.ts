import type { RepoSnapshot, RepoSummary } from './snapshot-types'

/**
 * Persistence for the GitHub repos plugin (migration 0134): the sealed tokens
 * and the repos they keep in sync. The memory store backs unit tests; the
 * Postgres store (`db-store.ts`) is the live one and claims due repos with
 * `FOR UPDATE SKIP LOCKED`, because both blue-green slots tick.
 */

export type TokenRow = {
  id: string
  githubLogin: string
  /** AES-256-GCM envelope, AAD = id. Never leaves the module. */
  tokenSealed: string
  last4: string
  expiresAt: Date | null
  addedBy: string
  createdAt: Date
  /** Set when the token stopped working; every repo on it stops until it is replaced. */
  lastError: string | null
}

export type SourceRow = {
  id: string
  tokenId: string
  repoId: number
  fullName: string
  defaultBranch: string
  enabled: boolean
  dueAt: Date
  claimedBy: string | null
  claimedUntil: Date | null
  etags: Record<string, string>
  branchHeads: Record<string, string>
  docShas: Record<string, string>
  snapshot: RepoSnapshot | null
  lastSyncedAt: Date | null
  lastError: string | null
  pausedUntil: Date | null
  /** Migration 0135: the assistant's last good summary. */
  summary: RepoSummary | null
  /** Why the latest attempt wrote no summary; with a kept summary it is stale. */
  summaryErrorKind: 'no_model' | 'failed' | null
  summaryError: string | null
  summaryErrorAt: Date | null
  createdAt: Date
}

export type NewSource = Pick<SourceRow, 'tokenId' | 'repoId' | 'fullName' | 'defaultBranch'> & { dueAt: Date }

export type SourcePatch = Partial<Omit<SourceRow, 'id' | 'createdAt'>>
export type TokenPatch = Partial<Pick<TokenRow, 'githubLogin' | 'tokenSealed' | 'last4' | 'expiresAt' | 'lastError'>>

export type ReposStore = {
  insertToken(row: TokenRow): Promise<void>
  token(id: string): Promise<TokenRow | null>
  tokens(): Promise<TokenRow[]>
  updateToken(id: string, patch: TokenPatch): Promise<void>
  /** Deletes the token and (cascade) its repos. */
  deleteToken(id: string): Promise<void>

  sources(): Promise<SourceRow[]>
  source(id: string): Promise<SourceRow | null>
  sourceByRepoId(repoId: number): Promise<SourceRow | null>
  /** Inserts a repo, or re-enables an existing row of the same repo id (same token) with a fresh state. */
  enableSource(s: NewSource): Promise<SourceRow>
  updateSource(id: string, patch: SourcePatch): Promise<void>
  updateSourcesOfToken(tokenId: string, patch: SourcePatch): Promise<void>

  /**
   * Claims up to `limit` enabled repos that are due, not paused, not claimed
   * by a live lease and whose token works, for `leaseMs`. With `onlyId`, just
   * that repo (Sync now) — still only when nobody else holds it.
   */
  claimDue(opts: { owner: string; limit: number; now: Date; leaseMs: number; onlyId?: string }): Promise<SourceRow[]>
}

/** A clean sync state: the next run fetches everything again. */
export const FRESH_STATE = {
  etags: {},
  branchHeads: {},
  docShas: {},
  snapshot: null,
  lastSyncedAt: null,
  lastError: null,
  pausedUntil: null,
  claimedBy: null,
  claimedUntil: null,
  summary: null,
  summaryErrorKind: null,
  summaryError: null,
  summaryErrorAt: null,
} satisfies SourcePatch

const clone = <T>(v: T): T => structuredClone(v)

/** In-memory store for tests. Claims are synchronous, so two tickers never share a row. */
export class InMemoryReposStore implements ReposStore {
  readonly tokenRows = new Map<string, TokenRow>()
  readonly sourceRows = new Map<string, SourceRow>()
  private seq = 0

  async insertToken(row: TokenRow) {
    if (this.tokenRows.has(row.id)) throw new Error(`repo_source_tokens ${row.id} exists`)
    this.tokenRows.set(row.id, clone(row))
  }
  async token(id: string) {
    const t = this.tokenRows.get(id)
    return t ? clone(t) : null
  }
  async tokens() {
    return [...this.tokenRows.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone)
  }
  async updateToken(id: string, patch: TokenPatch) {
    const t = this.tokenRows.get(id)
    if (!t) throw new Error(`repo_source_tokens ${id} not found`)
    this.tokenRows.set(id, { ...t, ...clone(patch) })
  }
  async deleteToken(id: string) {
    this.tokenRows.delete(id)
    for (const [sid, s] of this.sourceRows) if (s.tokenId === id) this.sourceRows.delete(sid)
  }

  async sources() {
    return [...this.sourceRows.values()].sort((a, b) => a.fullName.localeCompare(b.fullName)).map(clone)
  }
  async source(id: string) {
    const s = this.sourceRows.get(id)
    return s ? clone(s) : null
  }
  async sourceByRepoId(repoId: number) {
    const s = [...this.sourceRows.values()].find((r) => r.repoId === repoId)
    return s ? clone(s) : null
  }
  async enableSource(n: NewSource) {
    const existing = [...this.sourceRows.values()].find((r) => r.repoId === n.repoId)
    if (existing) {
      if (existing.tokenId !== n.tokenId) throw new Error(`repo ${n.repoId} belongs to another token`)
      const next = { ...existing, ...FRESH_STATE, fullName: n.fullName, defaultBranch: n.defaultBranch, enabled: true, dueAt: n.dueAt }
      this.sourceRows.set(existing.id, next)
      return clone(next)
    }
    this.seq += 1
    const row: SourceRow = {
      id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`,
      ...n,
      enabled: true,
      ...FRESH_STATE,
      createdAt: new Date(n.dueAt),
    }
    this.sourceRows.set(row.id, row)
    return clone(row)
  }
  async updateSource(id: string, patch: SourcePatch) {
    const s = this.sourceRows.get(id)
    if (!s) throw new Error(`repo_sources ${id} not found`)
    this.sourceRows.set(id, { ...s, ...clone(patch) })
  }
  async updateSourcesOfToken(tokenId: string, patch: SourcePatch) {
    for (const [id, s] of this.sourceRows) if (s.tokenId === tokenId) this.sourceRows.set(id, { ...s, ...clone(patch) })
  }

  async claimDue(opts: { owner: string; limit: number; now: Date; leaseMs: number; onlyId?: string }) {
    const now = opts.now.getTime()
    const due = [...this.sourceRows.values()]
      .filter(
        (s) =>
          s.enabled &&
          (opts.onlyId ? s.id === opts.onlyId : s.dueAt.getTime() <= now) &&
          (s.pausedUntil === null || s.pausedUntil.getTime() <= now) &&
          (s.claimedUntil === null || s.claimedUntil.getTime() < now) &&
          this.tokenRows.get(s.tokenId)?.lastError === null,
      )
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .slice(0, opts.limit)
    for (const s of due) {
      s.claimedBy = opts.owner
      s.claimedUntil = new Date(now + opts.leaseMs)
    }
    return due.map(clone)
  }
}
