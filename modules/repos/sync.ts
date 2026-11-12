import type { DriveSourceItem, DriveSourcePort } from './drive-port'
import type { RepoSnapshot, RepoSummary } from './snapshot-types'
import type { ReposStore, SourceRow, TokenRow } from './store'
import type { GitHubTokenClient } from '$lib/server/github/token-client'
import { isGitHubTokenError, tokenMessages } from './errors'
import { REPOS_DRIVE_SOURCE } from './manifest'
import { render, repoKey, type RenderedItem } from './render'
import { unsealToken } from './seal'
import { RatePause, storable, takeSnapshot, type SnapshotResult } from './snapshot'

/**
 * The poller (plan/github-drive.md §3): claim due repos, read GitHub, render,
 * write through the Drive source port, reconcile what disappeared. Runs on the
 * job-queue tick (every 60 s); each repo is due every 15 minutes.
 */

export const SYNC_EVERY_MS = 15 * 60_000
export const CLAIM_LEASE_MS = 10 * 60_000
export const CLAIM_BATCH = 5
export const DRIVE_ROOT_NAME = 'GitHub'

export type TokenClientFactory = (token: string) => GitHubTokenClient

export type SyncLog = (message: string, fields: Record<string, unknown>) => void

export type SyncDeps = {
  store: ReposStore
  drive: DriveSourcePort
  client: TokenClientFactory
  /** The sealing key (fails loud without TENANT_MASTER_KEY). */
  key: () => Buffer
  now: () => Date
  /** This process's claim owner id (both blue-green slots tick). */
  owner: string
  log: SyncLog
  /**
   * The summary to render for a repo (S4: the assistant's "What's going on").
   * Without it Overview.md shows the placeholder.
   */
  summaryFor?: (sourceId: string, result: SnapshotResult, previous: RepoSnapshot | null) => Promise<RepoSummary | null>
  /** Called after a sync that found changes (S4: the repos.synced event). */
  onSynced?: (source: SourceRow, result: SnapshotResult, previous: RepoSnapshot | null) => Promise<void>
}

export type SyncOutcome =
  | { status: 'synced'; changed: boolean }
  | { status: 'paused'; until: Date }
  | { status: 'failed'; error: string }

/** Owner folders with no repo left in them go (a repo moved owner, or was unticked). */
export async function pruneOwnerFolders(drive: DriveSourcePort): Promise<void> {
  const items = await drive.list(REPOS_DRIVE_SOURCE)
  const parents = new Set(items.map((i) => i.parentKey))
  for (const i of items) if (i.kind === 'folder' && i.parentKey === null && !parents.has(i.key)) await drive.remove(REPOS_DRIVE_SOURCE, i.key)
}

/** Deletes a repo's Drive folder for good (untick, token removed). */
export async function removeRepoFolder(drive: DriveSourcePort, repoId: number): Promise<void> {
  await drive.remove(REPOS_DRIVE_SOURCE, repoKey(repoId))
  await pruneOwnerFolders(drive)
}

/**
 * Writes the rendered items (parents first, as render emits them) and removes
 * every item under the repo that the render no longer has. A kept doc
 * (`content: null`) that is missing in Drive is fetched again.
 */
export async function writeRepo(
  drive: DriveSourcePort,
  items: RenderedItem[],
  repoId: number,
  refetch: (key: string) => Promise<string>,
): Promise<void> {
  await drive.ensureRoot(REPOS_DRIVE_SOURCE, DRIVE_ROOT_NAME)
  const before: DriveSourceItem[] = await drive.list(REPOS_DRIVE_SOURCE)
  const present = new Set(before.map((i) => i.key))
  for (const item of items) {
    if (item.kind === 'folder') await drive.upsertFolder(REPOS_DRIVE_SOURCE, item.key, item.parentKey, item.name)
    else {
      const content = item.content ?? (present.has(item.key) ? null : await refetch(item.key))
      if (content !== null) await drive.upsertText(REPOS_DRIVE_SOURCE, item.key, item.parentKey, item.name, content)
    }
  }
  const expected = new Set(items.map((i) => i.key))
  const prefix = `${repoKey(repoId)}/`
  for (const i of before) if (i.key.startsWith(prefix) && !expected.has(i.key)) await drive.remove(REPOS_DRIVE_SOURCE, i.key)
  await pruneOwnerFolders(drive)
}

