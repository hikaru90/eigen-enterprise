import type { DriveSourceBatchItem, DriveSourceItem, DriveSourcePort } from './drive-port'
import type { FileSnap, NotCopied, RepoSnapshot, SummaryState, TreePlan, TreeSnap } from './snapshot-types'
import type { ReposStore, SourceRow, TokenRow } from './store'
import { rm } from 'node:fs/promises'
import { gitBlobSha, verifyGitBlobSha } from '$lib/server/github/git'
import type { GitHubTokenClient } from '$lib/server/github/token-client'
import { isGitHubTokenError, tokenMessages } from './errors'
import { REPOS_DRIVE_SOURCE } from './manifest'
import { generatedKeys, ownerKey, render, repoKey, treeFolderKey, type RenderedItem } from './render'
import { unsealToken } from './seal'
import { guardOf, isLfsPointer, mimeForFile, pickFiles, RatePause, takeSnapshot, type SyncState } from './snapshot'
import { deltaIsEmpty, diffSnapshots, summaryFailureMessage, type ReposSummarizer, type SyncDelta } from './summary'
import { stripTopFolder, type TarballReader } from './tarball'

/**
 * The poller (plan/github-drive.md §3, plan/github-drive-full-mirror.md §3):
 * claim due repos, read GitHub, render, write through the Drive source port,
 * reconcile what disappeared. Runs on the job-queue tick (every 60 s); each
 * repo is due every 15 minutes.
 *
 * The write is split: the generated pages are written every sync, the copied
 * tree only when the default head (or the copy mode) moved or Drive is missing
 * items — a sync where nothing moved makes zero tree writes. File bytes stream
 * from the tarball into Drive batch by batch; the repo is never held in
 * memory.
 */

export const SYNC_EVERY_MS = 15 * 60_000
export const CLAIM_LEASE_MS = 10 * 60_000
export const CLAIM_BATCH = 5
export const DRIVE_ROOT_NAME = 'GitHub'
/** Items per Drive batch (plan §5): the port writes each batch in one transaction. */
export const DRIVE_BATCH_ITEMS = 500
/** Bytes per Drive batch, so one batch stays bounded even with 20 MB files. */
export const DRIVE_BATCH_BYTES = 64 * 1024 * 1024

export type TokenClientFactory = (token: string) => GitHubTokenClient

export type SyncLog = (message: string, fields: Record<string, unknown>) => void

export type SyncDeps = {
  store: ReposStore
  drive: DriveSourcePort
  client: TokenClientFactory
  /** Reads a downloaded tarball, one file at a time (the seam to M1's reader; see tarball.ts). */
  readTarball: TarballReader
  /** The sealing key (fails loud without TENANT_MASTER_KEY). */
  key: () => Buffer
  now: () => Date
  /** This process's claim owner id (both blue-green slots tick). */
  owner: string
  log: SyncLog
  /** The assistant's "What's going on": one gateway call after a sync that found changes. */
  summarizer: ReposSummarizer
  /** The kernel event `repos.synced`, after a sync (not the first) that found changes. */
  emitSynced: (payload: ReposSyncedPayload) => Promise<void>
}

export const REPOS_SYNCED_EVENT = 'repos.synced'

