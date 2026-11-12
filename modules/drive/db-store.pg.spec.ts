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
    return { id, parentId: over.parentId ?? null, name: `pg-${id}`, ownerId: 'pg-spec', createdAt: at('2024-01-01T00:00:00Z'), updatedAt: at('2024-01-01T00:00:00Z'), trashedAt: null, archivedAt: null, archivedBy: null, source: null }
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
      source: null,
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

describe.skipIf(!url)('drive store (Postgres): source folders (0133)', () => {
  const source = `pg-spec-${randomUUID()}`
  const folders: string[] = []
  const files: string[] = []

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
  })

  afterAll(async () => {
    await sql`delete from drive_source_items where source = ${source}`
    if (files.length > 0) await sql`delete from drive_file where id in ${sql(files)}`
    if (folders.length > 0) await sql`delete from drive_folder where id in ${sql(folders)}`
    await sql.end()
  })

  const at = new Date('2026-11-12T10:00:00Z')
  const folder = (parentId: string | null, src: string | null) => {
    const id = randomUUID()
    folders.push(id)
    return { id, parentId, name: `pg-${id}`, ownerId: 'pg-spec', createdAt: at, updatedAt: at, trashedAt: null, archivedAt: null, archivedBy: null, source: src }
  }

  it('source round-trips on folders and files; sourceRoots lists top-level source folders only', async () => {
    const { dbDriveStore: store } = await import('./db-store')
    const root = folder(null, source)
    const sub = folder(root.id, source)
    const plain = folder(null, null)
    for (const f of [root, sub, plain]) await store.insertFolder(f)
    const fileId = randomUUID()
    files.push(fileId)
    await store.insertFile({ id: fileId, folderId: sub.id, name: 'Overview.md', ownerId: 'pg-spec', mime: 'text/markdown', size: 1, sha256: 'b'.repeat(64), createdAt: at, updatedAt: at, trashedAt: null, archivedAt: null, archivedBy: null, source })
    expect(await store.getFolder(sub.id)).toMatchObject({ source })
    expect(await store.getFolder(plain.id)).toMatchObject({ source: null })
    expect(await store.getFile(fileId)).toMatchObject({ source })
    const roots = (await store.sourceRoots()).filter((r) => r.source === source)
    expect(roots.map((r) => r.id)).toEqual([root.id])
    // One root per source.
    await expect(store.insertFolder(folder(null, source))).rejects.toThrow()
  })

  it('source items: put inserts then replaces by (source, key); list is by source in key order; delete removes one', async () => {
    const { dbDriveStore: store } = await import('./db-store')
    const a = { source, externalKey: 'repo:1', itemId: randomUUID(), kind: 'folder' as const, parentKey: null, contentSha: null }
    const b = { source, externalKey: 'repo:1/Overview.md', itemId: randomUUID(), kind: 'file' as const, parentKey: 'repo:1', contentSha: 'c'.repeat(64) }
    await store.putSourceItem(b)
    await store.putSourceItem(a)
    expect(await store.getSourceItem(source, 'repo:1')).toEqual(a)
    await store.putSourceItem({ ...b, contentSha: 'd'.repeat(64) })
    expect(await store.listSourceItems(source)).toEqual([a, { ...b, contentSha: 'd'.repeat(64) }])
    expect(await store.listSourceItems(`${source}-other`)).toEqual([])
    await store.deleteSourceItem(source, 'repo:1')
    expect(await store.getSourceItem(source, 'repo:1')).toBeNull()
    await expect(sql`insert into drive_source_items (source, external_key, item_id, kind) values (${source}, 'bad', ${randomUUID()}, 'link')`).rejects.toThrow()
  })

  it('the system writer over Postgres: upsert, sha no-op, remove by prefix', async () => {
    const { dbDriveStore: store } = await import('./db-store')
    const { createDriveSourceWriter } = await import('./source-writer')
    const { memoryDriveAccess } = await import('./memory-access')
    const blobs = new Map<string, Uint8Array>()
    const { sha256Hex } = await import('./storage')
    const writer = createDriveSourceWriter({
      store,
      access: memoryDriveAccess({ users: {} }),
      blobs: {
        put: async (b) => {
          const sha = sha256Hex(b)
          blobs.set(sha, b)
          return { sha256: sha, size: b.byteLength, created: true }
        },
        get: async (sha) => blobs.get(sha)!,
        has: async (sha) => blobs.has(sha),
        remove: async (sha) => void blobs.delete(sha),
      },
    })
    const src = `${source}-w`
    try {
      const root = await writer.ensureRoot(src, 'GitHub')
      folders.push(root.folderId)
      folders.push(await writer.upsertFolder(src, 'repo:1', null, 'acme'))
      const first = await writer.upsertText(src, 'repo:1/Overview.md', 'repo:1', 'Overview.md', `pg ${src}`)
      files.push(first.fileId)
      expect(await writer.upsertText(src, 'repo:1/Overview.md', 'repo:1', 'Overview.md', `pg ${src}`)).toEqual({ fileId: first.fileId, changed: false })
      expect((await writer.list(src)).map((i) => i.key)).toEqual(['repo:1', 'repo:1/Overview.md'])
      expect(await writer.remove(src, 'repo:1')).toBe(2)
      expect(await writer.list(src)).toEqual([])
      expect(await store.getFile(first.fileId)).toBeNull()
    } finally {
      await sql`delete from drive_source_items where source = ${src}`
    }
  })
})
