/**
 * Drive's unreferenced-blob sweep on the global job-queue tick
 * (plan/github-drive-full-mirror.md §5). Writers no longer delete blobs
 * inline (that raced concurrent writers); this sweep removes bytes no file
 * or revision references once they are past the grace period. Once an hour
 * is plenty: unreferenced bytes only cost disk until then.
 */

export const DRIVE_BLOB_SWEEP_EVERY_MS = 60 * 60_000

type Deps = {
  sweep: () => Promise<{ removed: number }>
  now: () => Date
  log: (message: string, fields: Record<string, unknown>) => void
}

export function createDriveBlobsTick(deps: Deps): () => Promise<void> {
  let lastRun: number | null = null
  return async () => {
    const at = deps.now().getTime()
    if (lastRun !== null && at - lastRun < DRIVE_BLOB_SWEEP_EVERY_MS) return
    lastRun = at
    try {
      const { removed } = await deps.sweep()
      if (removed > 0) deps.log('[drive] blob sweep removed unreferenced blobs', { removed })
    } catch (err) {
      deps.log('[drive] blob sweep failed', { message: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** This process's sweep (Drive's live store and blobs, resolved on first run). */
export const tickDriveBlobs = createDriveBlobsTick({
  sweep: async () => {
    const { sweepDriveBlobs } = await import('../../../../modules/drive')
    return sweepDriveBlobs()
  },
  now: () => new Date(),
  log: (message, fields) => console.error(message, fields),
})
