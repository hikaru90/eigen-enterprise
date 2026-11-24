import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sha256Hex } from '../../contracts/module-bundle'

/**
 * Where the hub keeps every published bundle, by sha256
 * (plan/phase-upgrades-u2.md §7): `$EE_STATE_DIR/module-hub/bundles/<sha256>.tar.gz`.
 * Content-addressed and never deleted (revoking an install keeps its code).
 * A read checks the bytes against their name: a damaged file fails loud.
 */
export type BundleStorage = {
  put(sha256: string, bytes: Uint8Array): Promise<void>
  /** null = no such bundle. */
  get(sha256: string): Promise<Uint8Array | null>
}

const HEX64 = /^[0-9a-f]{64}$/

function checkedName(sha256: string): string {
  if (!HEX64.test(sha256)) throw new Error(`a bundle name must be 64 lowercase hex, got ${JSON.stringify(sha256)}`)
  return `${sha256}.tar.gz`
}

function checkedBytes(sha256: string, bytes: Uint8Array, where: string): Uint8Array {
  const actual = sha256Hex(bytes)
  if (actual !== sha256) throw new Error(`module bundle ${where} has sha256 ${actual}, expected ${sha256}`)
  return bytes
}

/** The bundle directory under the ee state dir; fails loud when the server has none. */
export function bundleDir(stateDir: string | undefined): string {
  const dir = stateDir?.trim()
  if (!dir) {
    throw new Error('module hub bundle storage is not configured: run under the ee substrate, which injects EE_STATE_DIR (bundles live at $EE_STATE_DIR/module-hub/bundles).')
  }
  return join(dir, 'module-hub', 'bundles')
}

export function fsBundleStorage(dir: string): BundleStorage {
  return {
    async put(sha256, bytes) {
      const name = checkedName(sha256)
      checkedBytes(sha256, bytes, 'to store')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`)
      await writeFile(tmp, bytes, { mode: 0o600 })
      await rename(tmp, join(dir, name))
    },
    async get(sha256) {
      const file = join(dir, checkedName(sha256))
      let bytes: Buffer
      try {
        bytes = await readFile(file)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      return checkedBytes(sha256, new Uint8Array(bytes), file)
    },
  }
}

export function memoryBundleStorage(): BundleStorage & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    async put(sha256, bytes) {
      checkedName(sha256)
      files.set(sha256, new Uint8Array(checkedBytes(sha256, bytes, 'to store')))
    },
    async get(sha256) {
      checkedName(sha256)
      const b = files.get(sha256)
      return b ? checkedBytes(sha256, new Uint8Array(b), 'in memory') : null
    },
  }
}
