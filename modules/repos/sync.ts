import type { DriveSourceBatchItem, DriveSourceItem, DriveSourcePort } from './drive-port'
import type { FileSnap, NotCopied, RepoSnapshot, SummaryState, TreePlan, TreeSnap } from './snapshot-types'
import type { ReposStore, SourceRow, TokenRow } from './store'
import { rm } from 'node:fs/promises'
import { gitBlobSha, verifyGitBlobSha } from '$lib/server/github/git'
import type { GitHubTokenClient } from '$lib/server/github/token-client'
import { isGitHubTokenError, tokenMessages } from './errors'
import { REPOS_DRIVE_SOURCE } from './manifest'
import { treeFolderName } from './names'
import { generatedKeys, ownerKey, render, repoKey, treeFolderKey, type RenderedItem } from './render'
import { unsealToken } from './seal'
import {
  FILE_LIMITS,
  guardOf,
  isLfsPointer,
  MAX_ARCHIVE_RECOVERIES,
  mimeForFile,
  pickFiles,
  RatePause,
  SMALL_BLOB_LIMIT,
  takeSnapshot,
  type SyncState,
} from './snapshot'
import { deltaIsEmpty, diffSnapshots, summaryFailureMessage, type ReposSummarizer, type SyncDelta } from './summary'
import { stripTopFolder, type TarballHeader, type TarballReader, type TarballSweeper } from './tarball'

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
/** Tarball temp files older than this are leftovers of a crashed sync: every tick sweeps them. */
export const TARBALL_SWEEP_AGE_MS = 6 * 3_600_000

export type TokenClientFactory = (token: string) => GitHubTokenClient

export type SyncLog = (message: string, fields: Record<string, unknown>) => void

