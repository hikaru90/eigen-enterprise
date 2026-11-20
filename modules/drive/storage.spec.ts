import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { diskBlobStore, resolveDriveStorageDir, sha256Hex } from './storage'

describe('resolveDriveStorageDir', () => {
  it('prefers DRIVE_STORAGE_DIR', () => {
    expect(resolveDriveStorageDir({ DRIVE_STORAGE_DIR: '/data/drive', EE_STATE_DIR: '/state' })).toBe('/data/drive')
  })
  it('falls to $EE_STATE_DIR/drive under the substrate', () => {
    expect(resolveDriveStorageDir({ EE_STATE_DIR: '/state' })).toBe('/state/drive')
  })
  it('fails loud when neither is set (blank counts as unset)', () => {
    expect(() => resolveDriveStorageDir({})).toThrow(/Drive storage is not configured/)
    expect(() => resolveDriveStorageDir({ DRIVE_STORAGE_DIR: '  ', EE_STATE_DIR: '' })).toThrow(/DRIVE_STORAGE_DIR/)
  })
})

describe('diskBlobStore', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })
  async function store() {
    const dir = await mkdtemp(join(tmpdir(), 'drive-blobs-'))
    dirs.push(dir)
    return { dir, blobs: diskBlobStore(dir) }
  }

  it('names a blob by the sha256 of its bytes and reads it back', async () => {
    const { dir, blobs } = await store()
    const bytes = new TextEncoder().encode('# hello')
    const put = await blobs.put(bytes)
    expect(put).toEqual({ sha256: sha256Hex(bytes), size: bytes.byteLength, created: true })
    expect(new TextDecoder().decode(await blobs.get(put.sha256))).toBe('# hello')
    const sha = put.sha256
    expect(await readdir(join(dir, 'blobs', sha.slice(0, 2), sha.slice(2, 4)))).toEqual([sha])
  })

  it('dedupes: the same bytes twice are stored once', async () => {
    const { dir, blobs } = await store()
    const bytes = new TextEncoder().encode('same')
    const a = await blobs.put(bytes)
    const b = await blobs.put(new TextEncoder().encode('same'))
    expect(b).toEqual({ ...a, created: false })
    const sha = a.sha256
    expect(await readdir(join(dir, 'blobs', sha.slice(0, 2), sha.slice(2, 4)))).toHaveLength(1)
  })

  it('removes a blob and refuses names that are not a sha256', async () => {
    const { blobs } = await store()
    const { sha256 } = await blobs.put(new Uint8Array([1, 2, 3]))
    await blobs.remove(sha256)
    expect(await blobs.has(sha256)).toBe(false)
    await expect(blobs.get('../../etc/passwd')).rejects.toThrow(/not a sha256/)
  })

  const pathOf = (dir: string, sha: string) => join(dir, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha)
  const age = async (dir: string, sha: string, at: Date) => utimes(pathOf(dir, sha), at, at)

  it('a put of bytes already stored refreshes the blob’s time, so a sweep’s grace period covers every writer', async () => {
    const { dir, blobs } = await store()
    const { sha256 } = await blobs.put(new TextEncoder().encode('old'))
    await age(dir, sha256, new Date('2020-01-01T00:00:00Z'))
    expect(await blobs.put(new TextEncoder().encode('old'))).toMatchObject({ created: false })
    expect((await stat(pathOf(dir, sha256))).mtime.getTime()).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'))
  })

  it('lists stored blobs with their times (temporary files are not blobs)', async () => {
    const { dir, blobs } = await store()
    const a = await blobs.put(new TextEncoder().encode('a'))
    const b = await blobs.put(new TextEncoder().encode('b'))
    await age(dir, a.sha256, new Date('2020-01-01T00:00:00Z'))
    await writeFile(`${pathOf(dir, b.sha256)}.123.tmp`, 'half')
    const listed = await blobs.list()
    expect(listed.map((x) => x.sha256).sort()).toEqual([a.sha256, b.sha256].sort())
    expect(listed.find((x) => x.sha256 === a.sha256)!.modifiedAt).toEqual(new Date('2020-01-01T00:00:00Z'))
    expect(await (await store()).blobs.list()).toEqual([])
  })

  it('removeIfOlderThan removes an old blob only, and never one a writer refreshed', async () => {
    const { dir, blobs } = await store()
    const old = await blobs.put(new TextEncoder().encode('old'))
    const fresh = await blobs.put(new TextEncoder().encode('fresh'))
    await age(dir, old.sha256, new Date('2020-01-01T00:00:00Z'))
    const cutoff = new Date('2021-01-01T00:00:00Z')
    expect(await blobs.removeIfOlderThan(old.sha256, cutoff)).toBe(true)
    expect(await blobs.has(old.sha256)).toBe(false)
    expect(await blobs.removeIfOlderThan(fresh.sha256, cutoff)).toBe(false)
    expect(await blobs.has(fresh.sha256)).toBe(true)
    // Already gone is not an error: nothing to remove.
    expect(await blobs.removeIfOlderThan(old.sha256, cutoff)).toBe(false)
    expect(await readdir(join(dir, 'blobs', fresh.sha256.slice(0, 2), fresh.sha256.slice(2, 4)))).toEqual([fresh.sha256])
  })
})
