import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
}

export function diskBlobStore(root: string): BlobStore {
  const pathOf = (sha: string) => {
    if (!SHA256.test(sha)) throw new Error(`not a sha256 blob name: ${sha}`)
    return join(root, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha)
  }
  const has = async (sha: string) => {
    try {
      await stat(pathOf(sha))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }
  return {
    async put(bytes) {
      const sha = sha256Hex(bytes)
      const target = pathOf(sha)
      if (await has(sha)) return { sha256: sha, size: bytes.byteLength, created: false }
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
  }
}
