import type { DriveAccessPort } from './access-port'
import type { BlobStore } from './storage'
import type { DriveFile, DriveFolder, DriveSourceRow, DriveStore, FilePatch, FolderPatch } from './store'
import { randomUUID } from 'node:crypto'
import { sha256Hex } from './storage'

/**
 * Drive's system writer for read-only source folders (plan/github-drive.md
 * §5). A source plugin (e.g. GitHub repos) writes its copies through this,
 * by its own stable keys; the items it makes carry `source` and are
 * read-only in the service for everyone.
 *
 * It bypasses Drive's access checks (no person or agent acts) and is never a
 * kernel tool. The types below are structurally the consumer's contract
 * (`DriveSourcePort`, modules/repos/drive-port.ts); Drive never imports it —
 * the composition root (modules/index.ts) hands this writer over.
 */

export type DriveSourceId = string

export type DriveSourceRoot = {
  source: DriveSourceId
  /** Drive folder id of the root. */
  folderId: string
  /** Name shown in the Drive rail and the path. */
  name: string
}

export type DriveSourceItem = {
  key: string
  kind: 'folder' | 'file'
  itemId: string
  /** The parent's key; null for items directly under the root. */
  parentKey: string | null
  /** sha256 of the file's bytes; null for folders. */
  contentSha: string | null
}

type DriveSourceItemLocation = {
  key: string
  parentKey: string | null
  name: string
}

/** One item in an atomic source-writer batch. Parents precede their children. */
export type DriveSourceBatchItem = DriveSourceItemLocation &
  (
    | { kind: 'folder' }
    | { kind: 'text'; content: string }
    | { kind: 'bytes'; bytes: Uint8Array; mime: string }
  )

export type DriveSourceWriter = {
  /** Creates the source's root folder on first use (with the company-wide view grant) or renames it; returns it. Idempotent. */
  ensureRoot(source: DriveSourceId, name: string): Promise<DriveSourceRoot>
  /** Creates or renames/moves a folder addressed by `key`; the parent must exist (null = root). Returns its id. */
  upsertFolder(source: DriveSourceId, key: string, parentKey: string | null, name: string): Promise<string>
  /** Creates or updates a `text/markdown` file (no revisions); a blob and `updatedAt` only when the sha256 changed. */
  upsertText(source: DriveSourceId, key: string, parentKey: string | null, name: string, content: string): Promise<{ fileId: string; changed: boolean }>
  /** Creates or updates bytes with an explicit MIME type (no revisions), with the same idempotence as upsertText. */
  upsertBytes(source: DriveSourceId, key: string, parentKey: string | null, name: string, bytes: Uint8Array, mime: string): Promise<{ fileId: string; changed: boolean }>
  /** Atomically writes one parents-first batch of at most 500 items (more fail loud). */
  upsertMany(source: DriveSourceId, items: DriveSourceBatchItem[]): Promise<void>
  /** Deletes for good every item whose key is `keyPrefix` or starts with `keyPrefix + '/'`; returns how many. */
  remove(source: DriveSourceId, keyPrefix: string): Promise<number>
  /** Source items in key order, optionally the exact key and its descendants only. */
  list(source: DriveSourceId, keyPrefix?: string): Promise<DriveSourceItem[]>
}

export type SourceWriterDeps = {
  store: DriveStore
  blobs: BlobStore
  access: Pick<DriveAccessPort, 'systemGrants' | 'dropSystemGrants'>
  now?: () => Date
}

/** Drive's naming rule, failing loud: a source names things itself, so a bad name is its bug. */
function checkName(name: string): string {
  if (!name || name !== name.trim()) throw new Error(`drive source item name must be non-empty, without leading or trailing spaces, got ${JSON.stringify(name)}`)
  if (name.length > 255) throw new Error(`drive source item name is longer than 255 characters: ${JSON.stringify(name.slice(0, 40))}…`)
  if (/[/\\]/.test(name) || name === '.' || name === '..') throw new Error(`drive source item name can't contain / or \\ (or be . or ..): ${JSON.stringify(name)}`)
  return name
}

function checkId(what: string, value: string): void {
  if (!value) throw new Error(`drive source ${what} must be non-empty`)
}

type BatchResult = Array<{ itemId: string; changed: boolean }>

/** The most items one upsertMany takes: its metadata inserts stay well under Postgres' parameter limit. */
export const SOURCE_BATCH_MAX = 500

/** A batch item with its file content resolved (bytes, MIME, hash). */
type Prepared =
  | { item: DriveSourceBatchItem & { kind: 'folder' } }
  | { item: DriveSourceBatchItem & { kind: 'text' | 'bytes' }; content: Uint8Array; mime: string; sha: string }

