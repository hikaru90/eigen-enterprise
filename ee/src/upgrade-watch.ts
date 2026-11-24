import { PATHS } from './paths.ts'
import type { System } from './system.ts'

/**
 * The watch after the cut-over (plan/phase-upgrades.md §6.4 step 5): for a while after the new
 * release took traffic, ee samples what only the core's own health can show, and a failure rolls
 * the core back to the release before (step 6). It watches:
 *
 *   crash loops   the os unit now live and ee.service: not active, or restarted again and again
 *   edge 5xx      the share of the edge's answers from the app that are a 5xx (Caddy's metrics)
 *   job queue     jobs overdue while none started since the cut-over (the in-app ticker stopped)
 *
 * Modules never decide it (§3): their check runs after the cut-over and only reports.
 */

export type WatchLimits = {
  /** How long the watch runs after the cut-over (30 minutes on a box; tests pass less). */
  durationMs: number
  intervalMs: number
  /** Restarts of a watched unit since the cut-over that count as a crash loop. */
  crashRestarts: number
  /** The edge is judged only once it answered this many app requests since the cut-over. */
  edgeMinRequests: number
  /** More than this share of 5xx answers fails the watch. */
  edgeMax5xxRatio: number
  /** Overdue jobs with none started fail the watch only once the new release ran this long. */
  queueStallMs: number
}

export const DEFAULT_WATCH: WatchLimits = {
  durationMs: 30 * 60_000,
  intervalMs: 15_000,
  crashRestarts: 3,
  edgeMinRequests: 20,
  edgeMax5xxRatio: 0.1,
  queueStallMs: 10 * 60_000,
}

export type UnitSample = { active: string; restarts: number }

export type WatchSample = {
  units: Record<string, UnitSample>
  /** Caddy's running totals for the app's answers on the public server (they reset when Caddy restarts). */
  edge: { total: number; errors: number }
  /** Jobs due for more than 10 minutes and still pending; jobs started since the cut-over. */
  queue: { overdue: number; startedSince: number }
}

export type WatchProbe = { sample(cutoverAt: string): Promise<WatchSample> }

/** Why the watch fails at this sample, or null while the new release looks healthy. */
export function judge(base: WatchSample, now: WatchSample, elapsedMs: number, limits: WatchLimits): string | null {
  for (const [unit, b] of Object.entries(base.units)) {
    const n = now.units[unit]
    if (!n) return `${unit} is gone`
    if (n.active !== 'active') return `${unit} is ${n.active || 'not running'} since the cut-over`
    // NRestarts counts from the unit's start: fewer than at the cut-over means it was started anew.
    const restarts = n.restarts >= b.restarts ? n.restarts - b.restarts : n.restarts
    if (restarts >= limits.crashRestarts) return `${unit} crash-looped (${restarts} restarts since the cut-over)`
  }
  // Caddy's counters reset when Caddy restarts: then the whole new total is since the cut-over.
  const reset = now.edge.total < base.edge.total
  const total = reset ? now.edge.total : now.edge.total - base.edge.total
  const errors = reset ? now.edge.errors : now.edge.errors - base.edge.errors
  if (total >= limits.edgeMinRequests && errors / total > limits.edgeMax5xxRatio) {
    return `the edge answered ${errors} of ${total} app requests with a 5xx since the cut-over (${Math.round((errors / total) * 100)}%)`
  }
  if (elapsedMs >= limits.queueStallMs && now.queue.overdue > 0 && now.queue.startedSince === 0) {
    return `the job queue stalled: ${now.queue.overdue} job(s) overdue and none started since the cut-over`
  }
  return null
}

