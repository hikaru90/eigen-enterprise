import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { dev } from '$app/environment'

/**
 * Dev/e2e only: run one traces export pass now — the pass the global job-queue tick runs
 * (plan/traces-phone-home.md §3) — on a clock `ahead_ms` in the future, so the journey does not
 * wait out the settle time (SETTLE_MS) or the build interval (BUILD_EVERY_MS). Passes run one at a
 * time in the process (live.ts).
 *
 *   POST { ahead_ms } → { result } the pass's TraceTickResult (null on a hub install)
 */
export const POST: RequestHandler = async ({ request }) => {
  if (!dev) return json({ error: 'Traces harness API only available in dev mode' }, { status: 403 })
  const body = (await request.json().catch(() => null)) as { ahead_ms?: unknown } | null
  const ahead = body?.ahead_ms
  if (typeof ahead !== 'number' || !Number.isInteger(ahead) || ahead < 0 || ahead > 24 * 60 * 60_000) {
    return json({ error: 'ahead_ms: an integer number of milliseconds, 0 to one day' }, { status: 400 })
  }
  const { tracesTick } = await import('$lib/server/traces/live')
  return json({ result: await tracesTick(() => new Date(Date.now() + ahead)) })
}
