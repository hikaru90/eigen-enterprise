import { mkdtemp, readdir, rm } from 'node:fs/promises'
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
})
