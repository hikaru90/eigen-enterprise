/** Drive metadata (Postgres in production, memory in tests). Bytes live in the BlobStore. */

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
export type FilePatch = Partial<Pick<DriveFile, 'name' | 'folderId' | 'trashedAt' | 'updatedAt' | 'mime' | 'size' | 'sha256' | 'archivedAt' | 'archivedBy'>>

export type DriveStore = {
  getFolder(id: string): Promise<DriveFolder | null>
  getFile(id: string): Promise<DriveFile | null>
  /** Direct children of a folder (null = the top level), trashed ones included. */
  children(folderId: string | null): Promise<{ folders: DriveFolder[]; files: DriveFile[] }>
  /** Every item whose name contains `query` (case-insensitive); everything when query is ''. */
  findByName(query: string): Promise<{ folders: DriveFolder[]; files: DriveFile[] }>
  /** Every archived folder and file (trashed ones included; the service decides what shows). */
  listArchived(): Promise<{ folders: DriveFolder[]; files: DriveFile[] }>
  /** Files not trashed and not archived themselves, last changed before `before`, oldest first. */
  filesChangedBefore(before: Date): Promise<DriveFile[]>
  insertFolder(folder: DriveFolder): Promise<void>
  insertFile(file: DriveFile): Promise<void>
  updateFolder(id: string, patch: FolderPatch): Promise<void>
  updateFile(id: string, patch: FilePatch): Promise<void>
  deleteFolder(id: string): Promise<void>
  /** Deletes the file and its revisions. */
  deleteFile(id: string): Promise<void>
  insertRevision(rev: DriveRevision): Promise<void>
  listRevisions(fileId: string): Promise<DriveRevision[]>
  getRevision(id: string): Promise<DriveRevision | null>
  /** Folds a save into an existing revision (one revision per editing session). */
  updateRevision(id: string, patch: Pick<DriveRevision, 'sha256' | 'size' | 'createdAt'>): Promise<void>
  /** Whether any file or revision still points at this blob. */
  blobInUse(sha256: string): Promise<boolean>
  /** Bytes on disk: the sum over distinct blobs referenced by files or revisions. */
  storageBytes(): Promise<number>
  /** Every source's root folder (top-level folders with a source), trashed ones included. */
  sourceRoots(): Promise<DriveFolder[]>
  getSourceItem(source: string, externalKey: string): Promise<DriveSourceRow | null>
  /** Inserts or replaces the row for (source, externalKey). */
  putSourceItem(row: DriveSourceRow): Promise<void>
  listSourceItems(source: string): Promise<DriveSourceRow[]>
  deleteSourceItem(source: string, externalKey: string): Promise<void>
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
  return {
    async getFolder(id) {
      return folders.get(id) ?? null
    },
    async getFile(id) {
      return files.get(id) ?? null
    },
    async children(folderId) {
      return {
        folders: [...folders.values()].filter((f) => f.parentId === folderId),
        files: [...files.values()].filter((f) => f.folderId === folderId),
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
    async insertFile(f) {
      files.set(f.id, { ...f })
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
    async deleteFile(id) {
      files.delete(id)
      for (const [rid, r] of revisions) if (r.fileId === id) revisions.delete(rid)
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
    async putSourceItem(row) {
      const clash = [...sourceItems.values()].find((r) => r.kind === row.kind && r.itemId === row.itemId && keyOf(r.source, r.externalKey) !== keyOf(row.source, row.externalKey))
      if (clash) throw new Error(`drive ${row.kind} ${row.itemId} already belongs to ${clash.source} ${clash.externalKey}`)
      sourceItems.set(keyOf(row.source, row.externalKey), { ...row })
    },
    async listSourceItems(source) {
      return [...sourceItems.values()].filter((r) => r.source === source).map((r) => ({ ...r }))
    },
    async deleteSourceItem(source, externalKey) {
      sourceItems.delete(keyOf(source, externalKey))
    },
  }
}