/** Run the watch; resolves with why it failed, or null when the new release held for the whole window. */
export async function watch(
  probe: WatchProbe,
  limits: WatchLimits,
  clock: { now(): Date; sleep(ms: number): Promise<void> },
  onSample?: (elapsedMs: number) => Promise<void>,
): Promise<string | null> {
  const cutoverAt = clock.now()
  const at = cutoverAt.toISOString()
  const sample = async () => {
    try {
      return await probe.sample(at)
    } catch (err) {
      throw new WatchProbeError(`could not watch the new release: ${(err as Error).message}`)
    }
  }
  try {
    const base = await sample()
    for (;;) {
      const elapsed = clock.now().getTime() - cutoverAt.getTime()
      if (elapsed >= limits.durationMs) return null
      await clock.sleep(Math.min(limits.intervalMs, limits.durationMs - elapsed))
      const s = await sample()
      const why = judge(base, s, clock.now().getTime() - cutoverAt.getTime(), limits)
      if (why) return why
      await onSample?.(clock.now().getTime() - cutoverAt.getTime())
    }
  } catch (err) {
    // A watch that cannot see the new release cannot vouch for it.
    if (err instanceof WatchProbeError) return err.message
    throw err
  }
}

class WatchProbeError extends Error {}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+([0-9.eE+-]+)$/
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g

/**
 * The app's answers on the public server from Caddy's Prometheus metrics: every
 * reverse_proxy request on server "ee", and the ones answered with a 5xx.
 */
export function edgeCounts(metrics: string): { total: number; errors: number } {
  let total = 0
  let errors = 0
  for (const line of metrics.split('\n')) {
    const m = LINE.exec(line.trim())
    if (!m || m[1] !== 'caddy_http_request_duration_seconds_count') continue
    const labels = Object.fromEntries([...m[2]!.matchAll(LABEL)].map((l) => [l[1], l[2]]))
    if (labels['server'] !== 'ee' || labels['handler'] !== 'reverse_proxy') continue
    const n = Number(m[3])
    if (!Number.isFinite(n)) throw new Error(`Caddy's metrics have an unreadable count: ${line.slice(0, 120)}`)
    total += n
    if (/^5\d\d$/.test(labels['code'] ?? '')) errors += n
  }
  return { total, errors }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

/** The watch's probes on a real box. */
export function boxWatchProbe(sys: Pick<System, 'run'>): WatchProbe {
  const show = async (unit: string): Promise<UnitSample> => {
    const active = (await sys.run('systemctl', ['is-active', unit])).stdout.trim()
    const restarts = Number((await sys.run('systemctl', ['show', '-p', 'NRestarts', '--value', unit])).stdout.trim()) || 0
    return { active, restarts }
  }
  let osUnit: string | null = null
  return {
    async sample(cutoverAt) {
      if (!ISO.test(cutoverAt)) throw new Error(`not a timestamp: ${cutoverAt}`)
      if (!osUnit) {
        // The slot the cut-over made live: the other one was retired right after it.
        const live: string[] = []
        for (const u of ['ee-os-a.service', 'ee-os-b.service']) if ((await show(u)).active === 'active') live.push(u)
        if (live.length !== 1) throw new Error(`expected one live os slot after the cut-over, found ${live.length}`)
        osUnit = live[0]!
      }
      const metrics = await sys.run('curl', ['-fsS', '--max-time', '10', '--unix-socket', PATHS.caddyAdminSocket, 'http://localhost/metrics'])
      if (metrics.code !== 0) throw new Error(`Caddy's metrics: ${metrics.stderr.trim() || `curl exit ${metrics.code}`}`)
      const sql =
        `SELECT count(*) FILTER (WHERE status = 'pending' AND run_after < now() - interval '10 minutes'), ` +
        `count(*) FILTER (WHERE started_at >= '${cutoverAt}'::timestamptz) FROM user_job_queue`
      const q = await sys.run('runuser', ['-u', 'postgres', '--', 'psql', '-d', 'os', '-tAq', '-v', 'ON_ERROR_STOP=1', '-F', ' ', '-c', sql])
      if (q.code !== 0) throw new Error(`the job queue: ${q.stderr.trim()}`)
      const [overdue, startedSince] = q.stdout.trim().split(/\s+/).map(Number)
      if (!Number.isFinite(overdue) || !Number.isFinite(startedSince)) throw new Error(`the job queue: unreadable answer "${q.stdout.trim().slice(0, 80)}"`)
      return {
        units: { [osUnit]: await show(osUnit), 'ee.service': await show('ee.service') },
        edge: edgeCounts(metrics.stdout),
        queue: { overdue: overdue!, startedSince: startedSince! },
      }
    },
  }
}
