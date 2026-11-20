import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BLOB_GC_GRACE_MS, sweepUnreferencedBlobs } from './blob-gc'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const at = new Date('2026-11-12T10:00:00Z')
const fileRow = (id: string, sha256: string) => ({
  id,
  folderId: null,
  name: `${id}.md`,
  ownerId: 'alice',
  mime: 'text/markdown',
  size: 1,
  sha256,
  createdAt: at,
  updatedAt: at,
  trashedAt: null,
  archivedAt: null,
  archivedBy: null,
  source: null,
  contentDate: null,
  contentDateKind: null,
})

describe('sweepUnreferencedBlobs', () => {
  it('removes only blobs no file or revision references that are older than the grace period', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drive-gc-'))
    dirs.push(dir)
    const blobs = diskBlobStore(dir)
    const store = memoryDriveStore()
    const put = async (s: string) => (await blobs.put(new TextEncoder().encode(s))).sha256
    const [byFile, byRevision, orphanOld, orphanFresh] = [await put('file'), await put('revision'), await put('orphan old'), await put('orphan fresh')]
    await store.insertFile(fileRow('f1', byFile))
    await store.insertRevision({ id: 'r1', fileId: 'f1', sha256: byRevision, size: 1, authorId: 'alice', createdAt: at })
    const old = new Date(Date.now() - 2 * BLOB_GC_GRACE_MS)
    for (const sha of [byFile, byRevision, orphanOld]) {
      const path = join(dir, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha)
      await utimes(path, old, old)
    }

    expect(BLOB_GC_GRACE_MS).toBe(60 * 60 * 1000)
    expect(await sweepUnreferencedBlobs({ store, blobs }, new Date(Date.now() - BLOB_GC_GRACE_MS))).toEqual({ removed: 1 })
    expect(await blobs.has(orphanOld)).toBe(false)
    for (const sha of [byFile, byRevision, orphanFresh]) expect(await blobs.has(sha)).toBe(true)
    expect(await sweepUnreferencedBlobs({ store, blobs }, new Date(Date.now() - BLOB_GC_GRACE_MS))).toEqual({ removed: 0 })
  })

  it('fails loud on a cut-off inside the grace period (it would race open writers)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'drive-gc-'))
    dirs.push(dir)
    await expect(sweepUnreferencedBlobs({ store: memoryDriveStore(), blobs: diskBlobStore(dir) }, new Date())).rejects.toThrow(/grace period/)
  })
})
