import type { EditLock, EditLockStore } from './locks'
import type { DriveFile, DriveFolder, DriveRevision, DriveSourceRow, DriveStore } from './store'
import { and, asc, eq, ilike, inArray, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { driveEditLock, driveFile, driveFolder, driveRevision, driveSourceItems } from '$lib/server/db/drive.schema'
import { driveDb } from './db'

/** Drive metadata in Postgres (migrations 0109, 0110; archive state 0126; source folders 0133). */

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Ids per IN (…) statement: Postgres binds at most 65,535 parameters per statement. */
export const IN_CHUNK = 5_000

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += IN_CHUNK) out.push(values.slice(i, i + IN_CHUNK))
  return out
}

/** Runs one query per chunk, one after the other (on a transaction they share its connection). */
async function perChunk<T, R>(values: readonly T[], run: (chunk: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = []
  for (const chunk of chunks(values)) out.push(...(await run(chunk)))
  return out
}

type DriveDatabase = Pick<AppDatabase, 'select' | 'selectDistinct' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'>

/**
 * Drive's Postgres store over a resolved handle (the app pool in production;
 * a spec-scoped connection in the pg specs). The transaction-scoped store the
 * transaction callback receives is built from the same factory, so batched
 * source writes stay on one connection; a nested call becomes a savepoint.
 */
export function makeDbDriveStore(resolveDb: () => Promise<DriveDatabase> | DriveDatabase): DriveStore {
  return {
    async transaction(work) {
      const db = await resolveDb()
      return db.transaction((tx) => work(makeDbDriveStore(() => tx)))
    },
    async getFolder(id) {
      const [row] = await (await resolveDb()).select().from(driveFolder).where(eq(driveFolder.id, id)).limit(1)
      return (row as DriveFolder | undefined) ?? null
    },
    async getFolders(ids) {
      const db = await resolveDb()
      return perChunk(ids, async (chunk) => (await db.select().from(driveFolder).where(inArray(driveFolder.id, chunk))) as DriveFolder[])
    },
    async getFile(id) {
      const [row] = await (await resolveDb()).select().from(driveFile).where(eq(driveFile.id, id)).limit(1)
      return (row as DriveFile | undefined) ?? null
    },
    async getFiles(ids) {
      const db = await resolveDb()
      return perChunk(ids, async (chunk) => (await db.select().from(driveFile).where(inArray(driveFile.id, chunk))) as DriveFile[])
    },
    async children(folderId) {
      const db = await resolveDb()
      const [folders, files] = await Promise.all([
        db.select().from(driveFolder).where(folderId === null ? isNull(driveFolder.parentId) : eq(driveFolder.parentId, folderId)),
        db.select().from(driveFile).where(folderId === null ? isNull(driveFile.folderId) : eq(driveFile.folderId, folderId)),
      ])
      return { folders: folders as DriveFolder[], files: files as DriveFile[] }
    },
    async childrenOfFolders(folderIds) {
      const db = await resolveDb()
      const folders = await perChunk(folderIds, async (chunk) => (await db.select().from(driveFolder).where(inArray(driveFolder.parentId, chunk))) as DriveFolder[])
      const files = await perChunk(folderIds, async (chunk) => (await db.select().from(driveFile).where(inArray(driveFile.folderId, chunk))) as DriveFile[])
      return { folders, files }
    },
    async findByName(query) {
      const db = await resolveDb()
      const pattern = `%${escapeLike(query)}%`
      const [folders, files] = await Promise.all([
        db.select().from(driveFolder).where(ilike(driveFolder.name, pattern)),
        db.select().from(driveFile).where(ilike(driveFile.name, pattern)),
      ])
      return { folders: folders as DriveFolder[], files: files as DriveFile[] }
    },
    async listArchived() {
      const db = await resolveDb()
      const [folders, files] = await Promise.all([
        db.select().from(driveFolder).where(isNotNull(driveFolder.archivedAt)),
        db.select().from(driveFile).where(isNotNull(driveFile.archivedAt)),
      ])
      return { folders: folders as DriveFolder[], files: files as DriveFile[] }
    },
    async filesChangedBefore(before) {
      return (await (await resolveDb())
        .select()
        .from(driveFile)
        .where(and(isNull(driveFile.trashedAt), isNull(driveFile.archivedAt), lt(driveFile.updatedAt, before)))
        .orderBy(asc(driveFile.updatedAt), asc(driveFile.id))) as DriveFile[]
    },
    async insertFolder(folder) {
      await (await resolveDb()).insert(driveFolder).values(folder)
    },
    async insertFolders(folders) {
      if (folders.length > 0) await (await resolveDb()).insert(driveFolder).values(folders)
    },
    async insertFile(file) {
      await (await resolveDb()).insert(driveFile).values(file)
    },
    async insertFiles(files) {
      if (files.length > 0) await (await resolveDb()).insert(driveFile).values(files)
    },
    async updateFolder(id, patch) {
      const rows = await (await resolveDb()).update(driveFolder).set(patch).where(eq(driveFolder.id, id)).returning({ id: driveFolder.id })
      if (rows.length !== 1) throw new Error(`drive folder update ${id} matched ${rows.length} rows`)
    },
    async updateFile(id, patch) {
      const rows = await (await resolveDb()).update(driveFile).set(patch).where(eq(driveFile.id, id)).returning({ id: driveFile.id })
      if (rows.length !== 1) throw new Error(`drive file update ${id} matched ${rows.length} rows`)
    },
    async deleteFolder(id) {
      await (await resolveDb()).delete(driveFolder).where(eq(driveFolder.id, id))
    },
    async deleteFolders(ids) {
      const db = await resolveDb()
      for (const chunk of chunks(ids)) await db.delete(driveFolder).where(inArray(driveFolder.id, chunk))
    },
    async deleteFile(id) {
      // drive_revision rows go with it (ON DELETE CASCADE).
      await (await resolveDb()).delete(driveFile).where(eq(driveFile.id, id))
    },
    async deleteFiles(ids) {
      // drive_revision rows go with them (ON DELETE CASCADE).
      const db = await resolveDb()
      for (const chunk of chunks(ids)) await db.delete(driveFile).where(inArray(driveFile.id, chunk))
    },
    async insertRevision(rev) {
      await (await resolveDb()).insert(driveRevision).values(rev)
    },
    async listRevisions(fileId) {
      return (await (await resolveDb())
        .select()
        .from(driveRevision)
        .where(eq(driveRevision.fileId, fileId))
        .orderBy(sql`${driveRevision.createdAt} desc`, sql`${driveRevision.id} desc`)) as DriveRevision[]
    },
    async getRevision(id) {
      const [row] = await (await resolveDb()).select().from(driveRevision).where(eq(driveRevision.id, id)).limit(1)
      return (row as DriveRevision | undefined) ?? null
    },
    async updateRevision(id, patch) {
      await (await resolveDb()).update(driveRevision).set(patch).where(eq(driveRevision.id, id))
    },
    async blobInUse(sha) {
      const db = await resolveDb()
      const [f] = await db.select({ id: driveFile.id }).from(driveFile).where(eq(driveFile.sha256, sha)).limit(1)
      if (f) return true
      const [r] = await db.select({ id: driveRevision.id }).from(driveRevision).where(eq(driveRevision.sha256, sha)).limit(1)
      return !!r
    },
    async usedBlobShas(shas) {
      const db = await resolveDb()
      const used = await perChunk(shas, async (chunk) => [
        ...(await db.selectDistinct({ sha: driveFile.sha256 }).from(driveFile).where(inArray(driveFile.sha256, chunk))),
        ...(await db.selectDistinct({ sha: driveRevision.sha256 }).from(driveRevision).where(inArray(driveRevision.sha256, chunk))),
      ])
      return [...new Set(used.map((row) => row.sha))]
    },
    async storageBytes() {
      const db = await resolveDb()
      const rows = await db.execute<{ total: string | null }>(sql`
        select coalesce(sum(size), 0)::text as total from (
          select sha256, max(size) as size from (
            select sha256, size from drive_file union all select sha256, size from drive_revision
          ) b group by sha256
        ) d`)
      const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: Array<{ total: string | null }> }).rows
      return Number(list[0]?.total ?? 0)
    },
    async sourceRoots() {
      return (await (await resolveDb()).select().from(driveFolder).where(and(isNotNull(driveFolder.source), isNull(driveFolder.parentId)))) as DriveFolder[]
    },
    async getSourceItem(source, externalKey) {
      const [row] = await (await resolveDb())
        .select()
        .from(driveSourceItems)
        .where(and(eq(driveSourceItems.source, source), eq(driveSourceItems.externalKey, externalKey)))
        .limit(1)
      return (row as DriveSourceRow | undefined) ?? null
    },
    async getSourceItems(source, externalKeys) {
      const db = await resolveDb()
      const rows = await perChunk(externalKeys, async (chunk) =>
        (await db
          .select()
          .from(driveSourceItems)
          .where(and(eq(driveSourceItems.source, source), inArray(driveSourceItems.externalKey, chunk)))) as DriveSourceRow[],
      )
      return rows.sort((a, b) => (a.externalKey < b.externalKey ? -1 : a.externalKey > b.externalKey ? 1 : 0))
    },
    async putSourceItem(row) {
      await (await resolveDb())
        .insert(driveSourceItems)
        .values(row)
        .onConflictDoUpdate({
          target: [driveSourceItems.source, driveSourceItems.externalKey],
          set: { itemId: row.itemId, kind: row.kind, parentKey: row.parentKey, contentSha: row.contentSha },
        })
    },
    async putSourceItems(rows) {
      if (rows.length === 0) return
      await (await resolveDb())
        .insert(driveSourceItems)
        .values(rows)
        .onConflictDoUpdate({
          target: [driveSourceItems.source, driveSourceItems.externalKey],
          set: {
            itemId: sql`excluded.item_id`,
            kind: sql`excluded.kind`,
            parentKey: sql`excluded.parent_key`,
            contentSha: sql`excluded.content_sha`,
          },
        })
    },
    async listSourceItems(source, keyPrefix) {
      const where =
        keyPrefix === undefined
          ? eq(driveSourceItems.source, source)
          : and(
              eq(driveSourceItems.source, source),
              or(
                eq(driveSourceItems.externalKey, keyPrefix),
                like(driveSourceItems.externalKey, `${escapeLike(keyPrefix)}/%`),
              ),
            )
      return (await (await resolveDb())
        .select()
        .from(driveSourceItems)
        .where(where)
        .orderBy(asc(driveSourceItems.externalKey))) as DriveSourceRow[]
    },
    async deleteSourceItem(source, externalKey) {
      await (await resolveDb()).delete(driveSourceItems).where(and(eq(driveSourceItems.source, source), eq(driveSourceItems.externalKey, externalKey)))
    },
    async deleteSourceItems(source, externalKeys) {
      const db = await resolveDb()
      for (const chunk of chunks(externalKeys)) await db.delete(driveSourceItems).where(and(eq(driveSourceItems.source, source), inArray(driveSourceItems.externalKey, chunk)))
    },
  }
}

