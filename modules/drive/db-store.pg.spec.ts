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
      contentDate: null as Date | null,
      contentDateKind: null as 'taken' | 'created' | null,
    }
  }

  it('stores the date a file records about itself, and refuses half a date', async () => {
    const { dbDriveStore: store } = await import('./db-store')
    const f = folder()
    await store.insertFolder(f)
    const x = { ...file(f.id, '2024-02-01T00:00:00Z'), contentDate: at('2019-03-14T09:30:00Z'), contentDateKind: 'taken' as const }
    await store.insertFile(x)
    expect(await store.getFile(x.id)).toMatchObject({ contentDate: at('2019-03-14T09:30:00Z'), contentDateKind: 'taken' })
    const half = { ...file(f.id, '2024-02-01T00:00:00Z'), contentDate: at('2019-03-14T09:30:00Z') }
    await expect(store.insertFile(half)).rejects.toThrow()
  })

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
    await store.insertFile({ id: fileId, folderId: sub.id, name: 'Overview.md', ownerId: 'pg-spec', mime: 'text/markdown', size: 1, sha256: 'b'.repeat(64), createdAt: at, updatedAt: at, trashedAt: null, archivedAt: null, archivedBy: null, source, contentDate: null, contentDateKind: null })
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

describe.skipIf(!url)('drive store (Postgres): source batching (full-mirror M2)', () => {
  const source = `pg-spec-${randomUUID()}`
  const bytes = (s: string) => new TextEncoder().encode(s)

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 4, onnotice: () => {} })
  })

  afterAll(async () => {
    await sql`delete from drive_source_items where source = ${source}`
    await sql`delete from drive_file where source = ${source}`
    await sql`delete from drive_folder where source = ${source}`
    await sql.end()
  })

  /** The writer over the real store, with a counting in-memory blob store. */
  async function makeWriter() {
    const { dbDriveStore: store } = await import('./db-store')
    const { createDriveSourceWriter } = await import('./source-writer')
    const { memoryDriveAccess } = await import('./memory-access')
    const { sha256Hex } = await import('./storage')
    const blobs = new Map<string, Uint8Array>()
    let puts = 0
    const writer = createDriveSourceWriter({
      store,
      access: memoryDriveAccess({ users: {} }),
      blobs: {
        put: async (b) => {
          puts += 1
          const sha = sha256Hex(b)
          const had = blobs.has(sha)
          blobs.set(sha, b)
          return { sha256: sha, size: b.byteLength, created: !had }
        },
        get: async (sha) => blobs.get(sha)!,
        has: async (sha) => blobs.has(sha),
        remove: async (sha) => void blobs.delete(sha),
      },
    })
    return { writer, store, blobCount: () => puts, blobsHas: (sha: string) => blobs.has(sha) }
  }

  it('transaction rolls back everything a failed batch wrote', async () => {
    const { dbDriveStore: store } = await import('./db-store')
    const folder = { id: randomUUID(), parentId: null, name: 'doomed', ownerId: source, createdAt: new Date(), updatedAt: new Date(), trashedAt: null, archivedAt: null, archivedBy: null, source }
    const file = { id: randomUUID(), folderId: folder.id, name: 'doomed.md', ownerId: source, mime: 'text/markdown', size: 2, sha256: 'a'.repeat(64), createdAt: new Date(), updatedAt: new Date(), trashedAt: null, archivedAt: null, archivedBy: null, source, contentDate: null, contentDateKind: null }
    await expect(
      store.transaction(async (tx) => {
        await tx.insertFolder(folder)
        await tx.insertFile(file)
        await tx.putSourceItem({ source, externalKey: 'doomed', itemId: folder.id, kind: 'folder', parentKey: null, contentSha: null })
        throw new Error('forced failure inside the transaction')
      }),
    ).rejects.toThrow('forced failure inside the transaction')
    expect(await store.getFolder(folder.id)).toBeNull()
    expect(await store.getFile(file.id)).toBeNull()
    expect(await store.getSourceItem(source, 'doomed')).toBeNull()
  })

  it('upsertMany writes a 500-scale parents-first batch atomically; a rerun touches no blobs', async () => {
    const { writer, store, blobCount } = await makeWriter()
    await writer.ensureRoot(source, 'GitHub')
    const items = [
      { key: 'repo:1', kind: 'folder' as const, parentKey: null, name: 'acme' },
      { key: 'repo:1/src', kind: 'folder' as const, parentKey: 'repo:1', name: 'src' },
    ]
    for (let i = 0; i < 500; i++)
      items.push({
        key: `repo:1/src/file-${String(i).padStart(3, '0')}.ts`,
        kind: 'text' as const,
        parentKey: 'repo:1/src',
        name: `file-${String(i).padStart(3, '0')}.ts`,
        content: `export const n = ${i}\n`,
      })
    items.push({ key: 'repo:1/logo.png', kind: 'bytes' as const, parentKey: 'repo:1', name: 'logo.png', bytes: Uint8Array.of(0, 255, 1), mime: 'image/png' })
    items.push({ key: 'repo:2', kind: 'folder' as const, parentKey: null, name: 'other' })
    items.push({ key: 'repo:2/notes.md', kind: 'text' as const, parentKey: 'repo:2', name: 'notes.md', content: 'other repo\n' })
    await writer.upsertMany(source, items)

    expect((await writer.list(source)).map((i) => i.key)).toHaveLength(items.length)
    // Exact key or descendants, never a string prefix: repo:1 does not pull in repo:2.
    expect((await writer.list(source, 'repo:1')).map((i) => i.key)).not.toContain('repo:2/notes.md')
    expect((await writer.list(source, 'repo:1'))).toHaveLength(503)
    expect((await writer.list(source, 'repo:1')).map((i) => i.key).filter((k) => k.startsWith('repo:1/'))).toHaveLength(502)
    expect((await writer.list(source, 'repo:2')).map((i) => i.key)).toEqual(['repo:2', 'repo:2/notes.md'])

    const { sha256Hex } = await import('./storage')
    const png = (await store.getSourceItem(source, 'repo:1/logo.png'))!
    expect(png.contentSha).toBe(sha256Hex(Uint8Array.of(0, 255, 1)))
    expect((await store.getFile(png.itemId))!.mime).toBe('image/png')
    const oneText = (await store.getSourceItem(source, 'repo:1/src/file-000.ts'))!
    expect((await store.getFile(oneText.itemId))!.mime).toBe('text/markdown')

    const putsAfterFirst = blobCount()
    await writer.upsertMany(source, items)
    expect(blobCount()).toBe(putsAfterFirst)
  })

  it('remove deletes one repo prefix batched and releases only then-unreferenced blobs', async () => {
    const { writer, store, blobsHas } = await makeWriter()
    await writer.ensureRoot(source, 'GitHub')
    const { sha256Hex } = await import('./storage')
    const shared = bytes('shared bytes')
    const keep = Uint8Array.of(0, 255, 1)
    await writer.upsertMany(source, [
      { key: 'repo:8', kind: 'folder', parentKey: null, name: 'eight' },
      { key: 'repo:8/logo.png', kind: 'bytes', parentKey: 'repo:8', name: 'logo.png', bytes: keep, mime: 'image/png' },
      { key: 'repo:9', kind: 'folder', parentKey: null, name: 'nine' },
      { key: 'repo:9/a.md', kind: 'bytes', parentKey: 'repo:9', name: 'a.md', bytes: shared, mime: 'text/plain' },
      { key: 'repo:9/deep', kind: 'folder', parentKey: 'repo:9', name: 'deep' },
      { key: 'repo:9/deep/b.md', kind: 'bytes', parentKey: 'repo:9/deep', name: 'b.md', bytes: shared, mime: 'text/plain' },
    ])
    const sha = sha256Hex(shared)
    expect(await blobsHas(sha)).toBe(true)

    expect(await writer.remove(source, 'repo:9')).toBe(4)
    expect(await writer.list(source, 'repo:9')).toEqual([])
    for (const key of ['repo:9', 'repo:9/a.md', 'repo:9/deep', 'repo:9/deep/b.md'])
      expect(await store.getSourceItem(source, key)).toBeNull()
    expect(await store.getSourceItem(source, 'repo:8/logo.png')).not.toBeNull()
    // The shared blob went with its last referencing files; repo:8's stays.
    expect(await blobsHas(sha)).toBe(false)
    expect(await blobsHas(sha256Hex(keep))).toBe(true)
    expect(await writer.remove(source, 'repo:9')).toBe(0)
  })
})
