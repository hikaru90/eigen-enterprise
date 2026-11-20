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
        list: async () => [],
        removeIfOlderThan: async () => false,
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

  const dirs: string[] = []
  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  /** The writer over the real store, with disk blobs (puts counted). */
  async function makeWriter() {
    const { dbDriveStore: store } = await import('./db-store')
    const { createDriveSourceWriter } = await import('./source-writer')
    const { memoryDriveAccess } = await import('./memory-access')
    const { diskBlobStore } = await import('./storage')
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'drive-pg-blobs-'))
    dirs.push(dir)
    const disk = diskBlobStore(dir)
    let puts = 0
    const blobs = {
      ...disk,
      put: async (b: Uint8Array) => {
        puts += 1
        return disk.put(b)
      },
    }
    const writer = createDriveSourceWriter({ store, access: memoryDriveAccess({ users: {} }), blobs })
    /** Every stored blob made older than the sweep's grace period. */
    const ageAll = async () => {
      const { utimes } = await import('node:fs/promises')
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
      for (const b of await disk.list()) await utimes(join(dir, 'blobs', b.sha256.slice(0, 2), b.sha256.slice(2, 4), b.sha256), old, old)
    }
    return { writer, store, blobs, blobCount: () => puts, blobsHas: (sha: string) => disk.has(sha), ageAll }
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

  it('upsertMany writes a full 500-item parents-first batch atomically; a rerun touches no blobs', async () => {
    const { writer, store, blobCount } = await makeWriter()
    await writer.ensureRoot(source, 'GitHub')
    const items = [
      { key: 'repo:1', kind: 'folder' as const, parentKey: null, name: 'acme' },
      { key: 'repo:1/src', kind: 'folder' as const, parentKey: 'repo:1', name: 'src' },
    ]
    for (let i = 0; i < 495; i++)
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
    expect(items).toHaveLength(500)
    await writer.upsertMany(source, items)

    expect((await writer.list(source)).map((i) => i.key)).toHaveLength(items.length)
    // Exact key or descendants, never a string prefix: repo:1 does not pull in repo:2.
    expect((await writer.list(source, 'repo:1')).map((i) => i.key)).not.toContain('repo:2/notes.md')
    expect((await writer.list(source, 'repo:1'))).toHaveLength(498)
    expect((await writer.list(source, 'repo:1')).map((i) => i.key).filter((k) => k.startsWith('repo:1/'))).toHaveLength(497)
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

  it('remove deletes one repo prefix batched; the sweep then releases only unreferenced blobs', async () => {
    const { writer, store, blobsHas, blobs, ageAll } = await makeWriter()
    await writer.ensureRoot(source, 'GitHub')
    const { sha256Hex } = await import('./storage')
    const { sweepUnreferencedBlobs, BLOB_GC_GRACE_MS } = await import('./blob-gc')
    const shared = bytes('shared bytes')
    const keep = Uint8Array.of(0, 255, 1)
    await writer.upsertMany(source, [
      { key: 'repo:8', kind: 'folder', parentKey: null, name: 'eight' },
      { key: 'repo:8/logo.png', kind: 'bytes', parentKey: 'repo:8', name: 'logo.png', bytes: keep, mime: 'image/png' },
      { key: 'repo:9', kind: 'folder', parentKey: null, name: 'nine' },
      { key: 'repo:9/a.md', kind: 'bytes', parentKey: 'repo:9', name: 'a.md', bytes: shared, mime: 'text/plain' },
      { key: 'repo:9/deep', kind: 'folder', parentKey: 'repo:9', name: 'deep' },
      { key: 'repo:9/deep/deeper', kind: 'folder', parentKey: 'repo:9/deep', name: 'deeper' },
      { key: 'repo:9/deep/deeper/b.md', kind: 'bytes', parentKey: 'repo:9/deep/deeper', name: 'b.md', bytes: shared, mime: 'text/plain' },
    ])
    const sha = sha256Hex(shared)
    expect(await blobsHas(sha)).toBe(true)

    expect(await writer.remove(source, 'repo:9')).toBe(5)
    expect(await writer.list(source, 'repo:9')).toEqual([])
    for (const key of ['repo:9', 'repo:9/a.md', 'repo:9/deep', 'repo:9/deep/deeper', 'repo:9/deep/deeper/b.md'])
      expect(await store.getSourceItem(source, key)).toBeNull()
    expect(await store.getSourceItem(source, 'repo:8/logo.png')).not.toBeNull()
    // Removal never deletes bytes inline: the sweep does, past its grace period.
    expect(await blobsHas(sha)).toBe(true)
    await ageAll()
    expect((await sweepUnreferencedBlobs({ store, blobs }, new Date(Date.now() - BLOB_GC_GRACE_MS))).removed).toBeGreaterThanOrEqual(1)
    expect(await blobsHas(sha)).toBe(false)
    expect(await blobsHas(sha256Hex(keep))).toBe(true)
    expect(await writer.remove(source, 'repo:9')).toBe(0)
  })

  it('remove takes a 70,000-item prefix in chunked statements (above Postgres’ 65,535 parameters)', async () => {
    const { writer, store } = await makeWriter()
    const root = await writer.ensureRoot(source, 'GitHub')
    await writer.upsertMany(source, [
      { key: 'repo:big', kind: 'folder', parentKey: null, name: 'big' },
      { key: 'repo:big/a', kind: 'folder', parentKey: 'repo:big', name: 'a' },
      { key: 'repo:big/a/b', kind: 'folder', parentKey: 'repo:big/a', name: 'b' },
      { key: 'repo:bigger', kind: 'folder', parentKey: null, name: 'bigger' },
    ])
    const leaf = (await store.getSourceItem(source, 'repo:big/a/b'))!.itemId
    const n = 70_000
    const sha = 'e'.repeat(64)
    await sql`
      insert into drive_file (id, folder_id, name, owner_id, mime, size, sha256, created_at, updated_at, source)
      select ${source} || '-big-' || g, ${leaf}, 'f' || g || '.txt', ${source}, 'text/plain', 1, ${sha}, now(), now(), ${source}
      from generate_series(1, ${n}) g`
    await sql`
      insert into drive_source_items (source, external_key, item_id, kind, parent_key, content_sha)
      select ${source}, 'repo:big/a/b/f' || g || '.txt', ${source} || '-big-' || g, 'file', 'repo:big/a/b', ${sha}
      from generate_series(1, ${n}) g`
    expect(await writer.list(source, 'repo:big')).toHaveLength(n + 3)

    expect(await writer.remove(source, 'repo:big')).toBe(n + 3)
    expect(await writer.list(source, 'repo:big')).toEqual([])
    const [{ count }] = await sql<Array<{ count: string }>>`select count(*)::text as count from drive_file where folder_id = ${leaf}`
    expect(count).toBe('0')
    expect(await store.getFolder(leaf)).toBeNull()
    expect((await writer.list(source, 'repo:bigger')).map((i) => i.key)).toEqual(['repo:bigger'])
    expect((await store.getFolder(root.folderId))).not.toBeNull()
  }, 60_000)

  it('key prefixes match by path segment and literally (the 0162 text_pattern_ops index)', async () => {
    const { dbDriveStore: store } = await import('./db-store')
    const src = `${source}-prefix`
    const keys = ['repo:1', 'repo:1/x', 'repo:12', 'repo:12/y', 'a_b', 'a_b/x', 'axb', 'axb/y', 'a%c', 'a%c/z', 'abc/q', 'a\\d', 'a\\d/e']
    try {
      await store.putSourceItems(keys.map((externalKey) => ({ source: src, externalKey, itemId: randomUUID(), kind: 'folder' as const, parentKey: null, contentSha: null })))
      const listed = async (prefix: string) => (await store.listSourceItems(src, prefix)).map((r) => r.externalKey)
      expect(await listed('repo:1')).toEqual(['repo:1', 'repo:1/x'])
      expect(await listed('a_b')).toEqual(['a_b', 'a_b/x'])
      expect(await listed('a%c')).toEqual(['a%c', 'a%c/z'])
      expect(await listed('a\\d')).toEqual(['a\\d', 'a\\d/e'])
      const [index] = await sql<Array<{ indexdef: string }>>`select indexdef from pg_indexes where indexname = 'drive_source_items_key_prefix_idx'`
      expect(index?.indexdef).toMatch(/\(source, external_key text_pattern_ops\)/)
    } finally {
      await sql`delete from drive_source_items where source = ${src}`
    }
  })
})
