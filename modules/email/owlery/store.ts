import { createHash } from 'node:crypto'
import type { DbHandle } from '$lib/kernel/db-stores'
import { decryptEnvelope, encryptEnvelope } from '$lib/server/crypto/envelope'
import type { AppDatabase } from '$lib/server/db/context'
import { owlerySettings, type EventsStatus } from '$lib/server/db/owlery.schema'

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

/** Delivery-event wiring (SES configuration sets → SNS topic → our callback). */
export type OwleryEvents = {
  eventsStatus: EventsStatus
  eventsError: string | null
  eventsTopicArn: string | null
  eventsCallbackUrl: string | null
  configSet: string | null
  trackingConfigSet: string | null
}

export const NO_EVENTS: OwleryEvents = {
  eventsStatus: 'not_set_up',
  eventsError: null,
  eventsTopicArn: null,
  eventsCallbackUrl: null,
  configSet: null,
  trackingConfigSet: null,
}

export type OwleryStore = {
  read(): Promise<(OwleryRow & OwleryEvents) | null>
  /** Upserts the credentials + default sender; leaves the event wiring as it is. */
  write(row: OwleryRow): Promise<void>
  writeEvents(patch: Partial<OwleryEvents>): Promise<void>
  /** Changes only the default sender. */
  writeEmailFrom(emailFrom: string, updatedBy: string): Promise<void>
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

  async read(): Promise<(OwleryRow & OwleryEvents) | null> {
    const [row] = await (await resolveDb(this.db)).select().from(owlerySettings).limit(1)
    if (!row) return null
    return {
      region: row.region,
      accessKeyId: row.accessKeyId,
      sealedSecretAccessKey: row.sealedSecretAccessKey,
      emailFrom: row.emailFrom,
      updatedBy: row.updatedBy,
      eventsStatus: row.eventsStatus,
      eventsError: row.eventsError,
      eventsTopicArn: row.eventsTopicArn,
      eventsCallbackUrl: row.eventsCallbackUrl,
      configSet: row.configSet,
      trackingConfigSet: row.trackingConfigSet,
    }
  }

  async writeEvents(patch: Partial<OwleryEvents>): Promise<void> {
    await (await resolveDb(this.db)).update(owlerySettings).set(patch)
  }

  async writeEmailFrom(emailFrom: string, updatedBy: string): Promise<void> {
    await (await resolveDb(this.db)).update(owlerySettings).set({ emailFrom, updatedBy, updatedAt: new Date() })
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
  row: (OwleryRow & OwleryEvents) | null = null
  writes = 0
  async read() {
    return this.row
  }
  async write(row: OwleryRow) {
    this.row = { ...NO_EVENTS, ...this.row, ...row }
    this.writes += 1
  }
  async writeEvents(patch: Partial<OwleryEvents>) {
    if (this.row) this.row = { ...this.row, ...patch }
  }
  async writeEmailFrom(emailFrom: string, updatedBy: string) {
    if (this.row) this.row = { ...this.row, emailFrom, updatedBy }
  }
  async clear() {
    this.row = null
  }
}
