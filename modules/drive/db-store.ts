import type { DriveFile, DriveFolder, DriveRevision, DriveStore } from './store'
import { and, eq, ilike, isNull, sql } from 'drizzle-orm'
import { driveFile, driveFolder, driveRevision } from '$lib/server/db/drive.schema'
import { driveDb } from './db'

/** Drive metadata in Postgres (migration 0108). */

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export const dbDriveStore: DriveStore = {
  async getFolder(id) {
    const [row] = await (await driveDb()).select().from(driveFolder).where(eq(driveFolder.id, id)).limit(1)
    return (row as DriveFolder | undefined) ?? null
  },
  async getFile(id) {
    const [row] = await (await driveDb()).select().from(driveFile).where(eq(driveFile.id, id)).limit(1)
    return (row as DriveFile | undefined) ?? null
  },
  async children(folderId) {
    const db = await driveDb()
    const [folders, files] = await Promise.all([
      db.select().from(driveFolder).where(folderId === null ? isNull(driveFolder.parentId) : eq(driveFolder.parentId, folderId)),
      db.select().from(driveFile).where(folderId === null ? isNull(driveFile.folderId) : eq(driveFile.folderId, folderId)),
    ])
    return { folders: folders as DriveFolder[], files: files as DriveFile[] }
  },
  async findByName(query) {
    const db = await driveDb()
    const pattern = `%${escapeLike(query)}%`
    const [folders, files] = await Promise.all([
      db.select().from(driveFolder).where(ilike(driveFolder.name, pattern)),
      db.select().from(driveFile).where(ilike(driveFile.name, pattern)),
    ])
    return { folders: folders as DriveFolder[], files: files as DriveFile[] }
  },
  async insertFolder(folder) {
    await (await driveDb()).insert(driveFolder).values(folder)
  },
  async insertFile(file) {
    await (await driveDb()).insert(driveFile).values(file)
  },
  async updateFolder(id, patch) {
    const rows = await (await driveDb()).update(driveFolder).set(patch).where(eq(driveFolder.id, id)).returning({ id: driveFolder.id })
    if (rows.length !== 1) throw new Error(`drive folder update ${id} matched ${rows.length} rows`)
  },
  async updateFile(id, patch) {
    const rows = await (await driveDb()).update(driveFile).set(patch).where(eq(driveFile.id, id)).returning({ id: driveFile.id })
    if (rows.length !== 1) throw new Error(`drive file update ${id} matched ${rows.length} rows`)
  },
  async deleteFolder(id) {
    await (await driveDb()).delete(driveFolder).where(eq(driveFolder.id, id))
  },
  async deleteFile(id) {
    // drive_revision rows go with it (ON DELETE CASCADE).
    await (await driveDb()).delete(driveFile).where(eq(driveFile.id, id))
  },
  async insertRevision(rev) {
    await (await driveDb()).insert(driveRevision).values(rev)
  },
  async listRevisions(fileId) {
    return (await (await driveDb())
      .select()
      .from(driveRevision)
      .where(eq(driveRevision.fileId, fileId))
      .orderBy(sql`${driveRevision.createdAt} desc`, sql`${driveRevision.id} desc`)) as DriveRevision[]
  },
  async getRevision(id) {
    const [row] = await (await driveDb()).select().from(driveRevision).where(eq(driveRevision.id, id)).limit(1)
    return (row as DriveRevision | undefined) ?? null
  },
  async blobInUse(sha) {
    const db = await driveDb()
    const [f] = await db.select({ id: driveFile.id }).from(driveFile).where(eq(driveFile.sha256, sha)).limit(1)
    if (f) return true
    const [r] = await db.select({ id: driveRevision.id }).from(driveRevision).where(and(eq(driveRevision.sha256, sha))).limit(1)
    return !!r
  },
  async storageBytes() {
    const db = await driveDb()
    const rows = await db.execute<{ total: string | null }>(sql`
      select coalesce(sum(size), 0)::text as total from (
        select sha256, max(size) as size from (
          select sha256, size from drive_file union all select sha256, size from drive_revision
        ) b group by sha256
      ) d`)
    const list = Array.isArray(rows) ? rows : (rows as unknown as { rows: Array<{ total: string | null }> }).rows
    return Number(list[0]?.total ?? 0)
  },
}
