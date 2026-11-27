import { z } from 'zod'
import { fleetAuthorized } from './seats'

/**
 * One row of the company's eigenInference usage as ee reports it to the control plane (fleet
 * feature `aiUsage`, ee/src/fleet/protocol.ts aiUsageDayV1): one UTC day, one task, one model.
 * `costUsd` is the provider-reported cost (activity_call_log.base_cost_usd), before any markup.
 */
export type FleetAiUsageDay = {
  day: string
  task: string | null
  model: string | null
  calls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  costUsd: number
}

const fromSchema = z.iso.date()

/**
 * The eigenInference usage for the hosting's ops dashboard and invoice (feature `aiUsage`): ee
 * asks os on loopback with EE_FLEET_LOCAL_TOKEN for every day from `?from=YYYY-MM-DD` (UTC)
 * through today and sends the rows up in report.aiUsage. Only amounts, never a call's content.
 */
export function aiUsageHandler(deps: {
  token: string | undefined
  /** Today's UTC date, YYYY-MM-DD. */
  today: () => string
  read: (from: string) => Promise<FleetAiUsageDay[]>
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const denied = fleetAuthorized(deps.token, request)
    if (denied) return denied
    const raw = new URL(request.url).searchParams.get('from') ?? ''
    if (!fromSchema.safeParse(raw).success) return new Response('from must be a UTC date (YYYY-MM-DD)', { status: 400 })
    if (raw > deps.today()) return new Response(`from (${raw}) is after today (${deps.today()})`, { status: 400 })
    return Response.json({ rows: await deps.read(raw) })
  }
}
