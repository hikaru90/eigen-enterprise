import { liveDriveAccess } from './access-port'
import { dbDriveStore, dbEditLockStore } from './db-store'
import { createDriveService, resolveMaxUploadBytes, type DriveService } from './service'
import { diskBlobStore, resolveDriveStorageDir } from './storage'

export * from './service'
export { LOCK_HEARTBEAT_MS, LOCK_TTL_MS } from './locks'

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
  })
  return live
}
