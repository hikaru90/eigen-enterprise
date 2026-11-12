import type { SourceRow, TokenRow } from './store'
import { randomUUID } from 'node:crypto'
import type { TokenIdentity, TokenRepo } from '$lib/server/github/token-client'
import { CLASSIC_TOKEN_MESSAGE, isGitHubTokenError, ReposError, tokenMessages } from './errors'
import { REPOS_DRIVE_SOURCE } from './manifest'
import { repoKey } from './render'
import { last4, sealToken, unsealToken } from './seal'
import { FRESH_STATE } from './store'
import { firstSentence } from './summary'
import { reposTickWith, removeRepoFolder, syncClaimed, CLAIM_LEASE_MS, type SyncDeps, type SyncOutcome, type TickResult } from './sync'

/**
 * The GitHub repos plugin's operations (plan/github-drive.md §1, §2, §6).
 * The token methods are for the admin-only page only — the token never
 * passes through a kernel tool, the chat or an approval. Tools get `list` and
 * `syncNow`, which never touch it.
 */

export const EXPIRY_WARNING_DAYS = 7
const DAY_MS = 86_400_000

export type SourceView = {
  id: string
  repoId: number
  fullName: string
  defaultBranch: string
  lastSyncedAt: Date | null
  nextDueAt: Date
  lastError: string | null
  pausedUntil: Date | null
  /** The repo's Drive folder; null until the first sync wrote it. */
  driveFolderId: string | null
  /** The assistant's summary: when it was written, and why the latest attempt wrote none. */
  summary: SummaryView
}

export type SummaryView = {
  writtenAt: Date | null
  /** A summary exists but the latest attempt to update it wrote none. */
  stale: boolean
  problem: { kind: 'no_model' | 'failed'; message: string; at: Date } | null
}

/** One line of the assistant's "Connected GitHub repos" prompt block. */
export type RepoBrief = {
  fullName: string
  lastPushAt: Date | null
  openPulls: number
  /** The first sentence of the assistant's summary; null without one. */
  summaryFirstSentence: string | null
  summaryStale: boolean
  driveFolderId: string | null
}

/** At most this many repos in the prompt block. */
export const BRIEFS_MAX = 20

export type TokenView = {
  id: string
  login: string
  last4: string
  expiresAt: Date | null
  expiresSoon: boolean
  expired: boolean
  lastError: string | null
  addedBy: string
  createdAt: Date
  repos: SourceView[]
}

export type VisibleRepo = TokenRepo & { syncing: boolean; sourceId: string | null }

export type ReposService = {
  tokens(): Promise<TokenView[]>
  /** Live: every repo the token can see, with whether it syncs. */
  visibleRepos(tokenId: string): Promise<VisibleRepo[]>
  addToken(addedBy: string, token: string): Promise<{ id: string; login: string }>
  replaceToken(tokenId: string, token: string): Promise<{ login: string }>
  /** Deletes the token, stops its repos and deletes their Drive folders. */
  removeToken(tokenId: string): Promise<{ removedRepos: number }>
  /** Tick (sync it) or untick (stop and delete its Drive folder) a repo the token can see. */
  setRepo(tokenId: string, repoId: number, syncing: boolean): Promise<{ fullName: string }>
  /** Makes the repo due now and syncs it right away unless another process holds it. */
  syncNow(ref: { sourceId: string } | { repo: string }): Promise<{ fullName: string; outcome: SyncOutcome | { status: 'queued' } }>
  /** Connected repos and their status (for repos.list). */
  list(): Promise<SourceView[]>
  /** Synced repos for the assistant's prompt block: most recently pushed first, at most BRIEFS_MAX. */
  briefs(): Promise<RepoBrief[]>
  tick(): Promise<TickResult>
}

