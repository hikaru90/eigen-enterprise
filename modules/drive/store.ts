/** Drive metadata (Postgres in production, memory in tests). Bytes live in the BlobStore. */

import type { ContentDateKind } from './content-date'

export type DriveFolder = {
  id: string
  parentId: string | null
  name: string
  ownerId: string
  createdAt: Date
  updatedAt: Date
  trashedAt: Date | null
  /** Archived (0126): when and by whom; both null while it is in use. */
  archivedAt: Date | null
  archivedBy: string | null
  /** The source plugin that wrote this read-only copy (migration 0133); null for what people make. */
  source: string | null
}

export type DriveFile = {
  id: string
  folderId: string | null
  name: string
  ownerId: string
  mime: string
  size: number
  sha256: string
  createdAt: Date
  updatedAt: Date
  trashedAt: Date | null
  archivedAt: Date | null
  archivedBy: string | null
  source: string | null
  /** When the file says it is from (migration 0143, see content-date.ts); both null when it records none. */
  contentDate: Date | null
  contentDateKind: ContentDateKind | null
}

/** A source's stable key → its Drive item (drive_source_items, migration 0133). */
export type DriveSourceRow = {
  source: string
  externalKey: string
  itemId: string
  kind: 'folder' | 'file'
  parentKey: string | null
  /** sha256 of a file's bytes; null for folders. */
  contentSha: string | null
}

export type DriveRevision = {
  id: string
  fileId: string
  sha256: string
  size: number
  authorId: string
  createdAt: Date
}

export type FolderPatch = Partial<Pick<DriveFolder, 'name' | 'parentId' | 'trashedAt' | 'updatedAt' | 'archivedAt' | 'archivedBy'>>
export type FilePatch = Partial<
  Pick<DriveFile, 'name' | 'folderId' | 'trashedAt' | 'updatedAt' | 'mime' | 'size' | 'sha256' | 'archivedAt' | 'archivedBy' | 'contentDate' | 'contentDateKind'>
>

export type DriveStore = {
  /** Runs metadata changes atomically; the callback receives the transaction-scoped store. */
  transaction<T>(work: (store: DriveStore) => Promise<T>): Promise<T>
  getFolder(id: string): Promise<DriveFolder | null>
  getFolders(ids: string[]): Promise<DriveFolder[]>
  getFile(id: string): Promise<DriveFile | null>
  getFiles(ids: string[]): Promise<DriveFile[]>
  /** Direct children of a folder (null = the top level), trashed ones included. */
  children(folderId: string | null): Promise<{ folders: DriveFolder[]; files: DriveFile[] }>
  /** Direct children of many folders, for batched source removal. */
  childrenOfFolders(folderIds: string[]): Promise<{ folders: DriveFolder[]; files: DriveFile[] }>
  /** Every item whose name contains `query` (case-insensitive); everything when query is ''. */
  findByName(query: string): Promise<{ folders: DriveFolder[]; files: DriveFile[] }>
  /** Every archived folder and file (trashed ones included; the service decides what shows). */
  listArchived(): Promise<{ folders: DriveFolder[]; files: DriveFile[] }>
  /** Files not trashed and not archived themselves, last changed before `before`, oldest first. */
  filesChangedBefore(before: Date): Promise<DriveFile[]>
  insertFolder(folder: DriveFolder): Promise<void>
  insertFolders(folders: DriveFolder[]): Promise<void>
  insertFile(file: DriveFile): Promise<void>
  insertFiles(files: DriveFile[]): Promise<void>
  updateFolder(id: string, patch: FolderPatch): Promise<void>
  updateFile(id: string, patch: FilePatch): Promise<void>
  deleteFolder(id: string): Promise<void>
  deleteFolders(ids: string[]): Promise<void>
  /** Deletes the file and its revisions. */
  deleteFile(id: string): Promise<void>
  /** Deletes the files and their revisions. */
  deleteFiles(ids: string[]): Promise<void>
  insertRevision(rev: DriveRevision): Promise<void>
  listRevisions(fileId: string): Promise<DriveRevision[]>
  getRevision(id: string): Promise<DriveRevision | null>
  /** Folds a save into an existing revision (one revision per editing session). */
  updateRevision(id: string, patch: Pick<DriveRevision, 'sha256' | 'size' | 'createdAt'>): Promise<void>
  /** Whether any file or revision still points at this blob. */
  blobInUse(sha256: string): Promise<boolean>
  /** The requested blob hashes still referenced by a file or revision. */
  usedBlobShas(sha256s: string[]): Promise<string[]>
  /** Bytes on disk: the sum over distinct blobs referenced by files or revisions. */
  storageBytes(): Promise<number>
  /** Every source's root folder (top-level folders with a source), trashed ones included. */
  sourceRoots(): Promise<DriveFolder[]>
  getSourceItem(source: string, externalKey: string): Promise<DriveSourceRow | null>
  getSourceItems(source: string, externalKeys: string[]): Promise<DriveSourceRow[]>
  /** Inserts or replaces the row for (source, externalKey). */
  putSourceItem(row: DriveSourceRow): Promise<void>
  /** Inserts or replaces many rows in one statement. */
  putSourceItems(rows: DriveSourceRow[]): Promise<void>
  /** Source rows in key order, optionally the exact key and its descendants only. */
  listSourceItems(source: string, keyPrefix?: string): Promise<DriveSourceRow[]>
  deleteSourceItem(source: string, externalKey: string): Promise<void>
  deleteSourceItems(source: string, externalKeys: string[]): Promise<void>
}