export type SyncDeps = {
  store: ReposStore
  drive: DriveSourcePort
  client: TokenClientFactory
  /** Reads a downloaded tarball, one wanted file at a time (the seam to M1's reader; see tarball.ts). */
  readTarball: TarballReader
  /** Where the token client downloads tarballs (the Drive storage temp dir, as in GitHubTokenConfig.tarballDir). */
  tarballDir: string
  /** The client's tarball size cap (GitHubTokenConfig.tarballMaxBytes), named in the too_large message. */
  tarballMaxBytes: number
  /** Removes tarball temp files older than a given age (M1's sweepTarballs; see tarball.ts). */
  sweepTarballs: TarballSweeper
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

/** The owner a repo's Drive folder hangs under, as its last sync saw it (null: never synced, so no folder). */
function folderOwnerOf(row: Pick<SourceRow, 'snapshot'>): string | null {
  return row.snapshot?.repo.owner ?? null
}

/**
 * Removes an owner folder when no other synced repo still hangs under it (a
 * repo moved owner, or was unticked). Asks the store, never lists Drive: one
 * small query over the handful of source rows, not every repo's items.
 */
export async function pruneOwnerFolder(deps: Pick<SyncDeps, 'drive' | 'store'>, owner: string, leaving: ReadonlySet<string>): Promise<void> {
  const others = (await deps.store.sources()).filter((s) => s.enabled && !leaving.has(s.id) && folderOwnerOf(s) === owner)
  if (others.length === 0) await deps.drive.remove(REPOS_DRIVE_SOURCE, ownerKey(owner))
}

/**
 * Deletes a repo's Drive folder for good (untick, token removed), and its
 * owner folder when it was the last one there. `leaving` names every source
 * that goes in the same operation (a removed token takes all of its repos).
 */
export async function removeRepoFolder(deps: Pick<SyncDeps, 'drive' | 'store'>, row: SourceRow, leaving: ReadonlySet<string> = new Set([row.id])): Promise<void> {
  await deps.drive.remove(REPOS_DRIVE_SOURCE, repoKey(row.repoId))
  const owner = folderOwnerOf(row)
  if (owner !== null) await pruneOwnerFolder(deps, owner, leaving)
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
async function removeUnexpected(deps: SyncDeps, expected: Set<string>, items: DriveSourceItem[]): Promise<void> {
  const unexpected = items.filter((i) => !expected.has(i.key))
  const keys = new Set(unexpected.map((i) => i.key))
  for (const i of unexpected) if (i.parentKey === null || !keys.has(i.parentKey)) await deps.drive.remove(REPOS_DRIVE_SOURCE, i.key)
}

/**
 * The tree writes of one sync, in batches: folders before the files that need
 * them, flushed by item count or bytes. Each flush writes the Drive batch and
 * then that batch's `repo_source_files` rows in the same step, so the stored
 * rows never claim more than Drive has: a failure after batch N leaves rows
 * = Drive for batches ≤ N (Drive is ahead only by a batch whose rows did not
 * land, until the next sync). The tree folder is upserted (named after the
 * branch) before the first write and at the end, so a renamed branch renames
 * it even when the sync only deletes.
 */
class TreeBatcher {
  private batch: DriveSourceBatchItem[] = []
  private rows: FileSnap[] = []
  private bytes = 0
  private readonly folders = new Set<string>()
  private treeEnsured = false
  writes = 0

  constructor(
    private readonly deps: SyncDeps,
    private readonly repo: TreeRepo,
    /** Keys Drive already holds (reconcile): their folders are not queued again. */
    present: ReadonlySet<string> = new Set(),
  ) {
    for (const k of present) this.folders.add(k)
  }

  private async ensureTree(): Promise<void> {
    if (this.treeEnsured) return
    await this.deps.drive.upsertFolder(REPOS_DRIVE_SOURCE, treeFolderKey(this.repo.repoId), repoKey(this.repo.repoId), treeFolderName(this.repo.branch))
    this.treeEnsured = true
  }

  private async flush(): Promise<void> {
    if (this.batch.length === 0) return
    await this.ensureTree()
    await this.deps.drive.upsertMany(REPOS_DRIVE_SOURCE, this.batch)
    if (this.rows.length > 0) await this.deps.store.upsertSourceFiles(this.repo.sourceId, this.rows)
    this.writes += this.rows.length
    this.batch = []
    this.rows = []
    this.bytes = 0
  }

  /** Queues one copied file (with its folder chain); flushes when the batch is full. */
  async file(f: FileSnap, bytes: Uint8Array): Promise<void> {
    const treeK = treeFolderKey(this.repo.repoId)
    let parent = treeK
    for (const folder of folderChain(this.repo.repoId, f.path)) {
      if (!this.folders.has(folder.key)) {
        this.folders.add(folder.key)
        this.batch.push({ kind: 'folder', key: folder.key, parentKey: folder.parentKey, name: folder.name })
      }
      parent = folder.key
    }
    const name = f.path.split('/').at(-1)!
    this.batch.push({ kind: 'bytes', key: `${treeK}/${f.path}`, parentKey: parent, name, bytes, mime: mimeForFile(name, bytes) })
    this.rows.push({ path: f.path, sha: f.sha, size: f.size })
    this.bytes += bytes.byteLength
    if (this.batch.length >= DRIVE_BATCH_ITEMS || this.bytes >= DRIVE_BATCH_BYTES) await this.flush()
  }

  /** Flushes the rest; with a tree, (re)names its folder even when nothing was written. */
  async done(hasTree: boolean): Promise<void> {
    if (hasTree) await this.ensureTree()
    await this.flush()
  }
}

/** What fetching left out: Git LFS pointers (by their bytes) and files over the per-sync recovery cap. */
type Skipped = { lfs: NotCopied[]; filtered: NotCopied[] }

/** Writes fetched bytes, unless they are a Git LFS pointer (listed instead). */
async function take(batcher: TreeBatcher, f: FileSnap, bytes: Uint8Array, skipped: Skipped): Promise<void> {
  if (isLfsPointer(bytes)) skipped.lfs.push({ path: f.path, size: f.size, reason: 'lfs', sha: f.sha })
  else await batcher.file(f, bytes)
}

/** Fetches files one blob each, every one checked against its tree sha (a mismatch fails loud). */
async function fromBlobs(client: GitHubTokenClient, repo: TreeRepo, batcher: TreeBatcher, files: FileSnap[], skipped: Skipped): Promise<void> {
  const guard = guardOf(client)
  for (const f of files) {
    guard()
    const bytes = await client.blobBytes(repo.fullName, f.sha)
    verifyGitBlobSha(bytes, f.sha)
    await take(batcher, f, bytes, skipped)
  }
}

/** Downloads the commit's tarball to a temp file (rate-guarded), hands it to `use`, and always removes it. */
async function withTarball<T>(client: GitHubTokenClient, repo: TreeRepo, commitSha: string, use: (tarPath: string) => Promise<T>): Promise<T> {
  guardOf(client)()
  const tarPath = await client.tarball(repo.fullName, commitSha)
  try {
    return await use(tarPath)
  } finally {
    await rm(tarPath, { force: true })
  }
}

/** The reader's half of the `want` contract: an entry nobody asked for is a reader bug, not data. */
function unwanted(path: string): Error {
  return new Error(`repos: the tar reader yielded ${JSON.stringify(path)}, which the sync did not ask for`)
}

/**
 * Takes `files` (known tree shas) out of a downloaded tarball. Only those
 * paths, at most 20 MB in the archive, are read; everything else is skipped
 * unread. A file the archive lacks or serves with another git blob sha
 * (.gitattributes export-ignore / export-subst / eol filters) is fetched as a
 * blob and verified against the tree — a mismatch there fails loud — up to
 * MAX_ARCHIVE_RECOVERIES per sync; the rest are listed as archive_filtered.
 */
async function fromTarball(
  deps: SyncDeps,
  client: GitHubTokenClient,
  repo: TreeRepo,
  batcher: TreeBatcher,
  tarPath: string,
  files: FileSnap[],
  skipped: Skipped,
): Promise<void> {
  const open = new Map(files.map((f) => [f.path, f]))
  const recover: FileSnap[] = []
  const want = (h: TarballHeader) => {
    const path = stripTopFolder(h.path)
    return path !== null && open.has(path) && h.size <= FILE_LIMITS.fileBytes
  }
  for await (const e of deps.readTarball(tarPath, { want })) {
    const path = stripTopFolder(e.path)
    const f = path === null ? undefined : open.get(path)
    if (!f) throw unwanted(e.path)
    open.delete(f.path)
    if (gitBlobSha(e.bytes) === f.sha) await take(batcher, f, e.bytes, skipped)
    else recover.push(f)
  }
  recover.push(...open.values())
  for (const [i, f] of recover.entries()) {
    if (i >= MAX_ARCHIVE_RECOVERIES) skipped.filtered.push({ path: f.path, size: f.size, reason: 'archive_filtered' })
    else await fromBlobs(client, repo, batcher, [f], skipped)
  }
}

/**
 * Fetches `files` into Drive through the plan's channel — per blob for a few,
 * the tarball for many — with the same checks everywhere (sha, LFS, the
 * archive recovery cap). Used by the sync and by the reconcile.
 */
async function fetchFiles(
  deps: SyncDeps,
  client: GitHubTokenClient,
  repo: TreeRepo,
  batcher: TreeBatcher,
  commitSha: string,
  files: FileSnap[],
  viaTarball: boolean,
): Promise<Skipped> {
  const skipped: Skipped = { lfs: [], filtered: [] }
  if (files.length === 0) return skipped
  if (viaTarball) await withTarball(client, repo, commitSha, (tarPath) => fromTarball(deps, client, repo, batcher, tarPath, files, skipped))
  else await fromBlobs(client, repo, batcher, files, skipped)
  return skipped
}

/**
 * A truncated tree: the tarball's own listing is the file list (headers only,
 * no bytes read), then the picked files are read and their shas computed
 * from the bytes — there is no tree sha to check them against. Entries are
 * provisional until the reader finishes (the gzip CRC is checked at the end);
 * the listing pass reads the whole archive through first, so the bytes the
 * second pass writes come from an archive already checked end to end.
 */
async function fromTruncatedTarball(
  deps: SyncDeps,
  batcher: TreeBatcher,
  tarPath: string,
  mode: TreePlan['mode'],
  skipped: Skipped,
): Promise<{ picked: FileSnap[]; notCopied: NotCopied[] }> {
  const listing: Array<{ path: string; size: number }> = []
  const list = (h: TarballHeader) => {
    const path = stripTopFolder(h.path)
    if (path !== null) listing.push({ path, size: h.size })
    return false
  }
  for await (const e of deps.readTarball(tarPath, { want: list })) throw unwanted(e.path)
  const pick = pickFiles(listing, mode)
  const open = new Set(pick.copied.map((c) => c.path))
  const picked: FileSnap[] = []
  const want = (h: TarballHeader) => {
    const path = stripTopFolder(h.path)
    return path !== null && open.has(path)
  }
  for await (const e of deps.readTarball(tarPath, { want })) {
    const path = stripTopFolder(e.path)
    if (path === null || !open.delete(path)) throw unwanted(e.path)
    const f = { path, sha: gitBlobSha(e.bytes), size: e.bytes.byteLength }
    picked.push(f)
    await take(batcher, f, e.bytes, skipped)
  }
  if (open.size > 0) throw new Error(`repos: the tarball changed between two reads (first missing: ${[...open][0]})`)
  return { picked, notCopied: pick.notCopied }
}

/**
 * Stored rows of paths that are not (or no longer) copied go first, then
 * Drive drops what the repo should not hold: rows never claim more than
 * Drive has.
 */
async function finishTree(deps: SyncDeps, repo: TreeRepo, deleteRows: string[], copiedPaths: string[]): Promise<void> {
  if (deleteRows.length > 0) await deps.store.deleteSourceFiles(repo.sourceId, deleteRows)
  const items = await deps.drive.list(REPOS_DRIVE_SOURCE, repoKey(repo.repoId))
  await removeUnexpected(deps, expectedKeys(repo.repoId, copiedPaths.length > 0, copiedPaths), items)
}

/**
 * Executes the tree plan: fetches the changed files' bytes (per blob, or the
 * tarball when there are many / it is a first sync / the tree was truncated),
 * writes them to Drive batch by batch with their file rows, deletes what is
 * gone, and returns the final tree section for the snapshot. Any blob-sha
 * mismatch against the tree fails loud, before that file is written.
 */
export async function syncTree(
  deps: SyncDeps,
  client: GitHubTokenClient,
  repo: TreeRepo,
  plan: TreePlan,
  storedFiles: FileSnap[],
): Promise<{ snap: TreeSnap; writes: number }> {
  const batcher = new TreeBatcher(deps, repo)
  let picked = plan.picked
  let gone = plan.gone
  let notCopied: NotCopied[] = [...plan.notCopied]
  let skipped: Skipped
  if (plan.truncated) {
    skipped = { lfs: [], filtered: [] }
    const out = await withTarball(client, repo, plan.commitSha, (tarPath) => fromTruncatedTarball(deps, batcher, tarPath, plan.mode, skipped))
    picked = out.picked
    notCopied = out.notCopied
    const pickedPaths = new Set(picked.map((p) => p.path))
    gone = storedFiles.filter((f) => !pickedPaths.has(f.path)).map((f) => f.path)
  } else {
    skipped = await fetchFiles(deps, client, repo, batcher, plan.commitSha, plan.changed, plan.viaTarball)
  }
  const left = new Set([...skipped.lfs, ...skipped.filtered].map((n) => n.path))
  const copied = picked.filter((p) => !left.has(p.path))
  await batcher.done(copied.length > 0)
  await finishTree(deps, repo, [...new Set([...gone, ...left])], copied.map((f) => f.path))
  return {
    snap: {
      commitSha: plan.commitSha,
      mode: plan.mode,
      count: copied.length,
      bytes: copied.reduce((n, f) => n + f.size, 0),
      notCopied: [...notCopied, ...skipped.lfs, ...skipped.filtered],
      truncated: plan.truncated,
    },
    writes: batcher.writes,
  }
}

/**
 * The head did not move: no new plan, just keep Drive honest. Files the rows
 * list but Drive lacks (a folder deleted by hand) are fetched again through
 * the same channels as a sync (≤ 50 per blob, else the tarball) with the same
 * checks; items the tree no longer has go; the tree folder is re-ensured so a
 * renamed default branch renames it — its key never moves.
 */
export async function reconcileTree(
  deps: SyncDeps,
  client: GitHubTokenClient,
  repo: TreeRepo,
  tree: TreeSnap,
  storedFiles: FileSnap[],
): Promise<{ snap: TreeSnap; writes: number }> {
  const treeK = treeFolderKey(repo.repoId)
  const items = await deps.drive.list(REPOS_DRIVE_SOURCE, repoKey(repo.repoId))
  const present = new Set(items.map((i) => i.key))
  const batcher = new TreeBatcher(deps, repo, present)
  const missing = storedFiles.filter((f) => !present.has(`${treeK}/${f.path}`))
  let dropped: NotCopied[] = []
  if (missing.length > 0 && tree.commitSha !== null) {
    const pick = pickFiles(missing, tree.mode)
    const skipped = await fetchFiles(deps, client, repo, batcher, tree.commitSha, pick.copied, pick.copied.length > SMALL_BLOB_LIMIT)
    dropped = [...pick.notCopied, ...skipped.lfs, ...skipped.filtered]
  }
  const droppedPaths = new Set(dropped.map((n) => n.path))
  const copied = storedFiles.filter((f) => !droppedPaths.has(f.path))
  await batcher.done(copied.length > 0)
  if (droppedPaths.size > 0) await deps.store.deleteSourceFiles(repo.sourceId, [...droppedPaths])
  await removeUnexpected(deps, expectedKeys(repo.repoId, copied.length > 0, copied.map((f) => f.path)), items)
  return {
    snap: {
      ...tree,
      count: copied.length,
      bytes: copied.reduce((n, f) => n + f.size, 0),
      notCopied: [...tree.notCopied, ...dropped],
    },
    writes: batcher.writes,
  }
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
      const out = await reconcileTree(deps, client, repo, result.snapshot.tree!, storedFiles)
      treeSnap = out.snap
      treeWrites = out.writes
    }
    const snapshot: RepoSnapshot = { ...result.snapshot, tree: treeSnap }
    const delta = diffSnapshots(row.snapshot, snapshot)
    const moved = !deltaIsEmpty(delta)
    const summary: SummaryPatch = moved ? await summarize(deps, row, snapshot, delta, now) : row
    await writeRepo(deps.drive, render(snapshot, summaryStateOf(summary)))
    // The repo moved to another owner: its old owner folder goes if it is empty now.
    const oldOwner = folderOwnerOf(row)
    if (oldOwner !== null && oldOwner !== snapshot.repo.owner) await pruneOwnerFolder(deps, oldOwner, new Set([row.id]))
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
      if (err.kind === 'too_large') {
        // Not a hiccup: the next normal interval, no retry storm, and words the admin can act on.
        const message = tokenMessages.tooLarge(deps.tarballMaxBytes)
        await deps.store.updateSource(row.id, { lastError: message, dueAt: next, ...release })
        return { status: 'failed', error: message }
      }
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
  // Once per tick: a sync that crashed mid-download leaves its tarball behind.
  await deps.sweepTarballs(deps.tarballDir, TARBALL_SWEEP_AGE_MS, deps.now())
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
