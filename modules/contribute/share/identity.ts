import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decryptEnvelope, encryptEnvelope } from '$lib/server/crypto/envelope'

/**
 * The install's identity towards the central board (plan §3): a random
 * install id (UUID v4, derived from nothing) and an Ed25519 keypair made on
 * the first send. The private key lives next to the company root key in the
 * server's sealed key directory (COMPANY_KEYS_DIR, else
 * $EE_STATE_DIR/company-keys — gitstore/keys.ts), sealed (AES-256-GCM) under a
 * key derived for this purpose only from TENANT_MASTER_KEY, which ee keeps in
 * its sealed secret store. Never in the settings table, never logged.
 */

export type InstallKey = {
  installId: string
  /** Ed25519 public key, SPKI DER, base64 (what the hub stores). */
  publicKey: string
  /** Ed25519 private key, PKCS8 DER, base64 (only ever in memory and in the sealed file). */
  privateKey: string
}

export type InstallKeyStore = {
  load(): Promise<InstallKey | null>
  /** Refuses to replace a different key (the hub knows this install by it). */
  save(key: InstallKey): Promise<void>
}

export function generateInstallKey(newId: () => string = randomUUID): InstallKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    installId: newId(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  }
}

const FILE = 'contribute-install.sealed'
const SEAL_AAD = 'eigenEnterprise contribute install key v1'

function sealKey(masterKey: string): Buffer {
  const k = masterKey.trim()
  if (!k) throw new Error('TENANT_MASTER_KEY is required to seal the Contribute install key')
  return createHash('sha256').update(`contribute-install-key:${k}`, 'utf8').digest()
}

function parseKey(json: string): InstallKey {
  const raw = JSON.parse(json) as Partial<InstallKey>
  if (typeof raw.installId !== 'string' || typeof raw.publicKey !== 'string' || typeof raw.privateKey !== 'string') {
    throw new Error(`${FILE} does not hold an install key`)
  }
  return { installId: raw.installId, publicKey: raw.publicKey, privateKey: raw.privateKey }
}

export function sealedInstallKeyStore(dir: string, masterKey: string): InstallKeyStore {
  const file = join(dir, FILE)
  const load = async (): Promise<InstallKey | null> => {
    let blob: string
    try {
      blob = await readFile(file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    return parseKey(decryptEnvelope(blob, sealKey(masterKey), SEAL_AAD))
  }
  return {
    load,
    async save(key) {
      const existing = await load()
      if (existing && (existing.installId !== key.installId || existing.privateKey !== key.privateKey)) {
        throw new Error('a different Contribute install key is already sealed on this server; refusing to replace it')
      }
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.tmp`
      await writeFile(tmp, encryptEnvelope(JSON.stringify(key), sealKey(masterKey), SEAL_AAD), { mode: 0o600 })
      await chmod(tmp, 0o600)
      await rename(tmp, file)
    },
  }
}

/** For unit tests. */
export function memoryInstallKeyStore(initial: InstallKey | null = null): InstallKeyStore & { key: InstallKey | null } {
  const s = {
    key: initial,
    async load() {
      return s.key
    },
    async save(key: InstallKey) {
      if (s.key && s.key.installId !== key.installId) throw new Error('a different Contribute install key is already stored')
      s.key = key
    },
  }
  return s
}
