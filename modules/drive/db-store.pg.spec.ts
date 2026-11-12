import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * The Drive DB store against real Postgres (the test DB, :5433): the archive
 * state (migration 0126) round-trips, and the queries behind the Archived
 * view and "suggest what to archive" select by data. Needs DATABASE_URL with
 * migrations applied; skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

let sql: postgres.Sql
vi.mock('./db', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js')
  return { driveDb: async () => drizzle(sql) }
})

describe.skipIf(!url)('drive store (Postgres): archive state', () => {
  const folders: string[] = []
  const files: string[] = []

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
  })

  afterAll(async () => {
    if (files.length > 0) await sql`delete from drive_file where id in ${sql(files)}`
    if (folders.length > 0) await sql`delete from drive_folder where id in ${sql(folders)}`
    await sql.end()
  })

  const at = (iso: string) => new Date(iso)
  const folder = (over: { parentId?: string | null } = {}) => {
    const id = randomUUID()
    folders.push(id)
    return { id, parentId: over.parentId ?? null, name: `pg-${id}`, ownerId: 'pg-spec', createdAt: at('2024-01-01T00:00:00Z'), updatedAt: at('2024-01-01T00:00:00Z'), trashedAt: null, archivedAt: null, archivedBy: null }
  }
  const file = (folderId: string | null, updated: string) => {
    const id = randomUUID()
    files.push(id)
    return {
      id,
      folderId,
      name: `pg-${id}.md`,
      ownerId: 'pg-spec',
      mime: 'text/markdown',
      size: 1,
      sha256: 'a'.repeat(64),
      createdAt: at(updated),
      updatedAt: at(updated),
      trashedAt: null,
      archivedAt: null,
      archivedBy: null,
    }
  }

  it('archivedAt/archivedBy are stored and cleared on files and folders', async () => {
    const { dbDriveStore: store } = await import('./db-store')
    const f = folder()
    await store.insertFolder(f)
    const x = file(f.id, '2024-02-01T00:00:00Z')
    await store.insertFile(x)
    expect(await store.getFile(x.id)).toMatchObject({ archivedAt: null, archivedBy: null })
    const when = at('2026-11-12T10:00:00Z')
    await store.updateFile(x.id, { archivedAt: when, archivedBy: 'alice' })
    await store.updateFolder(f.id, { archivedAt: when, archivedBy: 'bob' })
    expect(await store.getFile(x.id)).toMatchObject({ archivedAt: when, archivedBy: 'alice' })
    expect(await store.getFolder(f.id)).toMatchObject({ archivedAt: when, archivedBy: 'bob' })
    const listed = await store.listArchived()
    expect(listed.files.map((r) => r.id)).toContain(x.id)
    expect(listed.folders.map((r) => r.id)).toContain(f.id)
    await store.updateFile(x.id, { archivedAt: null, archivedBy: null })
    expect((await store.listArchived()).files.map((r) => r.id)).not.toContain(x.id)
  })

  it('filesChangedBefore: live files (not trashed, not archived) unchanged since the cut-off, oldest first', async () => {
    const { dbDriveStore: store } = await import('./db-store')
    const older = file(null, '2020-01-01T00:00:00Z')
    const old = file(null, '2020-06-01T00:00:00Z')
    const fresh = file(null, '2026-11-01T00:00:00Z')
    const archived = file(null, '2019-01-01T00:00:00Z')
    const trashed = file(null, '2019-01-01T00:00:00Z')
    for (const r of [old, older, fresh, archived, trashed]) await store.insertFile(r)
    await store.updateFile(archived.id, { archivedAt: new Date(), archivedBy: 'x' })
    await store.updateFile(trashed.id, { trashedAt: new Date() })
    const got = (await store.filesChangedBefore(at('2021-01-01T00:00:00Z'))).map((r) => r.id).filter((id) => files.includes(id))
    expect(got).toEqual([older.id, old.id])
  })
})