/** Metadata only: no commit messages, titles or names of people. */
export type ReposSyncedPayload = {
  repoId: number
  fullName: string
  newCommits: number
  prsOpened: number
  prsMerged: number
  prsClosed: number
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
 * The repo's folder chain (GitHub / owner / repo), idempotent, before any tree
 * write: the tree folder hangs off it, and the tree sync runs before the pages
 * are rendered (the Overview counts need its result).
 */
async function ensureRepoFolders(drive: DriveSourcePort, repo: RepoSnapshot['repo']): Promise<void> {
  await drive.ensureRoot(REPOS_DRIVE_SOURCE, DRIVE_ROOT_NAME)
  await drive.upsertFolder(REPOS_DRIVE_SOURCE, ownerKey(repo.owner), null, repo.owner)
  await drive.upsertFolder(REPOS_DRIVE_SOURCE, repoKey(repo.id), ownerKey(repo.owner), repo.name)
}

/** Writes the generated pages (parents first, as render emits them), every sync. */
export async function writeRepo(drive: DriveSourcePort, items: RenderedItem[]): Promise<void> {
  await drive.ensureRoot(REPOS_DRIVE_SOURCE, DRIVE_ROOT_NAME)
  for (const item of items) {
    if (item.kind === 'folder') await drive.upsertFolder(REPOS_DRIVE_SOURCE, item.key, item.parentKey, item.name)
    else await drive.upsertText(REPOS_DRIVE_SOURCE, item.key, item.parentKey, item.name, item.content)
  }
  await pruneOwnerFolders(drive)
}

// ── the copied tree ───────────────────────────────────────────────────────────

type TreeRepo = { sourceId: string; repoId: number; fullName: string; branch: string }

/** The folder chain of a path under the tree folder, parents first. */
function folderChain(repoId: number, path: string): Array<{ key: string; parentKey: string; name: string }> {
  const out: Array<{ key: string; parentKey: string; name: string }> = []
  const segs = path.split('/')
  let parent = treeFolderKey(repoId)
  for (const seg of segs.slice(0, -1)) {
    const key = `${parent}/${seg}`
    out.push({ key, parentKey: parent, name: seg })
    parent = key
  }
  return out
}

/** Every key the repo's folder should hold: the pages, the tree folder, the folders and the files. */
function expectedKeys(repoId: number, hasTree: boolean, paths: string[]): Set<string> {
  const expected = new Set<string>([repoKey(repoId), ...generatedKeys(repoId)])
  if (hasTree) expected.add(treeFolderKey(repoId))
  for (const p of paths) {
    for (const f of folderChain(repoId, p)) expected.add(f.key)
    expected.add(`${treeFolderKey(repoId)}/${p}`)
  }
  return expected
}

/**
 * Removes Drive items the repo no longer should have (gone paths, the old
 * `Docs/` folder, emptied folders). Only the topmost unexpected items go: a
 * folder's prefix delete takes its gone descendants with it.
 */
async function removeUnexpected(deps: SyncDeps, repoId: number, expected: Set<string>, items: DriveSourceItem[]): Promise<void> {
  const unexpected = items.filter((i) => !expected.has(i.key))
  const keys = new Set(unexpected.map((i) => i.key))
  for (const i of unexpected) if (i.parentKey === null || !keys.has(i.parentKey)) await deps.drive.remove(REPOS_DRIVE_SOURCE, i.key)
}

/** One batch of tree writes: folders before the files that need them, flushed by item count or bytes. */
class TreeBatcher {
  private batch: DriveSourceBatchItem[] = []
  private bytes = 0
  private readonly folders = new Set<string>()

  constructor(
    private readonly drive: DriveSourcePort,
    private readonly repoId: number,
    private readonly branch: string,
  ) {}

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return
    await this.drive.upsertMany(REPOS_DRIVE_SOURCE, this.batch)
    this.batch = []
    this.bytes = 0
  }

  /** Queues one copied file (with its folder chain and the branch folder); flushes when the batch is full. */
  async file(f: FileSnap & { bytes: Uint8Array }): Promise<void> {
    const treeK = treeFolderKey(this.repoId)
    const queueFolder = (key: string, parentKey: string, name: string) => {
      if (this.folders.has(key)) return
      this.folders.add(key)
      this.batch.push({ kind: 'folder', key, parentKey, name })
    }
    queueFolder(treeK, repoKey(this.repoId), this.branch)
    let parent = treeK
    for (const folder of folderChain(this.repoId, f.path)) {
      queueFolder(folder.key, folder.parentKey, folder.name)
      parent = folder.key
    }
    const segs = f.path.split('/')
    this.batch.push({ kind: 'bytes', key: `${treeK}/${f.path}`, parentKey: parent, name: segs.at(-1)!, bytes: f.bytes, mime: mimeForFile(f.bytes) })
    this.bytes += f.bytes.byteLength
    if (this.batch.length >= DRIVE_BATCH_ITEMS || this.bytes >= DRIVE_BATCH_BYTES) await this.flush()
  }

  async done(): Promise<void> {
    await this.flush()
  }
}