async function stopToken(deps: SyncDeps, token: TokenRow, message: string): Promise<void> {
  await deps.store.updateToken(token.id, { lastError: message })
  await deps.store.updateSourcesOfToken(token.id, { lastError: message, claimedBy: null, claimedUntil: null })
}

/** Syncs one claimed repo and releases the claim, whatever happens. */
export async function syncClaimed(deps: SyncDeps, row: SourceRow): Promise<SyncOutcome> {
  const now = deps.now()
  const next = new Date(now.getTime() + SYNC_EVERY_MS)
  const release = { claimedBy: null, claimedUntil: null }
  const token = await deps.store.token(row.tokenId)
  if (!token) throw new Error(`repo_sources ${row.id} has no token ${row.tokenId}`)
  if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
    const message = tokenMessages.expired(token.githubLogin, token.expiresAt)
    await stopToken(deps, token, message)
    return { status: 'failed', error: message }
  }
  try {
    const client = deps.client(unsealToken(token.tokenSealed, deps.key(), token.id))
    const result = await takeSnapshot(client, row, now)
    const summary = deps.summaryFor ? await deps.summaryFor(row.id, result, row.snapshot) : null
    const fullName = result.snapshot.repo.fullName
    const docSha = new Map(result.snapshot.docs.copied.map((d) => [`${repoKey(row.repoId)}/Docs/${d.path}`, d.sha]))
    await writeRepo(deps.drive, render(result.snapshot, summary), row.repoId, async (key) => client.blobText(fullName, docSha.get(key)!))
    await deps.store.updateSource(row.id, {
      fullName,
      defaultBranch: result.snapshot.repo.defaultBranch,
      etags: result.etags,
      branchHeads: result.branchHeads,
      docShas: result.docShas,
      snapshot: storable(result.snapshot),
      lastSyncedAt: now,
      lastError: null,
      pausedUntil: null,
      dueAt: next,
      ...release,
    })
    if (result.changed && deps.onSynced) await deps.onSynced(row, result, row.snapshot)
    return { status: 'synced', changed: result.changed }
  } catch (err) {
    const fields = { sourceId: row.id, tokenId: token.id, repoId: row.repoId }
    if (err instanceof RatePause || (isGitHubTokenError(err) && err.kind === 'rate_limited')) {
      const until = err.resumeAt ?? next
      deps.log('[repos] paused for the GitHub rate limit', { ...fields, until: until.toISOString() })
      // The budget is the token's, so every repo on it waits.
      await deps.store.updateSourcesOfToken(token.id, { pausedUntil: until })
      await deps.store.updateSource(row.id, { dueAt: until, ...release })
      return { status: 'paused', until }
    }
    if (isGitHubTokenError(err)) {
      deps.log('[repos] sync failed', { ...fields, kind: err.kind, status: err.status, path: err.path })
      if (err.kind === 'unauthorized') {
        const message = tokenMessages.unauthorized(token.githubLogin)
        await stopToken(deps, token, message)
        return { status: 'failed', error: message }
      }
      const message = err.kind === 'no_access' ? tokenMessages.noAccess(row.fullName) : err.kind === 'unavailable' ? tokenMessages.unavailable : tokenMessages.failed
      await deps.store.updateSource(row.id, { lastError: message, dueAt: next, ...release })
      return { status: 'failed', error: message }
    }
    deps.log('[repos] sync failed', { ...fields, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
    await deps.store.updateSource(row.id, { lastError: tokenMessages.failed, dueAt: next, ...release })
    return { status: 'failed', error: tokenMessages.failed }
  }
}

export type TickResult = { claimed: number; synced: number; paused: number; failed: number }

/** One poller pass: claims due repos (SKIP LOCKED in Postgres) and syncs them one by one. */
export async function reposTickWith(deps: SyncDeps): Promise<TickResult> {
  const rows = await deps.store.claimDue({ owner: deps.owner, limit: CLAIM_BATCH, now: deps.now(), leaseMs: CLAIM_LEASE_MS })
  const out: TickResult = { claimed: rows.length, synced: 0, paused: 0, failed: 0 }
  for (const row of rows) {
    const r = await syncClaimed(deps, row)
    if (r.status === 'synced') out.synced += 1
    else if (r.status === 'paused') out.paused += 1
    else out.failed += 1
  }
  return out
}
