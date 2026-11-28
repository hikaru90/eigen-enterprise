import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  blobPath,
  diskBlobStore,
  driveBlobKey,
  isSealed,
  readSealState,
  resolveDriveStorageDir,
  SEAL_MAGIC,
  SEAL_STATE_FILE,
  sealBlob,
  sealPlainBlobs,
  sha256Hex,
} from './storage'

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
    return { dir, blobs: diskBlobStore(dir, Buffer.alloc(32, 7)) }
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

describe('Drive blobs sealed at rest (wish e840c02c)', () => {
  const KEY = Buffer.alloc(32, 7)
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })
  async function root() {
    const dir = await mkdtemp(join(tmpdir(), 'drive-seal-'))
    dirs.push(dir)
    return dir
  }
  const text = (s: string) => new TextEncoder().encode(s)
  async function collect(it: AsyncIterable<Uint8Array>) {
    const parts: Buffer[] = []
    for await (const c of it) parts.push(Buffer.from(c))
    return Buffer.concat(parts)
  }
  /** A blob as Drive wrote it before sealing: the plain bytes under their sha. */
  async function plantPlain(dir: string, bytes: Uint8Array) {
    const sha = sha256Hex(bytes)
    const path = blobPath(dir, sha)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, bytes)
    return sha
  }

  it('writes no plaintext to disk; get and stream give the plaintext back', async () => {
    const dir = await root()
    const blobs = diskBlobStore(dir, KEY)
    const secret = 'Quarterly numbers: revenue 1.2M, do not share'
    const { sha256 } = await blobs.put(text(secret))
    const onDisk = await readFile(blobPath(dir, sha256))
    expect(onDisk.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)).toBe(true)
    expect(onDisk.includes(Buffer.from('revenue'))).toBe(false)
    expect(new TextDecoder().decode(await blobs.get(sha256))).toBe(secret)
    expect((await collect(blobs.stream(sha256))).toString('utf8')).toBe(secret)
  })

  it('streams a large blob chunk by chunk to the same bytes (tag held back across chunks)', async () => {
    const dir = await root()
    const blobs = diskBlobStore(dir, KEY)
    const big = randomBytes(3 * 1024 * 1024 + 17)
    const { sha256 } = await blobs.put(big)
    expect((await collect(blobs.stream(sha256))).equals(big)).toBe(true)
  })

  it('a blob changed on disk, opened with another key, or moved under another name fails loud', async () => {
    const dir = await root()
    const blobs = diskBlobStore(dir, KEY)
    const { sha256 } = await blobs.put(text('payroll'))
    const path = blobPath(dir, sha256)
    const sealed = await readFile(path)
    await expect(diskBlobStore(dir, Buffer.alloc(32, 8)).get(sha256)).rejects.toThrow(/does not open with the Drive blob key/)
    const flipped = Buffer.from(sealed)
    flipped[flipped.length - 20] ^= 1
    await writeFile(path, flipped)
    await expect(blobs.get(sha256)).rejects.toThrow(/does not open/)
    await expect(collect(blobs.stream(sha256))).rejects.toThrow(/does not open/)
    const other = sha256Hex(text('other'))
    await mkdir(join(blobPath(dir, other), '..'), { recursive: true })
    await writeFile(blobPath(dir, other), sealed)
    await expect(blobs.get(other)).rejects.toThrow(/does not open/)
  })

  it('a plain blob in a store not marked as being sealed is never read as plaintext', async () => {
    const dir = await root()
    const sha = await plantPlain(dir, text('old plain file'))
    const blobs = diskBlobStore(dir, KEY)
    await expect(blobs.get(sha)).rejects.toThrow(/not marked as being sealed/)
    await expect(collect(blobs.stream(sha))).rejects.toThrow(/not marked as being sealed/)
  })

  it('the sealing pass seals every plain blob in place, keeps its time, marks the store sealed; a rerun seals nothing twice', async () => {
    const dir = await root()
    const a = await plantPlain(dir, text('alpha document'))
    const b = await plantPlain(dir, text('beta document'))
    const old = new Date('2026-01-02T03:04:05Z')
    await utimes(blobPath(dir, a), old, old)
    const blobs = diskBlobStore(dir, KEY)
    const fresh = (await blobs.put(text('written after the upgrade'))).sha256

    expect(await sealPlainBlobs(dir, KEY)).toEqual({ sealed: 2, alreadySealed: 1, state: 'sealed' })
    expect(await readSealState(dir)).toBe('sealed')
    for (const sha of [a, b, fresh]) expect(isSealed(await readFile(blobPath(dir, sha)))).toBe(true)
    expect((await readFile(blobPath(dir, a))).includes(Buffer.from('alpha'))).toBe(false)
    expect((await stat(blobPath(dir, a))).mtime.getTime()).toBe(old.getTime())
    expect(new TextDecoder().decode(await blobs.get(a))).toBe('alpha document')

    const before = await readFile(blobPath(dir, b))
    expect(await sealPlainBlobs(dir, KEY)).toEqual({ sealed: 0, alreadySealed: 3, state: 'sealed' })
    expect((await readFile(blobPath(dir, b))).equals(before)).toBe(true)
    expect(new TextDecoder().decode(await blobs.get(b))).toBe('beta document')
  })

  it('while a store is "sealing" (pass cut off / restore), plain blobs read only if they match their name, and the pass resumes', async () => {
    const dir = await root()
    const a = await plantPlain(dir, text('one'))
    const b = await plantPlain(dir, text('two'))
    await writeFile(join(dir, SEAL_STATE_FILE), 'sealing\n')
    const blobs = diskBlobStore(dir, KEY)
    expect(new TextDecoder().decode(await blobs.get(a))).toBe('one')
    expect((await collect(blobs.stream(b))).toString()).toBe('two')
    // Half done: a already sealed by a pass that was cut off.
    await writeFile(blobPath(dir, a), sealBlob(KEY, a, text('one')))
    expect(await sealPlainBlobs(dir, KEY)).toEqual({ sealed: 1, alreadySealed: 1, state: 'sealed' })
    await expect(blobs.get(a)).resolves.toEqual(new Uint8Array(text('one')))
  })

  it('a damaged plain blob is not sealed, is named, and keeps the store "sealing"; a plain blob in a sealed store fails loud', async () => {
    const dir = await root()
    const good = await plantPlain(dir, text('good'))
    const bad = sha256Hex(text('expected'))
    await mkdir(join(blobPath(dir, bad), '..'), { recursive: true })
    await writeFile(blobPath(dir, bad), text('something else'))
    await expect(sealPlainBlobs(dir, KEY)).rejects.toThrow(new RegExp(bad))
    expect(await readSealState(dir)).toBe('sealing')
    expect(isSealed(await readFile(blobPath(dir, good)))).toBe(true)
    await expect(diskBlobStore(dir, KEY).get(bad)).rejects.toThrow(/do not match its name/)

    await rm(blobPath(dir, bad))
    expect((await sealPlainBlobs(dir, KEY)).state).toBe('sealed')
    const planted = await plantPlain(dir, text('copied in later'))
    await expect(diskBlobStore(dir, KEY).get(planted)).rejects.toThrow(/marked sealed/)
    await expect(sealPlainBlobs(dir, KEY)).rejects.toThrow(/marked sealed but blob/)
  })

  it('a fresh store is marked sealed by the pass', async () => {
    const dir = await root()
    expect(await sealPlainBlobs(dir, KEY)).toEqual({ sealed: 0, alreadySealed: 0, state: 'sealed' })
  })

  it('driveBlobKey derives a 32-byte key from TENANT_MASTER_KEY and fails loud without it', () => {
    const k = driveBlobKey({ TENANT_MASTER_KEY: 'master-1' })
    expect(k.length).toBe(32)
    expect(driveBlobKey({ TENANT_MASTER_KEY: 'master-1' }).equals(k)).toBe(true)
    expect(driveBlobKey({ TENANT_MASTER_KEY: 'master-2' }).equals(k)).toBe(false)
    expect(() => driveBlobKey({})).toThrow(/TENANT_MASTER_KEY is required/)
    expect(() => diskBlobStore('/x', Buffer.alloc(16))).toThrow(/32 bytes/)
  })
})

describe('ee backup knows the seal', () => {
  it('ee/src/backup mirrors SEAL_MAGIC and the seal-state file name', async () => {
    const ee = await import('../../ee/src/backup/snapshot.ts')
    expect(ee.DRIVE_SEAL_MAGIC.equals(SEAL_MAGIC)).toBe(true)
    expect(ee.DRIVE_SEAL_STATE_FILE).toBe(SEAL_STATE_FILE)
  })
})