/**
 * Executes the tree plan: fetches the changed files' bytes (per blob, or the
 * tarball when there are many / it is a first sync / the tree was truncated),
 * writes them to Drive in batches, deletes what is gone, and returns the final
 * tree section for the snapshot. Any blob-sha mismatch fails loud, before that
 * file is written.
 */
export async function syncTree(
  deps: SyncDeps,
  client: GitHubTokenClient,
  repo: TreeRepo,
  plan: TreePlan,
  storedFiles: FileSnap[],
): Promise<{ snap: TreeSnap; writes: number }> {
  const guard = guardOf(client)
  const batcher = new TreeBatcher(deps.drive, repo.repoId, repo.branch)
  let picked = plan.picked
  let changed = plan.changed
  let gone = plan.gone
  let notCopied: NotCopied[] = [...plan.notCopied]
  const lfsPaths: string[] = []
  const written: FileSnap[] = []

  if (plan.viaTarball) {
    guard()
    const tarPath = await client.tarball(repo.fullName, plan.commitSha)
    try {
      if (plan.truncated) {
        // GitHub cut the tree short: the tarball's own listing is the file list, shas from the bytes.
        const listing: Array<{ path: string; size: number }> = []
        for await (const e of deps.readTarball(tarPath)) {
          const path = stripTopFolder(e.path)
          if (path !== null) listing.push({ path, size: e.bytes.byteLength })
        }
        const pick = pickFiles(listing, plan.mode)
        picked = pick.copied.map((c) => ({ path: c.path, sha: '', size: c.size }))
        changed = picked
        const pickedPaths = new Set(picked.map((p) => p.path))
        gone = storedFiles.filter((f) => !pickedPaths.has(f.path)).map((f) => f.path)
        notCopied = [...pick.notCopied]
      }
      const expected = new Map(picked.map((p) => [p.path, p.sha]))
      const open = new Set(changed.map((c) => c.path))
      for await (const e of deps.readTarball(tarPath)) {
        const path = stripTopFolder(e.path)
        if (path === null || !open.has(path)) continue
        open.delete(path)
        const want = expected.get(path)
        // §2.6: every file taken from a tarball is checked against the tree's
        // git blob sha; a mismatch fails the sync before anything is written.
        if (want) verifyGitBlobSha(e.bytes, want)
        const sha = gitBlobSha(e.bytes)
        const size = e.bytes.byteLength
        if (isLfsPointer(e.bytes)) {
          notCopied.push({ path, size, reason: 'lfs', sha })
          lfsPaths.push(path)
          continue
        }
        await batcher.file({ path, sha, size, bytes: e.bytes })
        written.push({ path, sha, size })
      }
      if (open.size > 0)
        throw new Error(`repos: the tarball of ${repo.fullName} is missing ${open.size} file(s) the tree lists (first: ${[...open][0]})`)
    } finally {
      await rm(tarPath, { force: true })
    }
  } else {
    for (const f of changed) {
      guard()
      const bytes = await client.blobBytes(repo.fullName, f.sha)
      if (isLfsPointer(bytes)) {
        notCopied.push({ path: f.path, size: f.size, reason: 'lfs', sha: f.sha })
        lfsPaths.push(f.path)
        continue
      }
      await batcher.file({ ...f, bytes })
      written.push(f)
    }
  }
  await batcher.done()

  const lfsSet = new Set(lfsPaths)
  const copied = picked.filter((p) => !lfsSet.has(p.path))
  if (written.length > 0) await deps.store.upsertSourceFiles(repo.sourceId, written)
  const deletePaths = [...new Set([...gone, ...lfsPaths])]
  if (deletePaths.length > 0) await deps.store.deleteSourceFiles(repo.sourceId, deletePaths)
  const items = await deps.drive.list(REPOS_DRIVE_SOURCE, repoKey(repo.repoId))
  await removeUnexpected(deps, repo.repoId, expectedKeys(repo.repoId, copied.length > 0, copied.map((f) => f.path)), items)
  return {
    snap: { commitSha: plan.commitSha, mode: plan.mode, count: copied.length, bytes: copied.reduce((n, f) => n + f.size, 0), notCopied, truncated: plan.truncated },
    writes: written.length,
  }
}

