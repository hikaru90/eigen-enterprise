import { hkdfSync } from 'node:crypto'
import { liveDriveAccess } from './access-port'
import { BLOB_GC_GRACE_MS, sweepUnreferencedBlobs } from './blob-gc'
import { dbDriveStore, dbEditLockStore } from './db-store'
import { createDriveService, resolveMaxUploadBytes, type DriveService } from './service'
import { createDriveSourceWriter, type DriveSourceWriter } from './source-writer'
import { diskBlobStore, resolveDriveStorageDir } from './storage'

export * from './service'
export type { DriveSourceId, DriveSourceItem, DriveSourceRoot, DriveSourceWriter } from './source-writer'
export { LOCK_HEARTBEAT_MS, LOCK_TTL_MS } from './locks'
export { mintViewToken, readViewToken, VIEW_TOKEN_TTL_MS, type ViewScope } from './view-token'
export { viewMimeFor } from './preview'
export { BLOB_GC_GRACE_MS } from './blob-gc'

let live: DriveService | null = null

/**
 * The live Drive: Postgres metadata, blobs under DRIVE_STORAGE_DIR (else
 * $EE_STATE_DIR/drive — fails loud when neither is set), the access port.
 */
export async function driveService(env: Record<string, string | undefined> = process.env): Promise<DriveService> {
  if (live) return live
  live = createDriveService({
    store: dbDriveStore,
    blobs: diskBlobStore(resolveDriveStorageDir(env)),
    access: await liveDriveAccess(),
    maxUploadBytes: resolveMaxUploadBytes(env),
    locks: dbEditLockStore,
    onContentSaved: async (file) => {
      const { reindexMemoryDocument } = await import('$lib/server/text-files/service')
      await reindexMemoryDocument(file.id, file.ownerId)
    },
  })
  return live
}

let liveWriter: DriveSourceWriter | null = null

/**
 * The live system writer for read-only source folders (same store, blobs and
 * access as the live Drive). Never a tool: the composition root hands it to
 * a source plugin as its DriveSourcePort.
 */
export async function driveSourceWriter(env: Record<string, string | undefined> = process.env): Promise<DriveSourceWriter> {
  if (liveWriter) return liveWriter
  liveWriter = createDriveSourceWriter({ store: dbDriveStore, blobs: diskBlobStore(resolveDriveStorageDir(env)), access: await liveDriveAccess() })
  return liveWriter
}

/**
 * Removes Drive blobs nothing references that have gone untouched for the
 * grace period (blob-gc.ts). Writers never delete bytes inline, so this must
 * run periodically; nothing schedules it yet.
 */
export async function sweepDriveBlobs(env: Record<string, string | undefined> = process.env, now: Date = new Date()): Promise<{ removed: number }> {
  return sweepUnreferencedBlobs({ store: dbDriveStore, blobs: diskBlobStore(resolveDriveStorageDir(env)) }, new Date(now.getTime() - BLOB_GC_GRACE_MS))
}

/**
 * The key that signs rendered-HTML view tokens (./view-token.ts): derived
 * from TENANT_MASTER_KEY, so both blue-green slots accept each other's
 * tokens. Fails loud without it.
 */
export function driveViewSecret(env: Record<string, string | undefined> = process.env): Buffer {
  const master = env.TENANT_MASTER_KEY?.trim()
  if (!master) throw new Error('TENANT_MASTER_KEY is required to sign Drive view links')
  return Buffer.from(hkdfSync('sha256', Buffer.from(master, 'utf8'), Buffer.alloc(0), 'eigenEnterprise drive view token v1', 32))
}
