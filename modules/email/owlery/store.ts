import { createHash } from 'node:crypto'
import type { DbHandle } from '$lib/kernel/db-stores'
import { decryptEnvelope, encryptEnvelope } from '$lib/server/crypto/envelope'
import type { AppDatabase } from '$lib/server/db/context'
import { owlerySettings } from '$lib/server/db/owlery.schema'

/**
 * Persistence for the company's Amazon SES settings (one row). The secret
 * access key is sealed with a key derived from TENANT_MASTER_KEY, AAD-bound to
 * this purpose, and unsealed only in memory per use.
 */

export type OwleryRow = {
  region: string
  accessKeyId: string
  sealedSecretAccessKey: string
  emailFrom: string
  updatedBy: string
}

export type OwleryStore = {
  read(): Promise<OwleryRow | null>
  write(row: OwleryRow): Promise<void>
  /** Deletes the row (only the e2e harness reset under MAIL_TRANSPORT=fake). */
  clear(): Promise<void>
}

export const SEAL_AAD = 'owlery-ses-secret-access-key'

export function owlerySealKey(masterKey: string): Buffer {
  if (!masterKey.trim()) throw new Error('TENANT_MASTER_KEY is required to seal the Amazon SES secret')
  return createHash('sha256').update(`${SEAL_AAD}:${masterKey.trim()}`, 'utf8').digest()
}

export function sealSecret(secret: string, key: Buffer): string {
  return encryptEnvelope(secret, key, SEAL_AAD)
}

export function unsealSecret(sealed: string, key: Buffer): string {
  return decryptEnvelope(sealed, key, SEAL_AAD)
}

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

export class DbOwleryStore implements OwleryStore {
  constructor(private readonly db: DbHandle) {}

  async read(): Promise<OwleryRow | null> {
    const [row] = await (await resolveDb(this.db)).select().from(owlerySettings).limit(1)
    if (!row) return null
    return {
      region: row.region,
      accessKeyId: row.accessKeyId,
      sealedSecretAccessKey: row.sealedSecretAccessKey,
      emailFrom: row.emailFrom,
      updatedBy: row.updatedBy,
    }
  }

  async write(row: OwleryRow): Promise<void> {
    const values = { id: 'owlery', ...row, updatedAt: new Date() }
    await (await resolveDb(this.db))
      .insert(owlerySettings)
      .values(values)
      .onConflictDoUpdate({ target: owlerySettings.id, set: values })
  }

  async clear(): Promise<void> {
    await (await resolveDb(this.db)).delete(owlerySettings)
  }
}

export function defaultOwleryStore(): OwleryStore {
  return new DbOwleryStore(async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
  })
}

/** In-memory store for tests. */
export class InMemoryOwleryStore implements OwleryStore {
  row: OwleryRow | null = null
  writes = 0
  async read() {
    return this.row
  }
  async write(row: OwleryRow) {
    this.row = { ...row }
    this.writes += 1
  }
  async clear() {
    this.row = null
  }
}
