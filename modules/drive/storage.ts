import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, mkdir, open, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'

/**
 * Drive bytes on disk (plan/phase-workspace.md W-5): content-addressed blobs
 * under the workload's state dir, so they survive a blue-green swap. Metadata
 * lives in Postgres; a blob is named by the SHA-256 of its bytes, so the same
 * bytes uploaded twice are stored once.
 *
 * Layout: <dir>/blobs/<sha[0..2]>/<sha[2..4]>/<sha>
 *
 * Sealed at rest (wish e840c02c): every blob on disk is AES-256-GCM sealed
 * with the Drive blob key (derived from TENANT_MASTER_KEY, like every tenant
 * envelope's root). File = SEAL_MAGIC | iv (12) | ciphertext | tag (16); the
 * additional data binds the blob's name (the sha256 of its plaintext), so a
 * blob moved under another name fails to open. The name stays the plaintext
 * hash: content addressing and dedupe are unchanged.
 *
 * Blobs written before sealing are plain. <dir>/seal-state says what the
 * store is: "sealing" (the startup pass, sealPlainBlobs, is turning the plain
 * ones into sealed ones; a plain blob reads only while its bytes still hash
 * to its name) or "sealed" (every blob is sealed; a plain one is an error).
 * A plain blob in a store with no seal-state is an error too — never read as
 * plaintext on a guess.
 */

/** DRIVE_STORAGE_DIR, else $EE_STATE_DIR/drive, else refuse (never a default location). */
export function resolveDriveStorageDir(env: Record<string, string | undefined>): string {
  const explicit = env.DRIVE_STORAGE_DIR?.trim()
  if (explicit) return explicit
  const substrate = env.EE_STATE_DIR?.trim()
  if (substrate) return join(substrate, 'drive')
  throw new Error(
    'Drive storage is not configured: set DRIVE_STORAGE_DIR to a writable directory, or run under the ee substrate which injects EE_STATE_DIR (files then live at $EE_STATE_DIR/drive). Refusing to guess — company files must never land in a default location.',
  )
}

const SHA256 = /^[0-9a-f]{64}$/

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The first bytes of every sealed blob ("EEDRIVE-SEALED" + format 0x00 0x01); ee/src/backup/snapshot.ts mirrors it. */
export const SEAL_MAGIC = Buffer.from('EEDRIVE-SEALED\u0000\u0001', 'latin1')
const IV_BYTES = 12
const TAG_BYTES = 16
export const SEAL_STATE_FILE = 'seal-state'
export type SealState = 'sealing' | 'sealed'

/**
 * The key Drive blobs are sealed with: HKDF of TENANT_MASTER_KEY (the root of
 * every tenant envelope), so every slot, the startup pass and a restore with
 * the same master key open the same blobs, with no session needed. Fails loud
 * without it.
 */
export function driveBlobKey(env: Record<string, string | undefined>): Buffer {
  const master = env.TENANT_MASTER_KEY?.trim()
  if (!master) throw new Error('TENANT_MASTER_KEY is required: Drive files are sealed at rest with a key derived from it')
  return Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.alloc(0), 'eigenEnterprise drive blob seal v1', 32))
}

const aadOf = (sha: string) => Buffer.from(`drive-blob|sha256:${sha}`, 'utf8')

/** Seals plaintext bytes stored under `sha` (SEAL_MAGIC | iv | ciphertext | tag). */
export function sealBlob(key: Buffer, sha: string, plain: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aadOf(sha))
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([SEAL_MAGIC, iv, body, c.getAuthTag()])
}

export function isSealed(bytes: Uint8Array): boolean {
  return bytes.byteLength >= SEAL_MAGIC.length && Buffer.from(bytes.buffer, bytes.byteOffset, SEAL_MAGIC.length).equals(SEAL_MAGIC)
}

