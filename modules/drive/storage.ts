import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Drive bytes on disk (plan/phase-workspace.md W-5): content-addressed blobs
 * under the workload's state dir, so they survive a blue-green swap. Metadata
 * lives in Postgres; a blob is named by the SHA-256 of its bytes, so the same
 * bytes uploaded twice are stored once.
 *
 * Layout: <dir>/blobs/<sha[0..2]>/<sha[2..4]>/<sha>
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

export type BlobStore = {
  /** Stores the bytes (once per content) and returns their SHA-256. */
  put(bytes: Uint8Array): Promise<{ sha256: string; size: number; created: boolean }>
  get(sha256: string): Promise<Uint8Array>
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

export function diskBlobStore(root: string): BlobStore {
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
      await writeFile(tmp, bytes)
      await rename(tmp, target)
      return { sha256: sha, size: bytes.byteLength, created: true }
    },
    async get(sha) {
      return new Uint8Array(await readFile(pathOf(sha)))
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