export const dbDriveStore = makeDbDriveStore(driveDb)

/** Edit locks in Postgres (migration 0110): claim is one upsert, so two sessions racing for a lock can't both win. */
export const dbEditLockStore: EditLockStore = {
  async get(fileId) {
    const [row] = await (await driveDb()).select().from(driveEditLock).where(eq(driveEditLock.fileId, fileId)).limit(1)
    return (row as EditLock | undefined) ?? null
  },
  async claim(lock, { staleBefore, force }) {
    const db = await driveDb()
    await db
      .insert(driveEditLock)
      .values(lock)
      .onConflictDoUpdate({
        target: driveEditLock.fileId,
        set: {
          userId: lock.userId,
          sessionId: lock.sessionId,
          heartbeatAt: lock.heartbeatAt,
          acquiredAt: sql`case when ${driveEditLock.sessionId} = ${lock.sessionId} then ${driveEditLock.acquiredAt} else excluded.acquired_at end`,
        },
        setWhere: force
          ? undefined
          : or(eq(driveEditLock.sessionId, lock.sessionId), lt(driveEditLock.heartbeatAt, staleBefore)),
      })
    const cur = await dbEditLockStore.get(lock.fileId)
    if (!cur) throw new Error(`drive edit lock for ${lock.fileId} vanished during claim`)
    return cur
  },
  async touch(fileId, sessionId, at) {
    const rows = await (await driveDb())
      .update(driveEditLock)
      .set({ heartbeatAt: at })
      .where(and(eq(driveEditLock.fileId, fileId), eq(driveEditLock.sessionId, sessionId)))
      .returning({ fileId: driveEditLock.fileId })
    return rows.length === 1
  },
  async release(fileId, sessionId) {
    await (await driveDb()).delete(driveEditLock).where(and(eq(driveEditLock.fileId, fileId), eq(driveEditLock.sessionId, sessionId)))
  },
}