export function createDriveSourceWriter(deps: SourceWriterDeps): DriveSourceWriter {
  const { store, blobs, access } = deps
  const now = deps.now ?? (() => new Date())

  async function rootOf(source: string, from: DriveStore = store): Promise<DriveFolder | null> {
    const roots = (await from.sourceRoots()).filter((r) => r.source === source)
    if (roots.length > 1) throw new Error(`drive source ${source} has ${roots.length} root folders`)
    return roots[0] ?? null
  }

  async function requireRoot(source: string, from: DriveStore = store): Promise<DriveFolder> {
    const root = await rootOf(source, from)
    if (!root) throw new Error(`drive source ${source} has no root folder yet: call ensureRoot first`)
    return root
  }

  /** The folders from `folderId` up (itself included). */
  async function chainIds(from: DriveStore, folderId: string): Promise<string[]> {
    const out: string[] = []
    let id: string | null = folderId
    while (id) {
      if (out.includes(id)) throw new Error(`drive folder cycle at ${id}`)
      out.push(id)
      const folder = await from.getFolder(id)
      if (!folder) throw new Error(`drive folder ${id} is missing`)
      id = folder.parentId
    }
    return out
  }

  const toItem = (row: DriveSourceRow): DriveSourceItem => ({
    key: row.externalKey,
    kind: row.kind,
    itemId: row.itemId,
    parentKey: row.parentKey,
    contentSha: row.contentSha,
  })

  async function writeBatch(source: DriveSourceId, items: DriveSourceBatchItem[]): Promise<BatchResult> {
    checkId('id', source)
    if (items.length > SOURCE_BATCH_MAX) throw new Error(`drive source ${source}: a batch of ${items.length} items is too large, send at most ${SOURCE_BATCH_MAX}`)
    const keys = new Set<string>()
    for (const item of items) {
      checkId('key', item.key)
      checkName(item.name)
      if (keys.has(item.key)) throw new Error(`drive source ${source}: duplicate key ${item.key} in batch`)
      keys.add(item.key)
      if (item.kind === 'bytes' && (!item.mime || item.mime !== item.mime.trim())) {
        throw new Error(`drive source ${source}: ${item.key} needs an explicit, trimmed MIME type`)
      }
    }
    if (items.length === 0) return []

    const prepared: Prepared[] = items.map((item) => {
      if (item.kind === 'folder') return { item }
      const content = item.kind === 'text' ? new TextEncoder().encode(item.content) : item.bytes
      return { item, content, mime: item.kind === 'text' ? 'text/markdown' : item.mime, sha: sha256Hex(content) }
    })

    // Bytes go to disk before the transaction opens (no file I/O while it holds locks), and only
    // for content new to its item. Blobs are never deleted here: if the batch then fails, the
    // blob sweep (blob-gc.ts) removes what nothing references once its grace period is over.
    const written = new Set<string>()
    const fileItems = prepared.filter((p): p is Extract<Prepared, { sha: string }> => 'sha' in p)
    if (fileItems.length > 0) {
      const rows = (await store.getSourceItems(source, fileItems.map((p) => p.item.key))).filter((row) => row.kind === 'file')
      const currentSha = new Map((await store.getFiles(rows.map((row) => row.itemId))).map((file) => [file.id, file.sha256] as const))
      const shaByKey = new Map(rows.map((row) => [row.externalKey, currentSha.get(row.itemId)] as const))
      for (const p of fileItems) {
        if (shaByKey.get(p.item.key) === p.sha || written.has(p.sha)) continue
        const blob = await blobs.put(p.content)
        if (blob.sha256 !== p.sha) throw new Error(`drive blob store returned ${blob.sha256} for content hashed as ${p.sha}`)
        written.add(p.sha)
      }
    }

    return store.transaction(async (tx) => {
      const root = await requireRoot(source, tx)
      const lookupKeys = [...new Set(items.flatMap((item) => (item.parentKey === null ? [item.key] : [item.key, item.parentKey])))]
      const existingRows = await tx.getSourceItems(source, lookupKeys)
      const rowsByKey = new Map(existingRows.map((row) => [row.externalKey, row] as const))
      const folderRows = await tx.getFolders(existingRows.filter((row) => row.kind === 'folder').map((row) => row.itemId))
      const fileRows = await tx.getFiles(existingRows.filter((row) => row.kind === 'file').map((row) => row.itemId))
      const foldersById = new Map(folderRows.map((row) => [row.id, row] as const))
      const filesById = new Map(fileRows.map((row) => [row.id, row] as const))
      const newFolders: DriveFolder[] = []
      const newFiles: DriveFile[] = []
      const folderUpdates: Array<{ id: string; patch: FolderPatch; moved: boolean }> = []
      const fileUpdates: Array<{ id: string; patch: FilePatch }> = []
      const sourceUpdates: DriveSourceRow[] = []
      const results: BatchResult = []

      for (const p of prepared) {
        const { item } = p
        let parentId = root.id
        if (item.parentKey !== null) {
          const parent = rowsByKey.get(item.parentKey)
          if (!parent) throw new Error(`drive source ${source}: parent ${item.parentKey} does not exist`)
          if (parent.kind !== 'folder') throw new Error(`drive source ${source}: parent ${item.parentKey} is a file, not a folder`)
          parentId = parent.itemId
        }
        const existing = rowsByKey.get(item.key)

        if (!('sha' in p)) {
          if (existing && existing.kind !== 'folder') throw new Error(`drive source ${source}: ${item.key} is a file, not a folder`)
          let folder = existing ? foldersById.get(existing.itemId) : null
          if (existing && !folder) throw new Error(`drive source ${source}: folder ${existing.itemId} for ${item.key} is missing`)
          if (!folder) {
            const at = now()
            folder = {
              id: randomUUID(),
              parentId,
              name: item.name,
              ownerId: source,
              createdAt: at,
              updatedAt: at,
              trashedAt: null,
              archivedAt: null,
              archivedBy: null,
              source,
            }
            newFolders.push(folder)
            foldersById.set(folder.id, folder)
          } else if (folder.name !== item.name || folder.parentId !== parentId) {
            folderUpdates.push({
              id: folder.id,
              patch: { name: item.name, parentId, updatedAt: now() },
              moved: folder.parentId !== parentId,
            })
          }
          const sourceRow: DriveSourceRow = {
            source,
            externalKey: item.key,
            itemId: folder.id,
            kind: 'folder',
            parentKey: item.parentKey,
            contentSha: null,
          }
          if (!existing || existing.parentKey !== item.parentKey) sourceUpdates.push(sourceRow)
          rowsByKey.set(item.key, sourceRow)
          results.push({ itemId: folder.id, changed: false })
          continue
        }

        if (existing && existing.kind !== 'file') throw new Error(`drive source ${source}: ${item.key} is a folder, not a file`)
        const { content, mime, sha } = p
        let file = existing ? filesById.get(existing.itemId) : null
        if (existing && !file) throw new Error(`drive source ${source}: file ${existing.itemId} for ${item.key} is missing`)
        const changed = !file || file.sha256 !== sha
        // Its bytes were written above only if the item's content was new then; anything else is a concurrent change.
        if (changed && !written.has(sha)) throw new Error(`drive source ${source}: ${item.key} changed while this batch was written; retry the batch`)
        const size = content.byteLength
        if (!file) {
          const at = now()
          file = {
            id: randomUUID(),
            folderId: parentId,
            name: item.name,
            ownerId: source,
            mime,
            size,
            sha256: sha,
            createdAt: at,
            updatedAt: at,
            trashedAt: null,
            archivedAt: null,
            archivedBy: null,
            source,
            // Source bytes record no Drive-owned content date.
            contentDate: null,
            contentDateKind: null,
          }
          newFiles.push(file)
          filesById.set(file.id, file)
        } else {
          const patch: FilePatch = {}
          if (changed) Object.assign(patch, { sha256: sha, size, updatedAt: now() })
          if (file.name !== item.name) patch.name = item.name
          if (file.folderId !== parentId) patch.folderId = parentId
          if (file.mime !== mime) patch.mime = mime
          if (Object.keys(patch).length > 0) fileUpdates.push({ id: file.id, patch })
        }
        const sourceRow: DriveSourceRow = {
          source,
          externalKey: item.key,
          itemId: file.id,
          kind: 'file',
          parentKey: item.parentKey,
          contentSha: sha,
        }
        if (!existing || existing.parentKey !== item.parentKey || existing.contentSha !== sha) sourceUpdates.push(sourceRow)
        rowsByKey.set(item.key, sourceRow)
        results.push({ itemId: file.id, changed })
      }

      // Multi-row inserts keep new items to three metadata statements, not one per item.
      await tx.insertFolders(newFolders)
      for (const update of folderUpdates) {
        if (update.moved && (await chainIds(tx, update.patch.parentId as string)).includes(update.id)) {
          const key = items.find((item) => rowsByKey.get(item.key)?.itemId === update.id)?.key
          throw new Error(`drive source ${source}: ${key} can't move into itself`)
        }
        await tx.updateFolder(update.id, update.patch)
      }
      await tx.insertFiles(newFiles)
      for (const update of fileUpdates) await tx.updateFile(update.id, update.patch)
      await tx.putSourceItems(sourceUpdates)
      return results
    })
  }

  async function upsertBytes(source: DriveSourceId, key: string, parentKey: string | null, name: string, bytes: Uint8Array, mime: string) {
    const [result] = await writeBatch(source, [{ key, parentKey, name, kind: 'bytes', bytes, mime }])
    return { fileId: result!.itemId, changed: result!.changed }
  }

  return {
    async ensureRoot(source, name) {
      checkId('id', source)
      checkName(name)
      const existing = await rootOf(source)
      if (existing) {
        if (existing.name !== name) await store.updateFolder(existing.id, { name, updatedAt: now() })
        return { source, folderId: existing.id, name }
      }
      const at = now()
      const root: DriveFolder = {
        id: randomUUID(),
        parentId: null,
        name,
        ownerId: source,
        createdAt: at,
        updatedAt: at,
        trashedAt: null,
        archivedAt: null,
        archivedBy: null,
        source,
      }
      await store.insertFolder(root)
      // Owner decision: the whole company sees a source; admins can narrow it with normal sharing.
      await access.systemGrants(source, 'folder', root.id, [{ resourceType: 'folder', resourceId: root.id, subject: { kind: 'company' }, level: 'view' }])
      return { source, folderId: root.id, name }
    },

    async upsertFolder(source, key, parentKey, name) {
      const [result] = await writeBatch(source, [{ key, parentKey, name, kind: 'folder' }])
      return result!.itemId
    },

    async upsertText(source, key, parentKey, name, content) {
      const [result] = await writeBatch(source, [{ key, parentKey, name, kind: 'text', content }])
      return { fileId: result!.itemId, changed: result!.changed }
    },

    upsertBytes,

    async upsertMany(source, items) {
      await writeBatch(source, items)
    },

    async remove(source, keyPrefix) {
      checkId('id', source)
      checkId('key prefix', keyPrefix)
      // One transaction: the listing, the outside-prefix check, the grants and the deletes.
      // Bytes stay on disk; the blob sweep removes them once nothing references them.
      return store.transaction(async (tx) => {
        const doomed = await tx.listSourceItems(source, keyPrefix)
        if (doomed.length === 0) return 0
        const fileRows = doomed.filter((row) => row.kind === 'file')
        const folderRows = doomed.filter((row) => row.kind === 'folder')
        // A row whose item is already gone is a stale mapping: only the row goes.
        const files = await tx.getFiles(fileRows.map((row) => row.itemId))
        const folders = await tx.getFolders(folderRows.map((row) => row.itemId))

        // Nothing mapped outside the prefix (or a person's unmapped item) may be deleted with the folder.
        const fileIds = new Set(files.map((file) => file.id))
        const folderIds = new Set(folders.map((folder) => folder.id))
        const rowOfFolder = new Map(folderRows.map((row) => [row.itemId, row] as const))
        const children = await tx.childrenOfFolders([...folderIds])
        const outside = children.folders.find((child) => !folderIds.has(child.id))?.parentId ?? children.files.find((child) => !fileIds.has(child.id))?.folderId
        if (outside) throw new Error(`drive source ${source}: folder ${rowOfFolder.get(outside)!.externalKey} still holds items outside ${keyPrefix}`)

        // Sharing an admin added below the root goes with the items.
        await access.dropSystemGrants(source, [
          ...files.map((file) => ({ resourceType: 'file' as const, resourceId: file.id })),
          ...folders.map((folder) => ({ resourceType: 'folder' as const, resourceId: folder.id })),
        ])

        // Files first, then folders deepest level first: the parent keys are ON DELETE RESTRICT.
        await tx.deleteFiles([...fileIds])
        const parentOf = new Map(folders.map((folder) => [folder.id, folder.parentId] as const))
        const depth = new Map<string, number>()
        const depthOf = (id: string): number => {
          const chain: string[] = []
          let at: string | null | undefined = id
          while (at && folderIds.has(at) && !depth.has(at)) {
            if (chain.includes(at)) throw new Error(`drive folder cycle at ${at}`)
            chain.push(at)
            at = parentOf.get(at)
          }
          let d = at && depth.has(at) ? depth.get(at)! : -1
          for (const c of chain.reverse()) depth.set(c, ++d)
          return depth.get(id)!
        }
        const levels = new Map<number, string[]>()
        for (const id of folderIds) {
          const d = depthOf(id)
          const level = levels.get(d)
          if (level) level.push(id)
          else levels.set(d, [id])
        }
        for (const d of [...levels.keys()].sort((a, b) => b - a)) await tx.deleteFolders(levels.get(d)!)
        await tx.deleteSourceItems(source, doomed.map((row) => row.externalKey))
        return doomed.length
      })
    },

    async list(source, keyPrefix) {
      checkId('id', source)
      if (keyPrefix !== undefined) checkId('key prefix', keyPrefix)
      return (await store.listSourceItems(source, keyPrefix)).map(toItem)
    },
  }
}