export function createReposService(deps: SyncDeps): ReposService {
  const { store, drive } = deps

  async function check(token: string): Promise<TokenIdentity> {
    const t = token.trim()
    if (!t) throw new ReposError('Paste the token from GitHub.')
    if (/\s/.test(t)) throw new ReposError('The token has spaces or line breaks in it. Copy it again from GitHub.')
    let id: TokenIdentity
    try {
      id = await deps.client(t).identity()
    } catch (err) {
      if (isGitHubTokenError(err) && err.kind === 'unauthorized')
        throw new ReposError('GitHub did not accept this token. Check that you copied all of it.', { cause: err })
      if (isGitHubTokenError(err)) throw new ReposError('GitHub did not answer. Try again in a minute.', { cause: err })
      throw err
    }
    if (id.classic) throw new ReposError(CLASSIC_TOKEN_MESSAGE)
    if (id.expiresAt && id.expiresAt.getTime() <= deps.now().getTime())
      throw new ReposError('This token has already expired. Create a new one on GitHub.')
    return id
  }

  async function requireToken(id: string): Promise<TokenRow> {
    const t = await store.token(id)
    if (!t) throw new ReposError('That token is no longer connected.')
    return t
  }

  async function folderIds(): Promise<Map<string, string>> {
    return new Map((await drive.list(REPOS_DRIVE_SOURCE)).map((i) => [i.key, i.itemId]))
  }

  function sourceView(s: SourceRow, folders: Map<string, string>): SourceView {
    return {
      id: s.id,
      repoId: s.repoId,
      fullName: s.fullName,
      defaultBranch: s.defaultBranch,
      lastSyncedAt: s.lastSyncedAt,
      nextDueAt: s.dueAt,
      lastError: s.lastError,
      pausedUntil: s.pausedUntil,
      driveFolderId: folders.get(repoKey(s.repoId)) ?? null,
      summary: summaryView(s),
    }
  }

  function summaryView(s: SourceRow): SummaryView {
    const problem =
      s.summaryErrorKind && s.summaryError && s.summaryErrorAt ? { kind: s.summaryErrorKind, message: s.summaryError, at: s.summaryErrorAt } : null
    return { writtenAt: s.summary ? new Date(s.summary.writtenAt) : null, stale: s.summary !== null && problem !== null, problem }
  }

  async function visible(token: TokenRow): Promise<TokenRepo[]> {
    try {
      return await deps.client(unsealToken(token.tokenSealed, deps.key(), token.id)).repos()
    } catch (err) {
      if (isGitHubTokenError(err) && err.kind === 'unauthorized')
        throw new ReposError(`The GitHub token for ${token.githubLogin} no longer works. Replace it with a new one.`, { cause: err })
      if (isGitHubTokenError(err)) throw new ReposError('GitHub did not answer. Try again in a minute.', { cause: err })
      throw err
    }
  }

  return {
    async tokens() {
      const now = deps.now().getTime()
      const [tokens, sources, folders] = await Promise.all([store.tokens(), store.sources(), folderIds()])
      return tokens.map((t) => {
        const left = t.expiresAt ? t.expiresAt.getTime() - now : null
        return {
          id: t.id,
          login: t.githubLogin,
          last4: t.last4,
          expiresAt: t.expiresAt,
          expired: left !== null && left <= 0,
          expiresSoon: left !== null && left > 0 && left <= EXPIRY_WARNING_DAYS * DAY_MS,
          lastError: t.lastError,
          addedBy: t.addedBy,
          createdAt: t.createdAt,
          repos: sources.filter((s) => s.tokenId === t.id && s.enabled).map((s) => sourceView(s, folders)),
        }
      })
    },

    async visibleRepos(tokenId) {
      const token = await requireToken(tokenId)
      const sources = await store.sources()
      return (await visible(token))
        .map((r) => {
          const s = sources.find((x) => x.repoId === r.id && x.tokenId === token.id && x.enabled)
          return { ...r, syncing: Boolean(s), sourceId: s?.id ?? null }
        })
        .sort((a, b) => a.fullName.localeCompare(b.fullName))
    },

    async addToken(addedBy, raw) {
      const token = raw.trim()
      const id = await check(token)
      const row: TokenRow = {
        id: randomUUID(),
        githubLogin: id.login,
        tokenSealed: '',
        last4: last4(token),
        expiresAt: id.expiresAt,
        addedBy,
        createdAt: deps.now(),
        lastError: null,
      }
      row.tokenSealed = sealToken(token, deps.key(), row.id)
      await store.insertToken(row)
      return { id: row.id, login: row.githubLogin }
    },

    async replaceToken(tokenId, raw) {
      const current = await requireToken(tokenId)
      const token = raw.trim()
      const id = await check(token)
      await store.updateToken(current.id, {
        githubLogin: id.login,
        tokenSealed: sealToken(token, deps.key(), current.id),
        last4: last4(token),
        expiresAt: id.expiresAt,
        lastError: null,
      })
      await store.updateSourcesOfToken(current.id, { lastError: null, pausedUntil: null, dueAt: deps.now() })
      return { login: id.login }
    },

    async removeToken(tokenId) {
      const token = await requireToken(tokenId)
      const mine = (await store.sources()).filter((s) => s.tokenId === token.id)
      for (const s of mine) await removeRepoFolder(drive, s.repoId)
      await store.deleteToken(token.id)
      return { removedRepos: mine.filter((s) => s.enabled).length }
    },

    async setRepo(tokenId, repoId, syncing) {
      const token = await requireToken(tokenId)
      const existing = await store.sourceByRepoId(repoId)
      if (existing && existing.tokenId !== token.id) {
        const other = await store.token(existing.tokenId)
        throw new ReposError(`${existing.fullName} already syncs through the token of ${other?.githubLogin ?? 'another account'}.`)
      }
      if (!syncing) {
        if (!existing || !existing.enabled) throw new ReposError('That repo is not synced.')
        await removeRepoFolder(drive, repoId)
        await store.updateSource(existing.id, { ...FRESH_STATE, enabled: false })
        return { fullName: existing.fullName }
      }
      const repo = (await visible(token)).find((r) => r.id === repoId)
      if (!repo) throw new ReposError('This token cannot see that repo. Check the repos you selected for it on GitHub.')
      // Fine-grained permissions apply to every selected repo, but GitHub serves a
      // public repo's data anyway: a missing one only shows on private repos, so
      // check this repo before it starts syncing.
      let missing
      try {
        missing = await deps.client(unsealToken(token.tokenSealed, deps.key(), token.id)).checkAccess(repo.fullName)
      } catch (err) {
        if (isGitHubTokenError(err) && err.kind === 'no_access') throw new ReposError(tokenMessages.noAccess(repo.fullName), { cause: err })
        if (isGitHubTokenError(err)) throw new ReposError('GitHub did not answer. Try again in a minute.', { cause: err })
        throw err
      }
      if (missing.length > 0) throw new ReposError(tokenMessages.missingPermissions(repo.fullName, missing, 'tick'))
      await store.enableSource({ tokenId: token.id, repoId: repo.id, fullName: repo.fullName, defaultBranch: repo.defaultBranch, dueAt: deps.now() })
      return { fullName: repo.fullName }
    },

    async syncNow(ref) {
      const sources = (await store.sources()).filter((s) => s.enabled)
      const s =
        'sourceId' in ref
          ? sources.find((x) => x.id === ref.sourceId)
          : sources.find((x) => x.fullName.toLowerCase() === ref.repo.trim().toLowerCase() || String(x.repoId) === ref.repo.trim())
      if (!s) throw new ReposError('That repo is not connected. repos.list shows the connected ones.')
      const token = await store.token(s.tokenId)
      if (token?.lastError) throw new ReposError(token.lastError)
      const now = deps.now()
      if (s.pausedUntil && s.pausedUntil.getTime() > now.getTime())
        throw new ReposError(`Syncing is paused until ${s.pausedUntil.toISOString().slice(11, 16)} UTC (GitHub's rate limit).`)
      await store.updateSource(s.id, { dueAt: now })
      const [claimed] = await store.claimDue({ owner: deps.owner, limit: 1, now, leaseMs: CLAIM_LEASE_MS, onlyId: s.id })
      if (!claimed) return { fullName: s.fullName, outcome: { status: 'queued' } }
      const outcome = await syncClaimed(deps, claimed)
      return { fullName: (await store.source(s.id))?.fullName ?? s.fullName, outcome }
    },

    async list() {
      const [sources, folders] = await Promise.all([store.sources(), folderIds()])
      return sources.filter((s) => s.enabled).map((s) => sourceView(s, folders))
    },

    async briefs() {
      const [sources, folders] = await Promise.all([store.sources(), folderIds()])
      const pushed = (s: SourceRow) => s.snapshot?.repo.pushedAt ?? ''
      return sources
        .filter((s) => s.enabled && s.snapshot !== null)
        .sort((a, b) => pushed(b).localeCompare(pushed(a)) || a.fullName.localeCompare(b.fullName))
        .slice(0, BRIEFS_MAX)
        .map((s) => {
          const snap = s.snapshot!
          return {
            fullName: s.fullName,
            lastPushAt: snap.repo.pushedAt ? new Date(snap.repo.pushedAt) : null,
            openPulls: snap.pulls.filter((p) => p.state === 'open').length,
            summaryFirstSentence: s.summary ? firstSentence(s.summary.summary) : null,
            summaryStale: s.summary !== null && s.summaryErrorKind !== null,
            driveFolderId: folders.get(repoKey(s.repoId)) ?? null,
          }
        })
    },

    tick: () => reposTickWith(deps),
  }
}