/**
 * The head did not move: no fetch plan, just keep Drive honest. Missing tree
 * files are fetched again (a folder was deleted by hand); items the tree no
 * longer has go; the branch folder is re-ensured so a renamed default branch
 * renames the folder — its key never moves.
 */
export async function reconcileTree(
  deps: SyncDeps,
  client: GitHubTokenClient,
  repo: TreeRepo,
  tree: TreeSnap,
  storedFiles: FileSnap[],
): Promise<number> {
  const guard = guardOf(client)
  const treeK = treeFolderKey(repo.repoId)
  const items = await deps.drive.list(REPOS_DRIVE_SOURCE, repoKey(repo.repoId))
  const present = new Set(items.map((i) => i.key))
  if (tree.count > 0) await deps.drive.upsertFolder(REPOS_DRIVE_SOURCE, treeK, repoKey(repo.repoId), repo.branch)
  let writes = 0
  const batch: DriveSourceBatchItem[] = []
  const queued = new Set<string>()
  for (const f of storedFiles) {
    const key = `${treeK}/${f.path}`
    if (present.has(key)) continue
    guard()
    const bytes = await client.blobBytes(repo.fullName, f.sha)
    let parent = treeK
    for (const folder of folderChain(repo.repoId, f.path)) {
      if (!present.has(folder.key) && !queued.has(folder.key)) {
        queued.add(folder.key)
        batch.push({ kind: 'folder', key: folder.key, parentKey: folder.parentKey, name: folder.name })
      }
      parent = folder.key
    }
    batch.push({ kind: 'bytes', key, parentKey: parent, name: f.path.split('/').at(-1)!, bytes, mime: mimeForFile(bytes) })
    writes += 1
    if (batch.length >= DRIVE_BATCH_ITEMS) await deps.drive.upsertMany(REPOS_DRIVE_SOURCE, batch.splice(0))
  }
  if (batch.length > 0) await deps.drive.upsertMany(REPOS_DRIVE_SOURCE, batch)
  await removeUnexpected(deps, repo.repoId, expectedKeys(repo.repoId, tree.count > 0, storedFiles.map((f) => f.path)), items)
  return writes
}

/** What a source row says about its summary (rendered again when nothing changed). */
export function summaryStateOf(row: Pick<SourceRow, 'summary' | 'summaryErrorKind' | 'summaryError' | 'summaryErrorAt'>): SummaryState {
  const problem =
    row.summaryErrorKind && row.summaryError && row.summaryErrorAt
      ? { kind: row.summaryErrorKind, message: row.summaryError, at: row.summaryErrorAt.toISOString() }
      : null
  return { summary: row.summary, problem }
}

type SummaryPatch = Pick<SourceRow, 'summary' | 'summaryErrorKind' | 'summaryError' | 'summaryErrorAt'>

/**
 * Asks for a new summary. No model → no call made, the old summary (if any)
 * kept and marked stale. A failure is logged and shown, the old summary kept
 * and marked stale; the sync itself goes on.
 */
