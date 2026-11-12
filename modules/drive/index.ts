import { liveDriveAccess } from './access-port'
import { dbDriveStore, dbEditLockStore } from './db-store'
import { createDriveService, resolveMaxUploadBytes, type DriveService } from './service'
import { createDriveSourceWriter, type DriveSourceWriter } from './source-writer'
import { diskBlobStore, resolveDriveStorageDir } from './storage'

export * from './service'
export type { DriveSourceId, DriveSourceItem, DriveSourceRoot, DriveSourceWriter } from './source-writer'
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