export function memoryDriveStore(): DriveStore {
  const folders = new Map<string, DriveFolder>()
  const files = new Map<string, DriveFile>()
  const revisions = new Map<string, DriveRevision>()
  const sourceItems = new Map<string, DriveSourceRow>()
  const keyOf = (source: string, externalKey: string) => JSON.stringify([source, externalKey])
  const must = <T>(v: T | undefined, what: string): T => {
    if (!v) throw new Error(`${what} not found`)
    return v
  }
  const putSourceRow = (row: DriveSourceRow) => {
    const clash = [...sourceItems.values()].find((r) => r.kind === row.kind && r.itemId === row.itemId && keyOf(r.source, r.externalKey) !== keyOf(row.source, row.externalKey))
    if (clash) throw new Error(`drive ${row.kind} ${row.itemId} already belongs to ${clash.source} ${clash.externalKey}`)
    sourceItems.set(keyOf(row.source, row.externalKey), { ...row })
  }
  const api: DriveStore = {
    async transaction(work) {
      const backup = {
        folders: new Map([...folders].map(([id, row]) => [id, { ...row }])),
        files: new Map([...files].map(([id, row]) => [id, { ...row }])),
        revisions: new Map([...revisions].map(([id, row]) => [id, { ...row }])),
        sourceItems: new Map([...sourceItems].map(([id, row]) => [id, { ...row }])),
      }
      const restore = <T>(target: Map<string, T>, snapshot: Map<string, T>) => {
        target.clear()
        for (const [id, row] of snapshot) target.set(id, row)
      }
      try {
        return await work(api)
      } catch (err) {
        restore(folders, backup.folders)
        restore(files, backup.files)
        restore(revisions, backup.revisions)
        restore(sourceItems, backup.sourceItems)
        throw err
      }
    },
    async getFolder(id) {
      return folders.get(id) ?? null
    },
    async getFolders(ids) {
      const wanted = new Set(ids)
      return [...folders.values()].filter((row) => wanted.has(row.id)).map((row) => ({ ...row }))
    },
    async getFile(id) {
      return files.get(id) ?? null
    },
    async getFiles(ids) {
      const wanted = new Set(ids)
      return [...files.values()].filter((row) => wanted.has(row.id)).map((row) => ({ ...row }))
    },
    async children(folderId) {
      return {
        folders: [...folders.values()].filter((f) => f.parentId === folderId),
        files: [...files.values()].filter((f) => f.folderId === folderId),
      }
    },
    async childrenOfFolders(folderIds) {
      const wanted = new Set(folderIds)
      if (wanted.size === 0) return { folders: [], files: [] }
      return {
        folders: [...folders.values()].filter((f) => f.parentId !== null && wanted.has(f.parentId)),
        files: [...files.values()].filter((f) => f.folderId !== null && wanted.has(f.folderId)),
      }
    },
    async findByName(query) {
      const q = query.toLowerCase()
      return {
        folders: [...folders.values()].filter((f) => f.name.toLowerCase().includes(q)),
        files: [...files.values()].filter((f) => f.name.toLowerCase().includes(q)),
      }
    },
    async listArchived() {
      return {
        folders: [...folders.values()].filter((f) => f.archivedAt !== null),
        files: [...files.values()].filter((f) => f.archivedAt !== null),
      }
    },
    async filesChangedBefore(before) {
      return [...files.values()]
        .filter((f) => f.trashedAt === null && f.archivedAt === null && f.updatedAt.getTime() < before.getTime())
        .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime() || a.id.localeCompare(b.id))
    },
    async insertFolder(f) {
      folders.set(f.id, { ...f })
    },
    async insertFolders(rows) {
      for (const row of rows) folders.set(row.id, { ...row })
    },
    async insertFile(f) {
      files.set(f.id, { ...f })
    },
    async insertFiles(rows) {
      for (const row of rows) files.set(row.id, { ...row })
    },
    async updateFolder(id, patch) {
      folders.set(id, { ...must(folders.get(id), `folder ${id}`), ...patch })
    },
    async updateFile(id, patch) {
      files.set(id, { ...must(files.get(id), `file ${id}`), ...patch })
    },
    async deleteFolder(id) {
      folders.delete(id)
    },
    async deleteFolders(ids) {
      for (const id of ids) folders.delete(id)
    },
    async deleteFile(id) {
      files.delete(id)
      for (const [rid, r] of revisions) if (r.fileId === id) revisions.delete(rid)
    },
    async deleteFiles(ids) {
      const doomed = new Set(ids)
      for (const id of doomed) files.delete(id)
      for (const [rid, r] of revisions) if (doomed.has(r.fileId)) revisions.delete(rid)
    },
    async insertRevision(r) {
      revisions.set(r.id, { ...r })
    },
    async listRevisions(fileId) {
      return [...revisions.values()].filter((r) => r.fileId === fileId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    },
    async getRevision(id) {
      return revisions.get(id) ?? null
    },
    async updateRevision(id, patch) {
      const r = revisions.get(id)
      if (r) revisions.set(id, { ...r, ...patch })
    },
    async blobInUse(sha) {
      return [...files.values()].some((f) => f.sha256 === sha) || [...revisions.values()].some((r) => r.sha256 === sha)
    },
    async usedBlobShas(shas) {
      const wanted = new Set(shas)
      return [...new Set([...files.values(), ...revisions.values()].filter((row) => wanted.has(row.sha256)).map((row) => row.sha256))]
    },
    async storageBytes() {
      const sizes = new Map<string, number>()
      for (const f of files.values()) sizes.set(f.sha256, f.size)
      for (const r of revisions.values()) sizes.set(r.sha256, r.size)
      return [...sizes.values()].reduce((a, b) => a + b, 0)
    },
    async sourceRoots() {
      return [...folders.values()].filter((f) => f.source !== null && f.parentId === null)
    },
    async getSourceItem(source, externalKey) {
      const r = sourceItems.get(keyOf(source, externalKey))
      return r ? { ...r } : null
    },
    async getSourceItems(source, externalKeys) {
      const wanted = new Set(externalKeys)
      return [...sourceItems.values()].filter((r) => r.source === source && wanted.has(r.externalKey)).map((r) => ({ ...r }))
    },
    async putSourceItem(row) {
      putSourceRow(row)
    },
    async putSourceItems(rows) {
      for (const row of rows) putSourceRow(row)
    },
    async listSourceItems(source, keyPrefix) {
      return [...sourceItems.values()]
        .filter((r) => r.source === source && (keyPrefix === undefined || r.externalKey === keyPrefix || r.externalKey.startsWith(`${keyPrefix}/`)))
        .sort((a, b) => a.externalKey.localeCompare(b.externalKey))
        .map((r) => ({ ...r }))
    },
    async deleteSourceItem(source, externalKey) {
      sourceItems.delete(keyOf(source, externalKey))
    },
    async deleteSourceItems(source, externalKeys) {
      for (const externalKey of externalKeys) sourceItems.delete(keyOf(source, externalKey))
    },
  }
  return api
}
