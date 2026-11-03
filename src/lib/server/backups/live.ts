import { eq } from 'drizzle-orm'
import { building } from '$app/environment'
import { moduleSource } from '$lib/kernel/cloudevents'
import { emitKernelEvent } from '$lib/kernel/events'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { kernelEvents } from '$lib/server/db/kernel.schema'
import { EeClient, SubstrateUnavailableError } from '$lib/server/ee/client'
import { sendPushToUser } from '$lib/server/push/send'
import { tickBackupHealth, type BackupHealthDeps } from './health'

/** Production wiring of the backup health tick (ee over its socket, kernel_events, web push). */
export function liveBackupHealthDeps(client = new EeClient()): BackupHealthDeps {
  return {
    status: async () => {
      try {
        return await client.backups()
      } catch (err) {
        if (err instanceof SubstrateUnavailableError) return null
        throw err
      }
    },
    hasEvent: async (id) =>
      (await getDb().select({ id: kernelEvents.id }).from(kernelEvents).where(eq(kernelEvents.id, id)).limit(1)).length > 0,
    emit: async (e) => {
      const { appKernel } = await import('$lib/server/boot')
      const kernel = await appKernel()
      await emitKernelEvent(kernel.eventSink, { id: e.id, type: e.type, source: moduleSource('backups'), payload: e.payload })
    },
    ownerId: async () => {
      const [row] = await authDb.select({ id: user.id }).from(user).where(eq(user.role, 'owner')).limit(1)
      return row?.id ?? null
    },
    push: async (userId, p) => {
      const r = await sendPushToUser(userId, p)
      if (r.sent === 0) throw new Error(`push not delivered: ${r.errors.join('; ') || 'no live subscription'}`)
    },
  }
}

/** How often the app looks at ee's backup health (a missing night is a 26h condition: minutes are plenty). */
export const BACKUP_HEALTH_TICK_MS = 10 * 60_000

let started = false

export function startBackupHealthTicker(): void {
  if (started || building) return
  started = true
  const deps = liveBackupHealthDeps()
  const run = () => {
    void tickBackupHealth(deps).catch((err) => {
      console.error('[backup-health] tick failed', { message: err instanceof Error ? err.message : String(err) })
    })
  }
  run()
  const timer = setInterval(run, BACKUP_HEALTH_TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()
}