/** Opens a sealed blob; throws when it was not sealed under `sha` with this key, or was changed. */
export function openSealedBlob(key: Buffer, sha: string, sealed: Uint8Array): Buffer {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength)
  if (!isSealed(buf) || buf.length < SEAL_MAGIC.length + IV_BYTES + TAG_BYTES)
    throw new Error(`Drive blob ${sha} is not a sealed blob`)
  const iv = buf.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + IV_BYTES)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(aadOf(sha))
  d.setAuthTag(buf.subarray(buf.length - TAG_BYTES))
  try {
    return Buffer.concat([d.update(buf.subarray(SEAL_MAGIC.length + IV_BYTES, buf.length - TAG_BYTES)), d.final()])
  } catch (err) {
    throw new Error(`Drive blob ${sha} does not open with the Drive blob key (changed on disk, moved, or sealed under another TENANT_MASTER_KEY)`, { cause: err })
  }
}

export type BlobStore = {
  /** Stores the bytes (once per content, sealed) and returns the SHA-256 of the plaintext. */
  put(bytes: Uint8Array): Promise<{ sha256: string; size: number; created: boolean }>
  /** The plaintext bytes (unsealed). */
  get(sha256: string): Promise<Uint8Array>
  /** The plaintext bytes as a stream (unsealed chunk by chunk; the stream errors at its end if the blob was changed). */
  stream(sha256: string): AsyncIterable<Uint8Array>
  has(sha256: string): Promise<boolean>
  remove(sha256: string): Promise<void>
  /** Every stored blob with when it was last written or re-put (a put of stored bytes refreshes it). */
  list(): Promise<Array<{ sha256: string; modifiedAt: Date }>>
  /**
   * Removes the blob only while its time is still before `before`; true when
   * it removed it. A put racing the removal either refreshes the blob first
   * (it stays) or finds it gone and writes it again.
   */
  removeIfOlderThan(sha256: string, before: Date): Promise<boolean>
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'

/** Where a blob lives under a store root (the layout above); refuses anything but a sha256. */
export function blobPath(root: string, sha: string): string {
  if (!SHA256.test(sha)) throw new Error(`not a sha256 blob name: ${sha}`)
  return join(root, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha)
}

/** The store's seal-state (null: none written yet). */
export async function readSealState(root: string): Promise<SealState | null> {
  let raw: string
  try {
    raw = (await readFile(join(root, SEAL_STATE_FILE), 'utf8')).trim()
  } catch (err) {
    if (isMissing(err)) return null
    throw err
  }
  if (raw === 'sealing' || raw === 'sealed') return raw
  throw new Error(`Drive storage ${root}: ${SEAL_STATE_FILE} says "${raw}" (expected "sealing" or "sealed")`)
}

async function writeSealState(root: string, state: SealState): Promise<void> {
  await mkdir(root, { recursive: true })
  const tmp = join(root, `${SEAL_STATE_FILE}.${randomUUID()}.tmp`)
  await writeFile(tmp, `${state}\n`)
  await rename(tmp, join(root, SEAL_STATE_FILE))
}

/** A plain (pre-sealing) blob's bytes, only while the store is still being sealed and they are what their name says. */
async function legacyPlain(root: string, sha: string, bytes: Uint8Array): Promise<Uint8Array> {
  const state = await readSealState(root)
  if (state !== 'sealing')
    throw new Error(
      `Drive blob ${sha} is not sealed and the store ${root} is ${state === 'sealed' ? 'marked sealed' : 'not marked as being sealed'}: refusing to read it as plaintext`,
    )
  if (sha256Hex(bytes) !== sha) throw new Error(`Drive blob ${sha} is not sealed and its bytes do not match its name (damaged)`)
  return bytes
}

export function diskBlobStore(root: string, key: Buffer): BlobStore {
  if (key.length !== 32) throw new Error('the Drive blob key must be 32 bytes')
  const pathOf = (sha: string) => blobPath(root, sha)
  const has = async (sha: string) => {
    try {
      await stat(pathOf(sha))
      return true
    } catch (err) {
      if (isMissing(err)) return false
      throw err
    }
  }
  const mtimeOf = async (path: string): Promise<Date | null> => {
    try {
      return (await stat(path)).mtime
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }
  const entries = async (dir: string): Promise<string[]> => {
    try {
      return await readdir(dir)
    } catch (err) {
      if (isMissing(err)) return []
      throw err
    }
  }
  return {
    async put(bytes) {
      const sha = sha256Hex(bytes)
      const target = pathOf(sha)
      // Stored already: refresh its time, so the blob sweep's grace period covers this writer too.
      try {
        const at = new Date()
        await utimes(target, at, at)
        return { sha256: sha, size: bytes.byteLength, created: false }
      } catch (err) {
        if (!isMissing(err)) throw err
      }
      await mkdir(join(target, '..'), { recursive: true })
      // Write-then-rename: a crash never leaves a half blob under its final name.
      const tmp = `${target}.${randomUUID()}.tmp`
      await writeFile(tmp, sealBlob(key, sha, bytes))
      await rename(tmp, target)
      return { sha256: sha, size: bytes.byteLength, created: true }
    },
    async get(sha) {
      const raw = await readFile(pathOf(sha))
      if (isSealed(raw)) return new Uint8Array(openSealedBlob(key, sha, raw))
      return new Uint8Array(await legacyPlain(root, sha, new Uint8Array(raw)))
    },
    stream(sha) {
      return streamBlob(root, key, sha)
    },
    has,
    async remove(sha) {
      await rm(pathOf(sha), { force: true })
    },
    async list() {
      const out: Array<{ sha256: string; modifiedAt: Date }> = []
      const base = join(root, 'blobs')
      for (const a of await entries(base)) {
        for (const b of await entries(join(base, a))) {
          for (const name of await entries(join(base, a, b))) {
            if (!SHA256.test(name)) continue
            const modifiedAt = await mtimeOf(join(base, a, b, name))
            if (modifiedAt) out.push({ sha256: name, modifiedAt })
          }
        }
      }
      return out
    },
    async removeIfOlderThan(sha, before) {
      const target = pathOf(sha)
      const seen = await mtimeOf(target)
      if (!seen || seen.getTime() >= before.getTime()) return false
      // Move it aside first: from here on a put finds it missing and writes it again.
      const aside = `${target}.${randomUUID()}.trash`
      try {
        await rename(target, aside)
      } catch (err) {
        if (isMissing(err)) return false
        throw err
      }
      const moved = await mtimeOf(aside)
      if (moved && moved.getTime() >= before.getTime()) {
        // A put refreshed it between the check and the move: put it back (a rewrite in between is the same bytes).
        try {
          await link(aside, target)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
        await unlink(aside)
        return false
      }
      await unlink(aside)
      return true
    },
  }
}

async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** Unseals a blob chunk by chunk: the trailing tag is held back, and a changed blob errors at the end. */
async function* streamBlob(root: string, key: Buffer, sha: string): AsyncIterable<Uint8Array> {
  const path = blobPath(root, sha)
  const head = await readHead(path, SEAL_MAGIC.length + IV_BYTES)
  if (!isSealed(head)) {
    // Pre-sealing blob: only while the store is being sealed, checked against its name as it streams.
    const state = await readSealState(root)
    if (state !== 'sealing')
      throw new Error(`Drive blob ${sha} is not sealed and the store ${root} is ${state === 'sealed' ? 'marked sealed' : 'not marked as being sealed'}: refusing to read it as plaintext`)
    const h = createHash('sha256')
    for await (const chunk of createReadStream(path)) {
      h.update(chunk as Buffer)
      yield chunk as Uint8Array
    }
    if (h.digest('hex') !== sha) throw new Error(`Drive blob ${sha} is not sealed and its bytes do not match its name (damaged)`)
    return
  }
  if (head.length < SEAL_MAGIC.length + IV_BYTES) throw new Error(`Drive blob ${sha} is not a sealed blob`)
  const d = createDecipheriv('aes-256-gcm', key, head.subarray(SEAL_MAGIC.length))
  d.setAAD(aadOf(sha))
  let tail = Buffer.alloc(0)
  for await (const chunk of createReadStream(path, { start: SEAL_MAGIC.length + IV_BYTES })) {
    const all = Buffer.concat([tail, chunk as Buffer])
    if (all.length <= TAG_BYTES) {
      tail = all
      continue
    }
    tail = all.subarray(all.length - TAG_BYTES)
    const out = d.update(all.subarray(0, all.length - TAG_BYTES))
    if (out.length) yield out
  }
  if (tail.length !== TAG_BYTES) throw new Error(`Drive blob ${sha} is not a sealed blob (cut short)`)
  d.setAuthTag(tail)
  let last: Buffer
  try {
    last = d.final()
  } catch (err) {
    throw new Error(`Drive blob ${sha} does not open with the Drive blob key (changed on disk, moved, or sealed under another TENANT_MASTER_KEY)`, { cause: err })
  }
  if (last.length) yield last
}

/**
 * The one-time sealing pass (run at server start): marks the store "sealing",
 * seals every plain blob in place (streamed: the plaintext is hashed against
 * the blob's name while it is sealed into a temp file, then renamed over it;
 * the blob keeps its time), then marks the store "sealed". Idempotent and
 * resumable — a sealed blob is recognised by SEAL_MAGIC and never sealed
 * again, and a restart mid-way finishes the rest. A blob whose bytes do not
 * match its name is left untouched, named, and keeps the store "sealing".
 */
export async function sealPlainBlobs(root: string, key: Buffer): Promise<{ sealed: number; alreadySealed: number; state: SealState }> {
  const store = diskBlobStore(root, key)
  const blobs = await store.list()
  const before = await readSealState(root)
  if (before === 'sealed') {
    // Cheap re-check on every start: a restored or copied-in plain blob is caught here, loud.
    for (const b of blobs) if (!isSealed(await readHead(blobPath(root, b.sha256), SEAL_MAGIC.length))) {
      throw new Error(`Drive storage ${root} is marked sealed but blob ${b.sha256} is plain: write "sealing" to ${join(root, SEAL_STATE_FILE)} to have it sealed`)
    }
    return { sealed: 0, alreadySealed: blobs.length, state: 'sealed' }
  }
  if (before === null) await writeSealState(root, 'sealing')
  let sealed = 0
  let alreadySealed = 0
  const damaged: string[] = []
  for (const { sha256: sha, modifiedAt } of blobs) {
    const path = blobPath(root, sha)
    if (isSealed(await readHead(path, SEAL_MAGIC.length))) {
      alreadySealed++
      continue
    }
    const tmp = `${path}.${randomUUID()}.tmp`
    const iv = randomBytes(IV_BYTES)
    const c = createCipheriv('aes-256-gcm', key, iv)
    c.setAAD(aadOf(sha))
    const h = createHash('sha256')
    try {
      await pipeline(
        createReadStream(path),
        async function* (src: AsyncIterable<Buffer>) {
          yield Buffer.concat([SEAL_MAGIC, iv])
          for await (const chunk of src) {
            h.update(chunk)
            yield c.update(chunk)
          }
          yield c.final()
          yield c.getAuthTag()
        },
        createWriteStream(tmp, { flags: 'wx', mode: 0o600 }),
      )
      if (h.digest('hex') !== sha) {
        await rm(tmp, { force: true })
        damaged.push(sha)
        continue
      }
      await utimes(tmp, modifiedAt, modifiedAt)
      await rename(tmp, path)
      sealed++
    } catch (err) {
      await rm(tmp, { force: true })
      if (isMissing(err)) continue // removed by the blob sweep meanwhile
      throw err
    }
  }
  if (damaged.length > 0)
    throw new Error(`Drive storage ${root}: ${damaged.length} plain blob(s) do not match their names and were not sealed (${damaged.join(', ')}); the store stays "sealing"`)
  await writeSealState(root, 'sealed')
  return { sealed, alreadySealed, state: 'sealed' }
}