async function summarize(deps: SyncDeps, row: SourceRow, snapshot: RepoSnapshot, delta: SyncDelta, now: Date): Promise<SummaryPatch> {
  try {
    const out = await deps.summarizer({ snapshot, delta, previous: row.summary })
    if (out.status === 'no_model') return { summary: row.summary, summaryErrorKind: 'no_model', summaryError: out.message, summaryErrorAt: now }
    return {
      summary: { summary: out.summary, highlights: out.highlights, writtenAt: now.toISOString() },
      summaryErrorKind: null,
      summaryError: null,
      summaryErrorAt: null,
    }
  } catch (err) {
    deps.log('[repos] summary failed', {
      sourceId: row.id,
      repoId: row.repoId,
      error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown',
    })
    return { summary: row.summary, summaryErrorKind: 'failed', summaryError: summaryFailureMessage(err), summaryErrorAt: now }
  }
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
    const storedFiles = await deps.store.sourceFiles(row.id)
    const state: SyncState = {
      fullName: row.fullName,
      etags: row.etags,
      branchHeads: row.branchHeads,
      copyMode: row.copyMode,
      storedFiles,
      snapshot: row.snapshot,
    }
    const result = await takeSnapshot(client, state, now)
    const fullName = result.snapshot.repo.fullName
    const branch = result.snapshot.repo.defaultBranch
    const repo: TreeRepo = { sourceId: row.id, repoId: row.repoId, fullName, branch }
    // The tree sync writes before the pages render (Overview needs its counts),
    // so the repo's folder chain exists first — idempotent, also on a stable head.
    await ensureRepoFolders(deps.drive, result.snapshot.repo)
    let treeSnap: TreeSnap
    let treeWrites: number
    if (result.tree) {
      const out = await syncTree(deps, client, repo, result.tree, storedFiles)
      treeSnap = out.snap
      treeWrites = out.writes
    } else {
      treeSnap = result.snapshot.tree!
      treeWrites = await reconcileTree(deps, client, repo, treeSnap, storedFiles)
    }
    const snapshot: RepoSnapshot = { ...result.snapshot, tree: treeSnap }
    const delta = diffSnapshots(row.snapshot, snapshot)
    const moved = !deltaIsEmpty(delta)
    const summary: SummaryPatch = moved ? await summarize(deps, row, snapshot, delta, now) : row
    await writeRepo(deps.drive, render(snapshot, summaryStateOf(summary)))
    const comparable = (s: RepoSnapshot) => JSON.stringify({ ...s, takenAt: null })
    const changed = !row.snapshot || comparable(row.snapshot) !== comparable(snapshot) || treeWrites > 0
    await deps.store.updateSource(row.id, {
      fullName,
      defaultBranch: branch,
      etags: result.etags,
      branchHeads: result.branchHeads,
      snapshot,
      lastSyncedAt: now,
      lastError: null,
      pausedUntil: null,
      dueAt: next,
      summary: summary.summary,
      summaryErrorKind: summary.summaryErrorKind,
      summaryError: summary.summaryError,
      summaryErrorAt: summary.summaryErrorAt,
      ...release,
    })
    if (moved && !delta.first) await emitSynced(deps, row, fullName, delta)
    return { status: 'synced', changed }
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
      deps.log('[repos] sync failed', { ...fields, kind: err.kind, status: err.status, path: err.path, permission: err.permission })
      if (err.kind === 'unauthorized') {
        const message = tokenMessages.unauthorized(token.githubLogin)
        await stopToken(deps, token, message)
        return { status: 'failed', error: message }
      }
      const message =
        err.kind === 'missing_permission' && err.permission
          ? tokenMessages.missingPermissions(row.fullName, [err.permission], 'sync')
          : err.kind === 'no_access'
            ? tokenMessages.noAccess(row.fullName)
            : err.kind === 'unavailable'
              ? tokenMessages.unavailable
              : tokenMessages.failed
      await deps.store.updateSource(row.id, { lastError: message, dueAt: next, ...release })
      return { status: 'failed', error: message }
    }
    deps.log('[repos] sync failed', { ...fields, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })
    await deps.store.updateSource(row.id, { lastError: tokenMessages.failed, dueAt: next, ...release })
    return { status: 'failed', error: tokenMessages.failed }
  }
}

/** The event never fails a sync that already landed in Drive: a failure is logged loudly. */
async function emitSynced(deps: SyncDeps, row: SourceRow, fullName: string, d: SyncDelta): Promise<void> {
  const payload: ReposSyncedPayload = {
    repoId: row.repoId,
    fullName,
    newCommits: d.newCommits.length,
    prsOpened: d.prsOpened.length,
    prsMerged: d.prsMerged.length,
    prsClosed: d.prsClosed.length,
  }
  try {
    await deps.emitSynced(payload)
  } catch (err) {
    deps.log('[repos] repos.synced event failed', { sourceId: row.id, repoId: row.repoId, error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown' })
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
