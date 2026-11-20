import type { BlobStore } from './storage'
import type { DriveStore } from './store'

/**
 * Drive's blob garbage collection. Writers never delete bytes inline (a
 * rolled-back batch or a concurrent writer may still be about to reference
 * them); the sweep removes what no file or revision references once it has
 * gone untouched for the grace period. A put of stored bytes refreshes the
 * blob's time (storage.ts), so an open writer is always inside the window.
 */

/** One hour: far longer than any Drive write takes between putting bytes and committing the row. */
export const BLOB_GC_GRACE_MS = 60 * 60 * 1000

/** How many hashes one reference lookup checks. */
const LOOKUP_CHUNK = 5_000

export async function sweepUnreferencedBlobs(deps: { store: Pick<DriveStore, 'usedBlobShas'>; blobs: BlobStore }, olderThan: Date): Promise<{ removed: number }> {
  if (olderThan.getTime() > Date.now() - BLOB_GC_GRACE_MS) {
    throw new Error(`drive blob sweep cut-off ${olderThan.toISOString()} is inside the ${BLOB_GC_GRACE_MS / 60_000}-minute grace period`)
  }
  const candidates = (await deps.blobs.list()).filter((b) => b.modifiedAt.getTime() < olderThan.getTime()).map((b) => b.sha256)
  let removed = 0
  for (let i = 0; i < candidates.length; i += LOOKUP_CHUNK) {
    const chunk = candidates.slice(i, i + LOOKUP_CHUNK)
    const used = new Set(await deps.store.usedBlobShas(chunk))
    for (const sha of chunk) if (!used.has(sha) && (await deps.blobs.removeIfOlderThan(sha, olderThan))) removed += 1
  }
  return { removed }
}
