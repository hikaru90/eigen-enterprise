import { raceWithTimeout } from '$lib/server/async/race-with-timeout'
import { pluginOn } from '$lib/server/plugins/background'
import { drainUserJobQueue } from './drain'
import { tickEmailPlatform } from './email-tick'
import { ensureOvernightJobsEnqueued } from './ensure-overnight'
import { recoverStaleRunningJobs } from './recover-stale-running'
import { tickRepos } from './repos-tick'
import { loadJobQueueSnapshot } from './snapshot'

export type TickGlobalJobQueueResult = {
  enqueued: number
  drain: Awaited<ReturnType<typeof drainUserJobQueue>>
}

/** Abort a stuck tick so the in-process guard cannot block the loop for hours. */
export const JOB_QUEUE_TICK_TIMEOUT_MS = 5 * 60 * 1000

let ticking = false
let tickCount = 0

/** Log queue depth every N ticks even when idle (default 15 min at 60s interval). */
const HEARTBEAT_EVERY_TICKS = 15

async function runTickBody(): Promise<TickGlobalJobQueueResult> {
  tickCount += 1
  const recoveredStale = await recoverStaleRunningJobs()
  if (recoveredStale > 0) {
    console.info('[job-queue] recovered stale running jobs', { recoveredStale })
  }
  // Plugin work runs only while its plugin is switched on (owner, 2026-11-12).
  // The drain stays: it runs what is already queued (agent webhooks, onboarding).
  const enqueued = (await pluginOn('memory', 'overnight consolidation')) ? await ensureOvernightJobsEnqueued() : 0
  const drain = await drainUserJobQueue()
  if (await pluginOn('email', 'email background work (DNS checks, scheduled sends, flows)')) await tickEmailPlatform()
  if (await pluginOn('repos', 'GitHub repo sync')) await tickRepos()
  const hasActivity = enqueued > 0 || drain.claimed > 0 || recoveredStale > 0
  const shouldHeartbeat = tickCount % HEARTBEAT_EVERY_TICKS === 0
  const shouldInspectBacklog = hasActivity || shouldHeartbeat || drain.claimed === 0

  if (shouldInspectBacklog) {
    const snapshot = await loadJobQueueSnapshot()
    if (hasActivity) {
      console.info('[job-queue] tick', { enqueued, ...drain, queue: snapshot })
    } else if (shouldHeartbeat) {
      console.info('[job-queue] heartbeat', { tickCount, queue: snapshot })
    }

    if (snapshot.pendingDue > 0 && drain.claimed === 0) {
      console.warn('[job-queue] due jobs waiting but none claimed', {
        pendingDue: snapshot.pendingDue,
        oldestDuePendingAgeSec: snapshot.oldestDuePendingAgeSec,
        running: snapshot.running,
      })
    }
  }

  return { enqueued, drain }
}

/** Global queue tick: enqueue due overnight jobs, then drain pending work for all users. */
export async function tickGlobalJobQueue(
  timeoutMs: number = JOB_QUEUE_TICK_TIMEOUT_MS,
): Promise<TickGlobalJobQueueResult> {
  if (ticking) {
    console.warn('[job-queue] tick skipped — previous tick still running')
    return { enqueued: 0, drain: { claimed: 0, completed: 0, failed: 0 } }
  }

  ticking = true
  try {
    return await raceWithTimeout('job-queue tick', runTickBody, timeoutMs)
  } finally {
    ticking = false
  }
}
