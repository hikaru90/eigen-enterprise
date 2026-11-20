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
  /** Atomically writes one parents-first batch (the caller batches about 500 items). */
  upsertMany(source: DriveSourceId, items: DriveSourceBatchItem[]): Promise<void>
  /** Deletes for good every item whose key is `keyPrefix` or starts with `keyPrefix + '/'`; returns how many. */
  remove(source: DriveSourceId, keyPrefix: string): Promise<number>
  /** Source items in key order, optionally the exact key and its descendants only. */
  list(source: DriveSourceId, keyPrefix?: string): Promise<DriveSourceItem[]>
}

export type SourceWriterDeps = {
  store: DriveStore
  blobs: BlobStore
  access: Pick<DriveAccessPort, 'systemGrants' | 'listGrants'>
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

  /** Blob deletion is post-commit: a metadata rollback never deletes bytes another file still uses. */
  async function removeUnreferenced(shas: Iterable<string>): Promise<void> {
    const candidates = [...new Set(shas)]
    if (candidates.length === 0) return
    const used = new Set(await store.usedBlobShas(candidates))
    for (const sha of candidates) if (!used.has(sha)) await blobs.remove(sha)
  }

  async function writeBatch(source: DriveSourceId, items: DriveSourceBatchItem[]): Promise<BatchResult> {
    checkId('id', source)
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

    const createdBlobs = new Set<string>()
    const retiredBlobs = new Set<string>()
    try {
      const written = await store.transaction(async (tx) => {
        const root = await requireRoot(source, tx)
        const lookupKeys = [...new Set(items.flatMap((item) => (item.parentKey === null ? [item.key] : [item.key, item.parentKey])))]
        const existingRows = await tx.getSourceItems(source, lookupKeys)
        const rowsByKey = new Map(existingRows.map((row) => [row.externalKey, row] as const))
        const [folderRows, fileRows] = await Promise.all([
          tx.getFolders(existingRows.filter((row) => row.kind === 'folder').map((row) => row.itemId)),
          tx.getFiles(existingRows.filter((row) => row.kind === 'file').map((row) => row.itemId)),
        ])
        const foldersById = new Map(folderRows.map((row) => [row.id, row] as const))
        const filesById = new Map(fileRows.map((row) => [row.id, row] as const))
        const newFolders: DriveFolder[] = []
        const newFiles: DriveFile[] = []
        const folderUpdates: Array<{ id: string; patch: FolderPatch; moved: boolean }> = []
        const fileUpdates: Array<{ id: string; patch: FilePatch }> = []
        const sourceUpdates: DriveSourceRow[] = []
        const results: BatchResult = []
        const blobWrites = new Map<string, Promise<{ sha256: string; size: number; created: boolean }>>()

        const putBlob = (bytes: Uint8Array, sha: string) => {
          const existing = blobWrites.get(sha)
          if (existing) return existing
          const write = blobs.put(bytes).then((blob) => {
            if (blob.sha256 !== sha) throw new Error(`drive blob store returned ${blob.sha256} for content hashed as ${sha}`)
            if (blob.created) createdBlobs.add(sha)
            return blob
          })
          blobWrites.set(sha, write)
          return write
        }

        for (const item of items) {
          let parentId = root.id
          if (item.parentKey !== null) {
            const parent = rowsByKey.get(item.parentKey)
            if (!parent) throw new Error(`drive source ${source}: parent ${item.parentKey} does not exist`)
            if (parent.kind !== 'folder') throw new Error(`drive source ${source}: parent ${item.parentKey} is a file, not a folder`)
            parentId = parent.itemId
          }
          const existing = rowsByKey.get(item.key)

          if (item.kind === 'folder') {
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
          const content = item.kind === 'text' ? new TextEncoder().encode(item.content) : item.bytes
          const mime = item.kind === 'text' ? 'text/markdown' : item.mime
          const sha = sha256Hex(content)
          let file = existing ? filesById.get(existing.itemId) : null
          if (existing && !file) throw new Error(`drive source ${source}: file ${existing.itemId} for ${item.key} is missing`)
          const changed = !file || file.sha256 !== sha
          let size = content.byteLength
          if (changed) {
            const blob = await putBlob(content, sha)
            size = blob.size
            if (file) retiredBlobs.add(file.sha256)
          }
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
      await removeUnreferenced(retiredBlobs)
      return written
    } catch (err) {
      const cleanupErrors: unknown[] = []
      for (const sha of createdBlobs) {
        try {
          // A concurrent writer may have committed a reference to the same content.
          if (!(await store.blobInUse(sha))) await blobs.remove(sha)
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([err, ...cleanupErrors], `drive source ${source}: batch failed and new-blob cleanup also failed`, { cause: err })
      }
      throw err
    }
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
      const doomed = await store.listSourceItems(source, keyPrefix)
      if (doomed.length === 0) return 0
      const fileRows = doomed.filter((row) => row.kind === 'file')
      const folderRows = doomed.filter((row) => row.kind === 'folder')
      const [files, folders] = await Promise.all([
        store.getFiles(fileRows.map((row) => row.itemId)),
        store.getFolders(folderRows.map((row) => row.itemId)),
      ])
      const filesById = new Map(files.map((file) => [file.id, file] as const))
      const foldersById = new Map(folders.map((folder) => [folder.id, folder] as const))
      for (const row of fileRows) {
        if (!filesById.has(row.itemId)) throw new Error(`drive source ${source}: file ${row.itemId} for ${row.externalKey} is missing`)
      }
      for (const row of folderRows) {
        if (!foldersById.has(row.itemId)) throw new Error(`drive source ${source}: folder ${row.itemId} for ${row.externalKey} is missing`)
      }

      // Nothing mapped outside the prefix (or a person's unmapped item) may be deleted with the folder.
      const children = await store.childrenOfFolders(folderRows.map((row) => row.itemId))
      const folderIds = new Set(folderRows.map((row) => row.itemId))
      const fileIds = new Set(fileRows.map((row) => row.itemId))
      const folderById = new Map(folderRows.map((row) => [row.itemId, row] as const))
      for (const child of children.folders) {
        if (!folderIds.has(child.id)) {
          const parent = folderById.get(child.parentId!)!
          throw new Error(`drive source ${source}: folder ${parent.externalKey} still holds items outside ${keyPrefix}`)
        }
      }
      for (const child of children.files) {
        if (!fileIds.has(child.id)) {
          const parent = folderById.get(child.folderId!)!
          throw new Error(`drive source ${source}: folder ${parent.externalKey} still holds items outside ${keyPrefix}`)
        }
      }

      for (const row of doomed) await dropGrants(source, row.kind, row.itemId)
      await store.transaction(async (tx) => {
        await tx.deleteFiles([...fileIds])
        await tx.deleteFolders([...folderIds])
        await tx.deleteSourceItems(source, doomed.map((row) => row.externalKey))
      })
      await removeUnreferenced(files.map((file) => file.sha256))
      return doomed.length
    },

    async list(source, keyPrefix) {
      checkId('id', source)
      if (keyPrefix !== undefined) checkId('key prefix', keyPrefix)
      return (await store.listSourceItems(source, keyPrefix)).map(toItem)
    },
  }

  /** Sharing an admin added below the root goes with the item (only then is there anything to drop). */
  async function dropGrants(source: string, type: 'folder' | 'file', id: string): Promise<void> {
    if ((await access.listGrants(type, id)).length > 0) await access.systemGrants(source, type, id, [])
  }
}
